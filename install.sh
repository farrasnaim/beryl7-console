#!/bin/sh
# Beryl 7 Console installer.
#
# Run it from a machine that can reach the router over SSH:
#
#     ./install.sh                    # installs to 192.168.1.1 (OpenWrt default)
#     ./install.sh 192.168.8.1        # ...or wherever your router actually is
#     ROUTER=router.lan ./install.sh  # same thing via the environment
#
# It is safe to re-run: every step is idempotent and preserves the device
# names you have set in /etc/dashboard/classmap.
#
# Deliberately uses `tar | ssh` rather than scp: OpenWrt's dropbear ships
# without an sftp server, so `scp` fails on a stock install while this works
# everywhere.

set -e

ROUTER=${1:-${ROUTER:-192.168.1.1}}
SSH_USER=${SSH_USER:-root}
TARGET="$SSH_USER@$ROUTER"
SRC=$(dirname "$0")

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
ok()   { printf '  . %s\n' "$*"; }

say "Beryl 7 Console -> $TARGET"

# ---------------------------------------------------------------- pre-flight --
command -v ssh >/dev/null 2>&1 || { echo "ssh not found in PATH"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar not found in PATH"; exit 1; }
[ -f "$SRC/www/os.css" ] || { echo "run this from the repository root"; exit 1; }

# -n on every ssh that is not being fed a pipe, so ssh cannot consume the
# script's own stdin.
say "Checking the router"
BOARD=$(ssh -n -o ConnectTimeout=10 "$TARGET" \
    'ubus call system board 2>/dev/null | sed -n "s/.*\"model\": \"\([^\"]*\)\".*/\1/p" | head -n1') || {
    echo "cannot reach $TARGET over SSH."
    echo "check the address, and that your key is installed (ssh-copy-id $TARGET)."
    exit 1
}
ok "model: ${BOARD:-unknown}"
ok "OpenWrt: $(ssh -n "$TARGET" '. /etc/openwrt_release 2>/dev/null; echo "${DISTRIB_RELEASE:-unknown}"')"

MISSING=$(ssh -n "$TARGET" 'for c in uci ubus iw nft; do command -v $c >/dev/null 2>&1 || echo $c; done')
[ -z "$MISSING" ] || warn "missing commands on the router: $MISSING"

# Optional packages: report, never fail. OpenWrt moved from opkg to apk, so ask
# whichever one this build actually has.
#
# This list must stay identical to the README's dependency table (the USB
# kmods excepted — the README marks those per-hardware "as needed", and warning
# about them on every install would be noise). The table once named a
# statistics package that had been removed from the router, while the Traffic
# panel has always read nlbwmon — so a reader following the README installed the
# wrong thing and still got an empty panel. Then the check itself drifted: it
# omitted kmod-wireguard and https-dns-proxy, the two whose absence fails
# SILENTLY (tunnels that never come up; a travel-DNS hotplug that no-ops).
# Each of these degrades honestly when absent; the warning exists to say so
# before you go looking for the reason.
for pkg in pbr wireguard-tools kmod-wireguard nlbwmon https-dns-proxy; do
    ssh -n "$TARGET" "if command -v apk >/dev/null 2>&1; then apk info -e '$pkg' >/dev/null 2>&1;
                      else opkg list-installed 2>/dev/null | grep -q \"^$pkg \"; fi" \
        || warn "not installed: $pkg — the matching page will be limited (see the README)"
done

# ARMED BEFORE THE FIRST WRITE, not before the last one.
#
# `set -e` at the top already stops this script when the remote install block
# aborts - ssh returns the remote status and the trap on that is to die. That is
# correct, but the ONLY signal it gives is that "Done" never prints, and asking a
# reader to notice an absence is how the previous failure went unnoticed for
# every run over two days. This says it out loud instead. It also owns the
# manifest temp files, so there is exactly one EXIT trap in this script rather
# than two that could overwrite each other.
MF_LOCAL=""; MF_REMOTE=""
bail() {
    _rc=$?
    [ -n "$MF_LOCAL" ] && rm -f "$MF_LOCAL"
    [ -n "$MF_REMOTE" ] && rm -f "$MF_REMOTE"
    if [ "$_rc" != 0 ]; then
        echo
        echo "  INSTALL FAILED at the step above (exit $_rc) - nothing after it ran."
        echo "  The console may be half-installed: whatever the step above reported"
        echo "  is the cause. Fix it and re-run this script; it is safe to repeat."
    fi
}
trap bail EXIT

# ------------------------------------------------------------------- upload --
say "Uploading"
ssh -n "$TARGET" 'rm -rf /tmp/beryl7 && mkdir -p /tmp/beryl7'
tar -C "$SRC" -cf - www usr etc | ssh "$TARGET" 'tar -xf - -C /tmp/beryl7'

# PROVE THE UPLOAD IS COMPLETE BEFORE INSTALLING FROM IT.
#
# The install below is glob-driven, which is what makes the copy and the chmod
# impossible to disagree - but a glob over a short staging directory installs
# fewer files and says nothing, where the old hand-written list would at least
# have failed on the missing name. This is the check that buys that back, and
# it is stricter than the list ever was: it compares the WHOLE tree, so a
# truncated tar, a full /tmp, or a file that never left the repo all stop the
# run here, before anything on the router has been touched.
# Plain temp files rather than `diff <(...)`: this script is #!/bin/sh and
# process substitution is a bashism, so it would work on the machine it was
# written on and fail on a POSIX sh.
MF_LOCAL=$(mktemp); MF_REMOTE=$(mktemp)
(cd "$SRC" && find www usr etc -type f | sort) > "$MF_LOCAL"
ssh -n "$TARGET" 'cd /tmp/beryl7 && find www usr etc -type f | sort' > "$MF_REMOTE"
if ! cmp -s "$MF_LOCAL" "$MF_REMOTE"; then
    echo
    echo "  STAGING IS INCOMPLETE - nothing has been installed."
    echo "  The file list on the router does not match the repo:"
    echo "    only in the repo:"
    comm -23 "$MF_LOCAL" "$MF_REMOTE" | sed 's/^/      /'
    echo "    only on the router:"
    comm -13 "$MF_LOCAL" "$MF_REMOTE" | sed 's/^/      /'
    echo "  Check free space in /tmp on the router, then re-run."
    exit 1
fi
ok "staged in /tmp/beryl7 ($(wc -l < "$MF_LOCAL" | tr -d ' ') files, manifest verified)"
rm -f "$MF_LOCAL" "$MF_REMOTE"; MF_LOCAL=""; MF_REMOTE=""

# ------------------------------------------------------------------ install --
say "Installing"
ssh -n "$TARGET" 'set -e
S=/tmp/beryl7

# INSTALL A FILE AND SET ITS MODE IN THE SAME STATEMENT.
#
# There used to be a copy list and, forty lines below it, a hand-maintained
# chmod list naming final paths. They drifted: the chmod named three programs
# the copy list had never created, and because the block runs under `set -e` and
# busybox chmod exits 1 when any operand is missing, EVERY install since those
# programs existed aborted right there. What the abort skipped was the quiet
# half - the classmap seed, the cron entries, every service enable, and the
# whole /etc/sysupgrade.conf population loop, which is what makes a file survive
# a firmware upgrade AND what backup.sh reads to decide what to save.
#
# The two lists cannot drift now because there is only one: the mode is applied
# to the file this call just wrote, named from the source argument. A program
# added to the repo under usr/sbin, etc/init.d or etc/hotplug.d is installed and
# made executable with no list to update anywhere.
inst_x() { cp "$1" "$2/" && chmod 755 "$2/${1##*/}"; }
inst_r() { cp "$1" "$2/" && chmod 644 "$2/${1##*/}"; }

# Web pages and CGI. The console never replaces LuCI: it installs alongside it
# and LuCI stays reachable at /cgi-bin/luci/.
mkdir -p /www/cgi-bin
for f in $S/www/os.css $S/www/os.js $S/www/theme.css; do inst_r "$f" /www; done
cp -r $S/www/dashboard $S/www/vpn $S/www/repeater $S/www/tethering $S/www/settings /www/
cp -r $S/www/legacy /www/
for f in $S/www/cgi-bin/*-api; do inst_x "$f" /www/cgi-bin; done

# The helpers every CGI sources. Outside /www on purpose: uhttpd would serve
# anything under /www/cgi-bin as an endpoint of its own. Copied BEFORE the pages
# above would matter, but ordering here is cosmetic — nothing runs until a
# request arrives.
mkdir -p /usr/share/beryl
inst_r $S/usr/share/beryl/cgi-lib.sh /usr/share/beryl

# Helper daemons and the nftables generator.
for f in $S/usr/sbin/*; do inst_x "$f" /usr/sbin; done

# Hotplug automation and system tunables.
mkdir -p /etc/hotplug.d/iface /etc/hotplug.d/net /etc/hotplug.d/usb /etc/sysctl.d
for f in $S/etc/hotplug.d/iface/*; do inst_x "$f" /etc/hotplug.d/iface; done
for f in $S/etc/hotplug.d/net/*;   do inst_x "$f" /etc/hotplug.d/net;   done
for f in $S/etc/hotplug.d/usb/*;   do inst_x "$f" /etc/hotplug.d/usb;   done
for f in $S/etc/init.d/*;          do inst_x "$f" /etc/init.d;          done
inst_r $S/etc/sysctl.d/99-local.conf /etc/sysctl.d

# Nothing to chmod here any more: every executable above was installed through
# inst_x, which sets the mode on the file it just wrote. The mode still has to be
# set explicitly - cp does not carry the exec bit reliably across filesystems, a
# CGI that is not executable returns 403, and a hotplug script that is not
# executable is ignored in silence - but it is now impossible to set it on a file
# that was never installed, or to install one and forget.
echo "  . files installed"

# Device name/class map: seed it once, never overwrite an edited one.
mkdir -p /etc/dashboard
if [ ! -f /etc/dashboard/classmap ]; then
    cp $S/etc/dashboard/classmap.example /etc/dashboard/classmap
    echo "  . seeded /etc/dashboard/classmap (edit it to name your devices)"
else
    echo "  . kept your existing /etc/dashboard/classmap"
fi

# cron. dashmon feeds the Overview history panels; the two watchdogs are
# optional but harmless. Added only if absent, so re-running does not duplicate.
touch /etc/crontabs/root
for job in /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/notifymon; do
    grep -qF "$job" /etc/crontabs/root || echo "* * * * * $job" >> /etc/crontabs/root
done
/etc/init.d/cron enable >/dev/null 2>&1 || true
/etc/init.d/cron restart >/dev/null 2>&1 || true
echo "  . cron entries present"

# The one always-running piece: a 1-second probe whose 5-minute ring is what
# makes the Overview ping / loss / jitter history survive the dashboard being
# closed. procd rather than cron, because cron floors at a minute and a
# five-minute chart needs seconds. See the header of /usr/sbin/pingmon.
/etc/init.d/pingmon enable  >/dev/null 2>&1 || true
/etc/init.d/wifiwatch enable  >/dev/null 2>&1 || true
/etc/init.d/wifiwatch restart >/dev/null 2>&1 || true
/etc/init.d/pingmon restart >/dev/null 2>&1 || true
echo "  . pingmon running"

# Recomputes the VPN nftables rules at boot, BEFORE fw4 loads them: S18 against
# S19 for the firewall. Without it the last generated file — including a
# degraded one — is what comes back after every reboot. It owns no process, so
# there is nothing to start here beyond registering the boot link.
#
# NOTE: no apostrophes anywhere in this block. It lives inside a single-quoted
# ssh argument, and one apostrophe ends the quote and breaks the installer.
/etc/init.d/beryl-vpndns enable >/dev/null 2>&1 || true
echo "  . vpn rules regenerate at boot"

# cpugovernor was copied and made executable but never enabled, so on a fresh
# install it sat there doing nothing: the governor tuning is silent either way,
# which is exactly why nobody noticed. Enabling it here is what makes a clean
# install work. Across a FIRMWARE UPGRADE none of these enables survive - the
# keep list preserves init scripts, not rc.d links - and the boot-time guard
# /etc/hotplug.d/iface/12-console-services re-registers whatever is missing.
/etc/init.d/cpugovernor enable  >/dev/null 2>&1 || true
/etc/init.d/cpugovernor restart >/dev/null 2>&1 || true
echo "  . cpugovernor running"

# Keep everything across a sysupgrade.
touch /etc/sysupgrade.conf
for p in /www/os.css /www/os.js /www/theme.css /www/legacy /www/dashboard /www/vpn \
         /www/repeater /www/tethering /www/settings \
         /www/cgi-bin/dashboard-api /www/cgi-bin/rate-api /www/cgi-bin/vpn-api \
         /www/cgi-bin/repeater-api /www/cgi-bin/tethering-api /www/cgi-bin/settings-api \
         /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/beryl-vpndns \
         /usr/sbin/notifymon \
         /usr/sbin/wifiwatch /etc/init.d/wifiwatch \
         /usr/sbin/beryl-pbrtbl /usr/share/beryl/cgi-lib.sh \
         /etc/dashboard /etc/crontabs/root \
         /etc/hotplug.d/iface/12-console-services \
         /etc/hotplug.d/iface/15-travel-dns /etc/hotplug.d/iface/31-tethering-clash \
         /etc/hotplug.d/iface/32-pbr-uplink \
         /etc/hotplug.d/iface/33-uplink-width \
         /etc/hotplug.d/iface/34-vpn-resume \
         /etc/hotplug.d/iface/35-nlbw-v6prefix \
         /etc/hotplug.d/iface/99-repeater-iot /etc/hotplug.d/net/30-tethering \
         /etc/hotplug.d/net/40-rrm-neighbors \
         /etc/hotplug.d/usb/40-usbmuxd /etc/init.d/cpugovernor /etc/sysctl.d/99-local.conf \
         /usr/sbin/pingmon /etc/init.d/pingmon /www/cgi-bin/probe-api \
         /www/cgi-bin/version-api \
         /etc/init.d/beryl-vpndns \
         /etc/nftables.d/30-beryl-vpndns.nft \
         /etc/adguardhome; do
    grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf
done
echo "  . sysupgrade.conf updated"'

# --------------------------------------------------------------------- check --
say "Verifying"
# Fetch from the address uhttpd is actually bound to, not 127.0.0.1. A router
# that narrows uhttpd to its LAN address — a reasonable thing to do, since it
# keeps the console off the WAN — has no listener on loopback at all, so every
# endpoint reported ERR on a console that was installed and working perfectly.
# A verification step that fails on a correct install is worse than none.
BASE=$(ssh -n "$TARGET" 'a=$(uci -q get uhttpd.main.listen_http 2>/dev/null | tr " " "\n" | grep -v "^\[" | head -n1)
    a=${a%:*}
    [ -n "$a" ] || a=$(uci -q get network.lan.ipaddr 2>/dev/null)
    [ -n "$a" ] || a=127.0.0.1
    echo "$a"')
for ep in dashboard-api rate-api vpn-api repeater-api tethering-api settings-api probe-api; do
    CODE=$(ssh -n "$TARGET" "uclient-fetch -q -O /dev/null http://$BASE/cgi-bin/$ep 2>&1 && echo 200 || echo ERR")
    printf '  %-14s %s\n' "$ep" "$CODE"
done

# ENDPOINTS ARE THE EASY HALF, AND THEY LIE ON A RE-INSTALL. cp over an existing
# file keeps the destination's mode, so on a router that already had a working
# console every endpoint answers 200 whether or not this run got as far as the
# quiet work. The three things below are exactly what an abort skips, and the
# preserve list is the one that caused real loss: notifymon sat in the crontab
# for a day while absent from /etc/sysupgrade.conf, so every backup taken in that
# window silently lacked the file. Checking it here is what would have said so.
say "Verifying the quiet half"
# The preserve check walks the STAGING TREE, not a list written here. Staging is
# the repo, so this asks the only question worth asking - "is every file this
# console ships going to survive a firmware upgrade, and therefore appear in a
# backup?" - and it keeps asking it correctly for files that do not exist yet.
# A hardcoded list here would be a fourth list to forget, which is the defect
# this whole change is about.
ssh -n "$TARGET" '
    rc=0
    for j in dashmon apwatch vpnwatch notifymon; do
        grep -qF "/usr/sbin/$j" /etc/crontabs/root || { echo "  ! cron entry missing: $j"; rc=1; }
    done
    for svc in pingmon cpugovernor beryl-vpndns wifiwatch; do
        [ -x "/etc/init.d/$svc" ] || continue
        ls /etc/rc.d/ 2>/dev/null | grep -q "^S[0-9]*$svc$" || { echo "  ! not enabled for boot: $svc"; rc=1; }
    done
    cd /tmp/beryl7 || exit 1
    find www usr etc -type f | while read -r rel; do
        # the two files that do not install under their own name
        case "$rel" in
            etc/dashboard/classmap.example) dst=/etc/dashboard/classmap ;;
            *)                              dst="/$rel" ;;
        esac
        # covered by its own entry, or by any ancestor directory entry
        hit=0; probe="$dst"
        while [ -n "$probe" ] && [ "$probe" != "/" ]; do
            if grep -qxF "$probe" /etc/sysupgrade.conf 2>/dev/null; then hit=1; break; fi
            probe="${probe%/*}"
        done
        [ "$hit" = 1 ] || echo "  ! NOT PRESERVED across sysupgrade, so NOT in backups: $dst"
    done > /tmp/beryl7-unpreserved
    if [ -s /tmp/beryl7-unpreserved ]; then cat /tmp/beryl7-unpreserved; rc=1; fi
    rm -f /tmp/beryl7-unpreserved
    [ "$rc" = 0 ] && echo "  . cron, boot links and the preserve list all check out"
    rm -rf /tmp/beryl7
    exit $rc'

trap - EXIT
say "Done"
echo "  open  http://$ROUTER/dashboard/"
echo "  LuCI is untouched at  http://$ROUTER/cgi-bin/luci/"
echo
echo "  Next: edit /etc/dashboard/classmap to give your devices names and icons."
echo
echo "  NOTE: the console has no login. Anyone who can reach $ROUTER over HTTP can"
echo "  read it AND change settings. That is intentional for a trusted home LAN —"
echo "  make sure your firewall keeps guest/IoT networks and the WAN away from it."
