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
# Directories are globbed rather than listed file by file. Every name spelled out
# here is a name that has to be remembered again the next time something is
# added, and it was not: pingmon, beryl-pbrtbl and the usb hotplug had all been
# added to install.sh and never to this list, so a restored router came back
# with them non-executable — no ping history, no fwmark helper, no iPhone
# tethering, and nothing anywhere saying why.
ssh -n $SSHOPT "$TARGET" 'chmod 755 /www/cgi-bin/*-api 2>/dev/null
    chmod 755 /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch \
              /usr/sbin/beryl-vpndns /usr/sbin/beryl-pbrtbl /usr/sbin/pingmon 2>/dev/null
    chmod 755 /etc/hotplug.d/iface/* /etc/hotplug.d/net/* /etc/hotplug.d/usb/* 2>/dev/null
    chmod 755 /etc/init.d/cpugovernor /etc/init.d/pingmon /etc/init.d/beryl-vpndns 2>/dev/null
    true'
ok "executable bits reapplied"

# A restored /etc/init.d script is not a running service: what starts it at boot
# is the /etc/rc.d symlink, and only cpugovernor's was ever registered for the
# backup. Enabling here does not depend on the bundle carrying symlinks at all,
# which is the more robust of the two answers — `enable` is idempotent, so it
# costs nothing when they did come back.
ssh -n $SSHOPT "$TARGET" 'for s in pingmon cpugovernor beryl-vpndns; do
        [ -x "/etc/init.d/$s" ] || continue
        /etc/init.d/$s enable >/dev/null 2>&1
    done
    true'
ok "services enabled for boot"

say "Rebooting"
ssh -n $SSHOPT "$TARGET" 'reboot' || true
echo "  the router is coming back up — give it a minute, then open:"
echo "     http://$ROUTER/dashboard/"
echo
echo "  If the address changed because you restored a different LAN subnet,"
echo "  use the one from the restored config, not $ROUTER."
