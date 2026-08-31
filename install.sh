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

# NOTE: no apostrophes anywhere in this block, comments included. It lives
# inside a single-quoted ssh argument, and one apostrophe ends the quote and
# breaks the installer.

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
# to the file this call just wrote, named from the source argument. Anything
# added to the repo under www, usr/sbin, etc/init.d or etc/hotplug.d is
# installed, and made executable where that applies, with no list to update
# anywhere.
inst_x() { cp "$1" "$2/" && chmod 755 "$2/${1##*/}"; }
inst_r() { cp "$1" "$2/" && chmod 644 "$2/${1##*/}"; }

# Web pages and CGI. The console never replaces LuCI: it installs alongside it
# and LuCI stays reachable at /cgi-bin/luci/.
#
# ONE GLOB OVER www/ FOR BOTH HALVES. The comment above claims the install is
# glob-driven with no list to update anywhere, and that was true of usr/sbin,
# init.d, hotplug and cgi-bin but FALSE here: the pages were a fixed six-name
# `cp -r` and the three top-level assets were named one by one. A new page
# directory was therefore uploaded, was walked by the preserve check, and was
# never copied. Add its preserve entry as well and the entire run passed clean
# with the page absent from the router.
# cgi-bin is the one directory skipped, because its files are installed below at
# mode 755; a `cp -r` of the directory would carry whatever mode the staging tar
# happened to leave, and a CGI that is not executable returns 403.
mkdir -p /www/cgi-bin
for f in $S/www/*; do
    # `case` rather than `[ -d "$f" ] && continue`: a false test as the last
    # command of a loop body returns 1, and this whole block runs under `set -e`.
    if [ -d "$f" ]; then
        case "${f##*/}" in cgi-bin) continue ;; esac
        cp -r "$f" /www/
    else
        inst_r "$f" /www
    fi
done
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
#
# The jobs come from the repo copy of etc/crontabs/root, which is staged like
# any other file, so adding a scheduled program there is the whole change - the
# four names used to be spelled out here as well, a second place to forget.
# The grep matches on the PROGRAM rather than the whole line, deliberately: a
# schedule you have edited by hand still counts as present, where matching the
# whole line would quietly append the shipped copy beside yours.
touch /etc/crontabs/root
while read -r m h dom mon dow prog; do
    case "$m" in ""|\#*) continue ;; esac
    grep -qF "$prog" /etc/crontabs/root || echo "$m $h $dom $mon $dow $prog" >> /etc/crontabs/root
done < $S/etc/crontabs/root
/etc/init.d/cron enable >/dev/null 2>&1 || true
/etc/init.d/cron restart >/dev/null 2>&1 || true
echo "  . cron entries present"

# REGISTER EVERY INIT SCRIPT THIS CONSOLE SHIPS, DERIVED FROM THE STAGED TREE.
#
# The four names used to be spelled out across three paragraphs here, and the
# cost of that was cpugovernor: copied, made executable, and never enabled, so
# on a fresh install it sat there doing nothing. Governor tuning is silent
# either way, which is exactly why nobody noticed. Adding etc/init.d/<name> to
# the repo is now the whole change.
#
# Across a FIRMWARE UPGRADE none of these enables survive - the keep list
# preserves init scripts, not rc.d links - and the boot-time guard
# /etc/hotplug.d/iface/12-console-services re-registers whatever is missing.
for f in $S/etc/init.d/*; do
    /etc/init.d/${f##*/} enable >/dev/null 2>&1 || true
done
echo "  . services registered for boot"

# STARTED HERE BY NAME, and this list is deliberate rather than forgotten: what
# distinguishes these is a reason to be running BEFORE the next reboot rather
# than after it. beryl-vpndns is the counter-example and must NOT be started -
# it recomputes the VPN nftables rules at boot, S18 against fw4 at S19, so
# running it now would rewrite the live ruleset for no benefit.
#   pingmon     a 1-second probe whose 5-minute ring is what makes the Overview
#               ping / loss / jitter history survive the dashboard being closed.
#               procd rather than cron, because cron floors at a minute and a
#               five-minute chart needs seconds. See /usr/sbin/pingmon.
#   wifiwatch   nothing collects radio state until it runs.
#   cpugovernor one-shot governor tuning, silent either way.
# `if`, and an explicit `|| true`, because `[ -x ... ] && cmd` under `set -e`
# aborts the whole block the moment cmd fails - the trailing status of an AND
# list is the status of its last command, and set -e does not forgive that one.
for s in pingmon wifiwatch cpugovernor; do
    if [ -x "/etc/init.d/$s" ]; then
        /etc/init.d/$s restart >/dev/null 2>&1 || true
    fi
done
echo "  . pingmon, wifiwatch and cpugovernor running"

