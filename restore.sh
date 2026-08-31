#!/bin/sh
# Put a router back the way it was after a reset, reflash, or firmware upgrade.
#
#     ./restore.sh 192.168.1.1 backups/beryl7-Beryl7-20260810-030000.tar.gz
#
# Order matters, and this is the reason the script exists rather than a README
# paragraph: packages must be installed BEFORE the configuration is restored.
# /etc/config/pbr is meaningless until pbr exists, and netifd drops wireguard
# interfaces it has no protocol handler for — restore first and you silently
# lose your tunnels.
#
# So: install packages -> restore config + console -> reboot.
#
# A fresh router is usually at 192.168.1.1 with no password and no SSH key
# installed, so expect to be prompted for the root password a few times unless
# you run ssh-copy-id first.
#
# NOTE ON HOST KEYS: the bundle contains /etc/dropbear/dropbear_*_host_key, so
# restoring it swaps the router's SSH identity MID-RUN. Without the handling
# below the next ssh aborts with REMOTE HOST IDENTIFICATION HAS CHANGED - after
# the config is written but before permissions are fixed, leaving a console that
# answers 403 with nothing in the log to say why. This run therefore uses a
# throwaway known_hosts and never touches yours. A deliberate trade: you are on
# the LAN, deliberately restoring a router you own, and the host key is expected
# to change because you are the one changing it.

set -e

KH=$(mktemp 2>/dev/null || echo /tmp/.beryl7-restore-kh.$$)
trap 'rm -f "$KH"' EXIT INT TERM
SSHOPT="-o StrictHostKeyChecking=no -o UserKnownHostsFile=$KH -o LogLevel=ERROR"

ROUTER=${1:-192.168.1.1}
BUNDLE=$2
SSH_USER=${SSH_USER:-root}
TARGET="$SSH_USER@$ROUTER"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  . %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }

[ -n "$BUNDLE" ] || { echo "usage: $0 <router-address> <bundle.tar.gz>"; exit 1; }
[ -f "$BUNDLE" ] || { echo "no such bundle: $BUNDLE"; exit 1; }

PKGS="${BUNDLE%.tar.gz}.packages"

say "Restoring $BUNDLE -> $TARGET"
ssh -n $SSHOPT -o ConnectTimeout=10 "$TARGET" true || {
    echo "cannot reach $TARGET over SSH."; exit 1; }
ok "reachable"

printf '\n  This overwrites the configuration on %s and reboots it.\n' "$ROUTER"
printf '  Type yes to continue: '
read -r CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "  aborted"; exit 1; }

# --- packages first ----------------------------------------------------------
if [ -f "$PKGS" ]; then
    say "Installing packages"
    # Only the packages worth re-adding: kernel modules and firmware come with
    # the image, and asking the package manager to reinstall those either fails
    # or pointlessly rewrites flash. Everything else is attempted, and failures
    # are reported rather than fatal — a package may have been renamed or
    # dropped between releases.
    # Do NOT filter out kmod-*. An earlier version did, reasoning that modules
    # ship with the image so re-adding them is pointless - but USER-installed
    # ones were collateral, and on one restore that silently took the USB
    # tethering drivers (ipheth, rndis, cdc-eem, acm, sierrawireless) with it.
    # Re-adding a package that is already present is a no-op, so the filter
    # bought nothing and cost a feature.
    WANT=$(grep -vE '^(base-files|busybox|libc|kernel)$' "$PKGS" | tr '\n' ' ')
    ssh -n $SSHOPT "$TARGET" "if command -v apk >/dev/null 2>&1; then
                          apk update >/dev/null 2>&1 || true
                          for p in $WANT; do apk add --no-interactive \"\$p\" >/dev/null 2>&1 || echo \"  ! skipped \$p\"; done
                      else
                          opkg update >/dev/null 2>&1 || true
                          for p in $WANT; do opkg install \"\$p\" >/dev/null 2>&1 || echo \"  ! skipped \$p\"; done
                      fi"
    ok "packages processed"
