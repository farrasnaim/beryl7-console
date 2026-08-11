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
for pkg in pbr wireguard-tools vnstat2; do
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

# Helper daemons and the nftables generator.
cp $S/usr/sbin/dashmon $S/usr/sbin/apwatch $S/usr/sbin/vpnwatch $S/usr/sbin/beryl-vpndns \
   $S/usr/sbin/beryl-pbrtbl $S/usr/sbin/pingmon /usr/sbin/

# Hotplug automation and system tunables.
mkdir -p /etc/hotplug.d/iface /etc/hotplug.d/net /etc/hotplug.d/usb /etc/sysctl.d
cp $S/etc/hotplug.d/iface/* /etc/hotplug.d/iface/
cp $S/etc/hotplug.d/net/30-tethering /etc/hotplug.d/net/
cp $S/etc/hotplug.d/usb/40-usbmuxd /etc/hotplug.d/usb/
cp $S/etc/init.d/cpugovernor $S/etc/init.d/pingmon /etc/init.d/
cp $S/etc/sysctl.d/99-local.conf /etc/sysctl.d/

# cp does not carry the exec bit reliably across filesystems; CGI that is not
# executable returns 403 and a hotplug script that is not executable is ignored
# silently, so set it explicitly rather than hoping.
chmod 755 /www/cgi-bin/dashboard-api /www/cgi-bin/rate-api /www/cgi-bin/vpn-api \
          /www/cgi-bin/repeater-api /www/cgi-bin/tethering-api /www/cgi-bin/settings-api \
          /www/cgi-bin/probe-api \
          /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/beryl-vpndns \
          /usr/sbin/beryl-pbrtbl \
          /etc/hotplug.d/iface/15-travel-dns /etc/hotplug.d/iface/31-tethering-clash \
          /etc/hotplug.d/iface/32-pbr-uplink \
          /etc/hotplug.d/iface/33-uplink-width \
          /etc/hotplug.d/iface/99-repeater-iot /etc/hotplug.d/net/30-tethering \
          /etc/init.d/cpugovernor /usr/sbin/pingmon /etc/init.d/pingmon
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

# Keep everything across a sysupgrade.
touch /etc/sysupgrade.conf
for p in /www/os.css /www/os.js /www/theme.css /www/legacy /www/dashboard /www/vpn \
         /www/repeater /www/tethering /www/settings \
         /www/cgi-bin/dashboard-api /www/cgi-bin/rate-api /www/cgi-bin/vpn-api \
         /www/cgi-bin/repeater-api /www/cgi-bin/tethering-api /www/cgi-bin/settings-api \
         /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/beryl-vpndns \
         /usr/sbin/beryl-pbrtbl \
         /etc/dashboard /etc/crontabs/root \
         /etc/hotplug.d/iface/15-travel-dns /etc/hotplug.d/iface/31-tethering-clash \
         /etc/hotplug.d/iface/32-pbr-uplink \
         /etc/hotplug.d/iface/33-uplink-width \
         /etc/hotplug.d/iface/99-repeater-iot /etc/hotplug.d/net/30-tethering \
         /etc/hotplug.d/usb/40-usbmuxd /etc/init.d/cpugovernor /etc/sysctl.d/99-local.conf \
         /usr/sbin/pingmon /etc/init.d/pingmon /www/cgi-bin/probe-api; do
    grep -qxF "$p" /etc/sysupgrade.conf || echo "$p" >> /etc/sysupgrade.conf
done
echo "  . sysupgrade.conf updated"
rm -rf /tmp/beryl7'

# --------------------------------------------------------------------- check --
say "Verifying"
for ep in dashboard-api rate-api vpn-api repeater-api tethering-api settings-api probe-api; do
    CODE=$(ssh -n "$TARGET" "uclient-fetch -q -O /dev/null http://127.0.0.1/cgi-bin/$ep 2>&1 && echo 200 || echo ERR")
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