# Keep everything across a sysupgrade.
#
# THE ONE LIST IN THIS FILE THAT IS DELIBERATELY HAND-WRITTEN, because it has to
# name paths the staged tree cannot know about: runtime state (/etc/dashboard),
# generated output (/etc/nftables.d/30-beryl-vpndns.nft), and files that belong
# to packages the console only wires up. What keeps it honest is the Verifying
# section below, which walks the staged tree and fails when a shipped file is
# not covered here - so the reconciliation is derived even though the list is
# not.
#
# Checked against /lib/upgrade/keep.d on the router before adding anything, and
# entries the base system already covers are deliberately absent: /etc/rc.local
# and /etc/lockdown come from base-files-essential and usbmuxd. /etc/crontabs
# and /etc/nftables.d are likewise covered by busybox and firewall4, and are
# named anyway - narrowing a directory the base system keeps wholesale costs
# nothing and documents what this console depends on.
#
# /etc/dnsmasq.conf and /etc/nlbwmon were missing here while the live router had
# both, which is the drift this closes: keep.d covers /etc/dnsmasq.d/ but NOT
# /etc/dnsmasq.conf, and covers /etc/nlbwmon not at all.
#   /etc/nlbwmon      the Traffic panel history. Not owned by any package - the
#                     database directory nlbwmon is pointed at - so nothing else
#                     preserves it and a firmware upgrade silently starts the
#                     per-device accounting over from zero.
#   /etc/dnsmasq.conf hand-owned on this router because https-dns-proxy is set
#                     to dnsmasq_config_update=- , which stops anything from
#                     regenerating it. MEASURED, not assumed: today the file is
#                     the packaged sample and holds no active directive at all -
#                     the AdGuard forwarding lives in uci dhcp, which keep.d
#                     already preserves under /etc/config/ - so losing it breaks
#                     nothing TODAY. It is kept because the setting above makes
#                     it the only place a hand-written dnsmasq directive can go.
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
         /etc/hotplug.d/net/41-packet-steering \
         /etc/hotplug.d/net/42-txpower-24 \
         /etc/hotplug.d/usb/40-usbmuxd /etc/init.d/cpugovernor /etc/sysctl.d/99-local.conf \
         /usr/sbin/pingmon /etc/init.d/pingmon /www/cgi-bin/probe-api \
         /www/cgi-bin/version-api \
         /etc/init.d/beryl-vpndns \
         /etc/nftables.d/30-beryl-vpndns.nft \
         /etc/dnsmasq.conf /etc/nlbwmon \
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
# The endpoints come from the tree, not from a list written here. The list here
# named seven of the eight shipped CGI, and the one it left out was version-api —
# precisely the endpoint an install can break without anyone seeing it. os.js
# compares its own build stamp against what version-api answers, so if that
# endpoint is dead the comparison never runs and a cached page keeps claiming to
# be current for as long as the browser holds it. Reading the names from the
# repo is safe here: the staged tree was already proved identical to it above.
EPBAD=0
for f in "$SRC"/www/cgi-bin/*-api; do
    ep=${f##*/}
    CODE=$(ssh -n "$TARGET" "uclient-fetch -q -O /dev/null http://$BASE/cgi-bin/$ep 2>&1 && echo 200 || echo ERR")
    [ "$CODE" = 200 ] || EPBAD=$((EPBAD + 1))
    printf '  %-14s %s\n' "$ep" "$CODE"
done
# Not fatal - a re-install onto a working console answers 200 whether or not this
# run did anything, so these are the weak half and the block below is the real
# check. But a silent ERR in a column of 200s is exactly the kind of thing that
# gets scrolled past, so say it in words.
[ "$EPBAD" = 0 ] || warn "$EPBAD endpoint(s) did not answer — installed, but not being served"