else
    warn "no package list beside the bundle — skipping package install."
    warn "pbr/wireguard config will not work until you install them by hand."
fi

# --- then configuration ------------------------------------------------------
say "Restoring configuration"
cat "$BUNDLE" | ssh $SSHOPT "$TARGET" 'cat > /tmp/restore.tar.gz'
ssh -n $SSHOPT "$TARGET" 'sysupgrade -r /tmp/restore.tar.gz && rm -f /tmp/restore.tar.gz'
ok "configuration and console files written"

# The CGI exec bits do not survive every transport; a non-executable CGI is a
# 403 with nothing in the log to explain it.
#
# NOTHING IS LISTED BY NAME HERE. Every name spelled out is a name that has to be
# remembered again the next time something is added, and it was not: pingmon,
# beryl-pbrtbl and the usb hotplug had all been added to install.sh and never to
# this list, so a restored router came back with them non-executable — no ping
# history, no fwmark helper, no iPhone tethering, and nothing anywhere saying why.
#
# The fix at the time globbed /www/cgi-bin and /etc/hotplug.d and left the other
# two directories as lists — eight /usr/sbin names and four /etc/init.d names,
# sitting directly under a comment claiming everything was globbed. Both lists
# happened to be complete, which is the only reason it never cost anything a
# second time. The next addition would have come back non-executable again.
#
# Those two cannot simply be globbed: /usr/sbin/* is busybox and every system
# binary on the router, and /etc/init.d/* is every system service. What separates
# a console file from the system's own in those directories is that the console
# asked for it to be kept — install.sh writes every path it ships into
# /etc/sysupgrade.conf, `sysupgrade -b` carries that file inside the bundle, and
# the `sysupgrade -r` above has just restored it. So the bundle names its own
# files, and this reads them back out. Checked against the live router: the 12
# paths it selects are exactly the 12 the two lists spelled out, and none of the
# other 44 files in /usr/sbin.
#
# A path listed there that the bundle did not carry simply does not exist, and
# the -f test skips it.
ssh -n $SSHOPT "$TARGET" 'chmod 755 /www/cgi-bin/*-api 2>/dev/null
    chmod 755 /etc/hotplug.d/iface/* /etc/hotplug.d/net/* /etc/hotplug.d/usb/* 2>/dev/null
    if [ -f /etc/sysupgrade.conf ]; then
        while read -r p; do
            case "$p" in
                /usr/sbin/*|/etc/init.d/*) [ -f "$p" ] && chmod 755 "$p" ;;
            esac
        done < /etc/sysupgrade.conf
    fi
    true'
ok "executable bits reapplied"

# A restored /etc/init.d script is not a running service: what starts it at boot
# is the /etc/rc.d symlink, which the bundle does not carry. Enabling here
# re-derives the links from the scripts - idempotent, so it costs nothing when
# they already exist. The ordinary UPGRADE path (no restore run) gets the same
# healing from /etc/hotplug.d/iface/12-console-services at first boot.
#
# Same four names as the chmod list above, and the same fix: the bundle's own
# /etc/sysupgrade.conf says which init scripts belong to the console, so a
# service added to install.sh is enabled here without this line being touched.
ssh -n $SSHOPT "$TARGET" 'if [ -f /etc/sysupgrade.conf ]; then
        while read -r p; do
            case "$p" in
                /etc/init.d/*) [ -x "$p" ] && "$p" enable >/dev/null 2>&1 ;;
            esac
        done < /etc/sysupgrade.conf
    fi
    true'
ok "services enabled for boot"

say "Rebooting"
ssh -n $SSHOPT "$TARGET" 'reboot' || true
echo "  the router is coming back up — give it a minute, then open:"
echo "     http://$ROUTER/dashboard/"
echo
echo "  If the address changed because you restored a different LAN subnet,"
echo "  use the one from the restored config, not $ROUTER."
