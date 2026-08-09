#!/bin/sh
# Pull a complete restore bundle off the router.
#
#     ./backup.sh 192.168.8.1 [output-dir]
#
# Produces, in ./backups/ by default:
#
#     beryl7-<host>-<date>.tar.gz   OpenWrt's own sysupgrade backup
#     beryl7-<host>-<date>.packages the installed package list
#     beryl7-<host>-<date>.info     model, version, and what was captured
#
# WHY sysupgrade -b RATHER THAN A HAND-PICKED FILE LIST: it already honours
# /etc/sysupgrade.conf, and install.sh adds every console path to that file. So
# one tarball holds both the router's configuration (all of /etc/config: your
# networks, SSIDs, firewall, pbr policies, static leases) and the console
# itself, and it stays correct as the console grows without editing this script.
#
# ############################################################################
# # THE BUNDLE CONTAINS SECRETS: WireGuard private keys, Wi-Fi passphrases,   #
# # and the console's write password. Never commit it to a public repository. #
# # ./backups/ is in .gitignore for exactly this reason.                      #
# ############################################################################

set -e

ROUTER=${1:-${ROUTER:-192.168.1.1}}
SSH_USER=${SSH_USER:-root}
TARGET="$SSH_USER@$ROUTER"
OUTDIR=${2:-"$(dirname "$0")/backups"}

say() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  . %s\n' "$*"; }

say "Backing up $TARGET"
mkdir -p "$OUTDIR"

HOST=$(ssh -n "$TARGET" 'uci -q get system.@system[0].hostname || echo router')
DATE=$(date +%Y%m%d-%H%M%S)
STEM="$OUTDIR/beryl7-$HOST-$DATE"

# --- configuration + console files ------------------------------------------
ssh -n "$TARGET" 'sysupgrade -b /tmp/beryl7-backup.tar.gz >/dev/null 2>&1'
ssh -n "$TARGET" 'cat /tmp/beryl7-backup.tar.gz' > "$STEM.tar.gz"
ssh -n "$TARGET" 'rm -f /tmp/beryl7-backup.tar.gz'
[ -s "$STEM.tar.gz" ] || { echo "backup came back empty — aborting"; rm -f "$STEM.tar.gz"; exit 1; }
ok "config + console: $(basename "$STEM.tar.gz") ($(wc -c < "$STEM.tar.gz") bytes, $(tar -tzf "$STEM.tar.gz" | wc -l) entries)"

# --- package list ------------------------------------------------------------
# Restoring config onto a fresh firmware is not enough: pbr, wireguard-tools and
# the USB modem drivers have to be back before that config means anything.
ssh -n "$TARGET" 'if command -v apk >/dev/null 2>&1; then apk info 2>/dev/null;
                  else opkg list-installed 2>/dev/null | cut -d" " -f1; fi' | sort > "$STEM.packages"
ok "packages: $(wc -l < "$STEM.packages") installed"

# --- provenance --------------------------------------------------------------
{
    echo "host      : $HOST"
    echo "address   : $ROUTER"
    echo "taken     : $(date)"
    ssh -n "$TARGET" 'ubus call system board 2>/dev/null |
        sed -n "s/.*\"model\": \"\([^\"]*\)\".*/model     : \1/p" | head -n1'
    ssh -n "$TARGET" '. /etc/openwrt_release 2>/dev/null; echo "openwrt   : $DISTRIB_DESCRIPTION"'
    echo "restore   : ./restore.sh $ROUTER $(basename "$STEM.tar.gz")"
} > "$STEM.info"
cat "$STEM.info" | sed 's/^/  /'

say "Done"
echo "  $STEM.tar.gz"
echo
echo "  This bundle contains private keys and passwords. Keep it somewhere private"
echo "  (a private git repo, or encrypted storage) — never the public repository."