# ENDPOINTS ARE THE EASY HALF, AND THEY LIE ON A RE-INSTALL. cp over an existing
# file keeps the destination's mode, so on a router that already had a working
# console every endpoint answers 200 whether or not this run got as far as the
# quiet work. The three things below are exactly what an abort skips, and the
# preserve list is the one that caused real loss: notifymon sat in the crontab
# for a day while absent from /etc/sysupgrade.conf, so every backup taken in that
# window silently lacked the file. Checking it here is what would have said so.
say "Verifying the quiet half"
# EVERY CHECK BELOW READS THE STAGING TREE, not a list written here. Staging is
# the repo, so this asks the only questions worth asking - "did every file this
# console ships actually arrive, and will it survive a firmware upgrade and
# therefore appear in a backup?" - and it keeps asking them correctly for files
# that do not exist yet.
#
# THE PREVIOUS VERSION COULD PASS ON AN ABSENCE. Its service loop read four
# hardcoded names and skipped any whose init script was missing, so deleting one
# from the repo produced a clean pass and exit 0: the check was satisfied by the
# very file it existed to check being gone. Its cron loop read four more names
# that had to be kept in step with the shipped crontab by hand. And it asked
# only whether files were PRESERVED, never whether they were INSTALLED, so a
# page directory that was staged, listed for preservation and never copied also
# passed clean. All three are read from the tree now.
#
# NOTE: no apostrophes anywhere in this block either - single-quoted ssh
# argument, same rule as the install block above.
ssh -n "$TARGET" '
    rc=0
    S=/tmp/beryl7
    cd $S || { echo "  ! staging tree is gone - nothing was verified"; exit 1; }

    while read -r m h dom mon dow prog; do
        case "$m" in ""|\#*) continue ;; esac
        grep -qF "$prog" /etc/crontabs/root || { echo "  ! cron entry missing: $prog"; rc=1; }
    done < $S/etc/crontabs/root

    for f in $S/etc/init.d/*; do
        svc=${f##*/}
        # No `continue` on absence. A staged init script that is not on the
        # router is the failure, not a reason to skip the test.
        [ -x "/etc/init.d/$svc" ] || {
            echo "  ! init script missing or not executable: /etc/init.d/$svc"; rc=1; continue; }
        ls /etc/rc.d/ 2>/dev/null | grep -q "^S[0-9]*$svc$" || { echo "  ! not enabled for boot: $svc"; rc=1; }
    done

    # COUNTED BEFORE IT IS WALKED. What follows reports problems by PRINTING
    # them, and the caller then treats an empty report as a pass - so a walk
    # that examined nothing at all reads exactly like a walk that found nothing
    # wrong. That is the same shape as the vacuous service check this block was
    # rewritten to remove, one level up: the staging tree not being where we
    # think it is would have been reported as everything checking out.
    _nwalk=$(find www usr etc -type f 2>/dev/null | wc -l)
    if [ "${_nwalk:-0}" -lt 1 ]; then
        echo "  ! the staged tree is empty or unreadable — nothing was verified"
        rc=1
    fi
    find www usr etc -type f | while read -r rel; do
        # the one file that does not install under its own name
        case "$rel" in
            etc/dashboard/classmap.example) dst=/etc/dashboard/classmap ;;
            *)                              dst="/$rel" ;;
        esac
        [ -e "$dst" ] || echo "  ! STAGED BUT NEVER INSTALLED: $dst"
        # covered by its own entry, or by any ancestor directory entry
        hit=0; probe="$dst"
        while [ -n "$probe" ] && [ "$probe" != "/" ]; do
            if grep -qxF "$probe" /etc/sysupgrade.conf 2>/dev/null; then hit=1; break; fi
            probe="${probe%/*}"
        done
        [ "$hit" = 1 ] || echo "  ! NOT PRESERVED across sysupgrade, so NOT in backups: $dst"
    done > /tmp/beryl7-findings
    if [ -s /tmp/beryl7-findings ]; then cat /tmp/beryl7-findings; rc=1; fi
    rm -f /tmp/beryl7-findings
    # Said out loud, so a number that is obviously too small is visible rather
    # than having to be inferred from the absence of complaints.
    echo "  . $_nwalk staged files checked against the preserve list"

    # THE SAME RECONCILIATION THE OTHER WAY ROUND, and it is the half the walk
    # above cannot do. That walk reads the staged tree, so it is blind to a file
    # DELETED from the repo: nothing stages it, nothing checks it, and
    # /etc/sysupgrade.conf goes on naming a path that will never exist again.
    # Deleting etc/init.d/pingmon from the repo passed clean for exactly that
    # reason, while /usr/sbin/pingmon was still shipped and could no longer be
    # started by anything.
    #
    # Only the directories this repo owns are checked. Entries outside them are
    # skipped deliberately: /etc/dashboard runtime state, the /etc/nftables.d
    # file beryl-vpndns writes at boot, and the packages the console only wires
    # up are all legitimately absent on a fresh install.
    #
    # A path YOU added under these directories by hand will trip this too. That
    # is the intended reading of the message: something is on the preserve list
    # that the console does not ship.
    while read -r p; do
        case "$p" in
            /www/*|/usr/sbin/*|/usr/share/beryl/*|/etc/init.d/*|/etc/hotplug.d/*|/etc/sysctl.d/*) ;;
            *) continue ;;
        esac
        [ -e "$S$p" ] || { echo "  ! preserved but not shipped: $p"; rc=1; }
    done < /etc/sysupgrade.conf
    [ "$rc" = 0 ] && echo "  . files, cron, boot links and the preserve list all check out"
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
