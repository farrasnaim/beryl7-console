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
# This list must stay identical to the README's dependency table. It named a
# statistics package that had been removed from the router, while the Traffic
# panel has always read nlbwmon — so a reader following the README installed the
# wrong thing and still got an empty panel. Each of these degrades honestly when
# absent; the warning exists to say so before you go looking for the reason.
for pkg in pbr wireguard-tools nlbwmon; do
    ssh -n "$TARGET" "if command -v apk >/dev/null 2>&1; then apk info -e '$pkg' >/dev/null 2>&1;
                      else opkg list-installed 2>/dev/null | grep -q \"^$pkg \"; fi" \
        || warn "not installed: $pkg — the matching page will be limited (see the README)"
done

# ------------------------------------------------------------------- upload --
say "Uploading"
ssh -n "$TARGET" 'rm -rf /tmp/beryl7 && mkdir -p /tmp/beryl7'
tar -C "$SRC" -cf - www usr etc | ssh "$TARGET" 'tar -xf - -C /tmp/beryl7'
ok "staged in /tmp/beryl7"

# ------------------------------------------------------------------ install --
say "Installing"
ssh -n "$TARGET" 'set -e
S=/tmp/beryl7

# Web pages and CGI. The console never replaces LuCI: it installs alongside it
# and LuCI stays reachable at /cgi-bin/luci/.
mkdir -p /www/cgi-bin
cp    $S/www/os.css $S/www/os.js $S/www/theme.css /www/
cp -r $S/www/dashboard $S/www/vpn $S/www/repeater $S/www/tethering $S/www/settings /www/
cp -r $S/www/legacy /www/
cp    $S/www/cgi-bin/*-api /www/cgi-bin/

# The helpers every CGI sources. Outside /www on purpose: uhttpd would serve
# anything under /www/cgi-bin as an endpoint of its own. Copied BEFORE the pages
# above would matter, but ordering here is cosmetic — nothing runs until a
# request arrives.
mkdir -p /usr/share/beryl
cp $S/usr/share/beryl/cgi-lib.sh /usr/share/beryl/

# Helper daemons and the nftables generator.
cp $S/usr/sbin/dashmon $S/usr/sbin/apwatch $S/usr/sbin/vpnwatch $S/usr/sbin/beryl-vpndns \
   $S/usr/sbin/beryl-pbrtbl $S/usr/sbin/pingmon /usr/sbin/

# Hotplug automation and system tunables.
mkdir -p /etc/hotplug.d/iface /etc/hotplug.d/net /etc/hotplug.d/usb /etc/sysctl.d
cp $S/etc/hotplug.d/iface/* /etc/hotplug.d/iface/
cp $S/etc/hotplug.d/net/* /etc/hotplug.d/net/
cp $S/etc/hotplug.d/usb/40-usbmuxd /etc/hotplug.d/usb/
cp $S/etc/init.d/cpugovernor $S/etc/init.d/pingmon $S/etc/init.d/beryl-vpndns /etc/init.d/
cp $S/etc/sysctl.d/99-local.conf /etc/sysctl.d/

# cp does not carry the exec bit reliably across filesystems; CGI that is not
# executable returns 403 and a hotplug script that is not executable is ignored
# silently, so set it explicitly rather than hoping.
chmod 755 /www/cgi-bin/dashboard-api /www/cgi-bin/rate-api /www/cgi-bin/vpn-api \
          /www/cgi-bin/repeater-api /www/cgi-bin/tethering-api /www/cgi-bin/settings-api \
          /www/cgi-bin/probe-api /www/cgi-bin/version-api \
          /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/beryl-vpndns \
          /usr/sbin/beryl-pbrtbl \
          /etc/hotplug.d/iface/12-console-services \
          /etc/hotplug.d/iface/15-travel-dns /etc/hotplug.d/iface/31-tethering-clash \
          /etc/hotplug.d/iface/32-pbr-uplink \
          /etc/hotplug.d/iface/33-uplink-width \
          /etc/hotplug.d/iface/34-vpn-resume \
          /etc/hotplug.d/iface/35-nlbw-v6prefix \
          /etc/hotplug.d/iface/99-repeater-iot /etc/hotplug.d/net/30-tethering \
          /etc/hotplug.d/net/40-rrm-neighbors \
          /etc/init.d/cpugovernor /usr/sbin/pingmon /etc/init.d/pingmon \
          /etc/init.d/beryl-vpndns
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
for job in /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch; do
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
         /etc/init.d/beryl-vpndns; do
    grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf
done
echo "  . sysupgrade.conf updated"
rm -rf /tmp/beryl7'

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

say "Done"
echo "  open  http://$ROUTER/dashboard/"
echo "  LuCI is untouched at  http://$ROUTER/cgi-bin/luci/"
echo
echo "  Next: edit /etc/dashboard/classmap to give your devices names and icons."
echo
echo "  NOTE: the console has no login. Anyone who can reach $ROUTER over HTTP can"
echo "  read it AND change settings. That is intentional for a trusted home LAN —"
echo "  make sure your firewall keeps guest/IoT networks and the WAN away from it."
