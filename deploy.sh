#!/bin/sh
# Push named files to the router, byte for byte, and nothing else.
#
#     ./deploy.sh 192.168.8.1 www/console/console.css www/console/index.html
#
# install.sh is the whole-tree installer: it re-copies every file, re-registers
# every service and reconciles the preserve list. That is the right tool for a
# new checkout and the wrong tool for a stylesheet edit — it costs a minute and
# touches things the edit did not. This copies exactly the paths you name,
# preserving their repo-relative location under /, sets 755 on anything under
# cgi-bin, usr/sbin, init.d or hotplug.d (cp does not carry the bit reliably
# across filesystems, and a CGI without it is a 403 with nothing in the log),
# and then proves the copy by comparing md5 on both sides.
#
# NEW shipped files still need the other two tracks — install.sh's preserve
# list and /etc/sysupgrade.conf — or a firmware upgrade quietly drops them.
# This script says so when it sees a path that is not yet on the router.
#
# tar over ssh rather than scp: stock dropbear has no sftp server.

set -e
ROUTER=${1:?usage: deploy.sh <router> <file...>}; shift
[ $# -gt 0 ] || { echo "name at least one file"; exit 1; }
SSH_USER=${SSH_USER:-root}
TARGET="$SSH_USER@$ROUTER"
SRC=$(cd "$(dirname "$0")" && pwd)

for f in "$@"; do
    [ -f "$SRC/$f" ] || { echo "not a file in the repo: $f"; exit 1; }
    case "$f" in www/*|usr/*|etc/*) ;; *) echo "not a shipped path: $f"; exit 1 ;; esac
done

# Which of these does the router not have yet? Said before the copy, so the
# note about the other two tracks arrives with the deploy, not after a reboot.
NEW=$(for f in "$@"; do printf '%s\n' "/$f"; done | ssh "$TARGET" 'while read -r p; do [ -e "$p" ] || echo "$p"; done')

tar -C "$SRC" -cf - "$@" | ssh "$TARGET" 'tar -xf - -C / && for f in '"$*"'; do
    case "$f" in www/cgi-bin/*|usr/sbin/*|etc/init.d/*|etc/hotplug.d/*) chmod 755 "/$f" ;; *) chmod 644 "/$f" ;; esac
done'

# Prove it: md5 of every file, both sides, must agree.
LOCAL=$(cd "$SRC" && md5sum "$@" | awk '{print $1}')
REMOTE=$(for f in "$@"; do printf '%s\n' "/$f"; done | ssh "$TARGET" 'while read -r p; do md5sum "$p" | cut -c1-32; done')
if [ "$LOCAL" = "$REMOTE" ]; then
    printf '  . %d file(s) on %s, byte-identical\n' "$#" "$ROUTER"
else
    echo "  ! md5 mismatch after copy - do not trust this deploy"
    exit 1
fi
if [ -n "$NEW" ]; then
    echo "  ! new on the router - add to install.sh's preserve list and /etc/sysupgrade.conf:"
    printf '%s\n' "$NEW" | sed 's/^/      /'
fi
