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

set -e

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
ssh -n -o ConnectTimeout=10 "$TARGET" true || {
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
    WANT=$(grep -vE '^(kmod-|base-files|busybox|libc|kernel|firmware|.*-firmware$)' "$PKGS" | tr '\n' ' ')
    ssh -n "$TARGET" "if command -v apk >/dev/null 2>&1; then
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
cat "$BUNDLE" | ssh "$TARGET" 'cat > /tmp/restore.tar.gz'
ssh -n "$TARGET" 'sysupgrade -r /tmp/restore.tar.gz && rm -f /tmp/restore.tar.gz'
ok "configuration and console files written"

# The CGI exec bits do not survive every transport; a non-executable CGI is a
# 403 with nothing in the log to explain it.
ssh -n "$TARGET" 'chmod 755 /www/cgi-bin/*-api 2>/dev/null
    chmod 755 /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch /usr/sbin/beryl-vpndns 2>/dev/null
    chmod 755 /etc/hotplug.d/iface/* /etc/hotplug.d/net/30-tethering /etc/init.d/cpugovernor 2>/dev/null
    true'
ok "executable bits reapplied"

say "Rebooting"
ssh -n "$TARGET" 'reboot' || true
echo "  the router is coming back up — give it a minute, then open:"
echo "     http://$ROUTER/dashboard/"
echo
echo "  If the address changed because you restored a different LAN subnet,"
echo "  use the one from the restored config, not $ROUTER."
