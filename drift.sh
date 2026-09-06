#!/bin/sh
# Report where the live router differs from this repo.
#
# WHY THIS EXISTS
#
# install.sh copies repo -> router. Anything changed ON the router — from an SSH
# session, the Telegram bot, LuCI, or by hand — is invisible in this tree, so a
# later deploy from an unchanged repo silently DESTROYS it. No error, no
# conflict, no trace. Getting the change into git is the secondary benefit; not
# losing it is the point, which is why this belongs at the START of a session
# and always before a deploy.
#
# It is state-based rather than journal-based on purpose. A changelog someone
# writes can be forgotten or wrong. A hash cannot, and it catches a change no
# matter who made it.
#
# READ-ONLY BY DESIGN — and that is a security property, not laziness.
#
# The .gitignore here denies everything under etc/ and re-admits by name. It is
# the only thing standing between this PUBLIC repository and the WireGuard
# private keys, Wi-Fi passphrases, SSH host keys and password hashes that sit on
# a live router. Its comment records two separate occasions when a deny-list
# shape leaked. So: this script never writes to the router, never commits, never
# deploys. If a change put a secret into a tracked file, an auto-commit would
# publish it irreversibly. The decision to commit stays a human one, here, where
# the ignore rules actually apply.
#
# The same reasoning is why the VPS holds no GitHub credential. install.sh runs
# FROM this repo ONTO the router, so push access to a public repo is a path back
# into the LAN. The bot may change the router; only the PC may change the repo.
#
# Usage:  ./drift.sh [router-ip]
# Exit:   0 = in sync, 1 = drift found, 2 = could not check

set -e

ROUTER=${1:-${ROUTER:-192.168.8.1}}
SSH_USER=${SSH_USER:-root}
TARGET="$SSH_USER@$ROUTER"

cd "$(dirname "$0")"
SNAP=sysupgrade.snapshot

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---- 1. which files to compare -------------------------------------------
#
# Derived from git, never hand-maintained: a second list would drift from the
# first, which is the exact failure this script exists to catch.
#
# /etc/sysupgrade.conf is NOT usable as the source. It names ~60 paths while the
# repo tracks 51 deployable ones, and the gap is deliberate: /etc/dashboard
# (notify.conf holds the push topic), /etc/adguardhome, /etc/nlbwmon and
# /etc/lockdown are state and secrets — preserved across a firmware upgrade,
# never committed. Comparing against sysupgrade.conf would report all of them as
# permanently missing and the report would be noise nobody reads.
#
# The prefix filter drops the eight repo-root tools (install.sh, backup.sh, this
# script, README…) that have no counterpart on the router.
#
# `*.example` files are SEEDS, not deployed files, and are excluded because
# comparing them is meaningless in both directions. install.sh copies
# etc/dashboard/classmap.example to /etc/dashboard/classmap only when that file
# does not already exist; the installed copy then holds the real device names and
# is MEANT to diverge from the template forever.
#
# This replaced an earlier attempt that read install.sh's remap rule and compared
# the example against the live classmap. It worked, and it was wrong: it simply
# traded a permanent false ABSENT for a permanent false CHANGED. A report that
# always contains the same non-issue is one nobody reads, which is worse than no
# report at all — so the seed is excluded rather than remapped.
#
# If a NON-seed file is ever installed under a different name, it will show up
# here as ABSENT. That is loud, wrong in an obvious way, and gets fixed once —
# which is a better failure than silently comparing the wrong pair of files.
FILES=$(git ls-files | grep -E '^(etc|usr|www)/' | grep -v '\.example$')
N=$(printf '%s\n' "$FILES" | wc -l)

if [ -z "$FILES" ]; then
    echo "no tracked deployable files found — wrong directory?" >&2
    exit 2
fi

say "Hashing $N tracked files on $TARGET"

# ---- 2. the router's side -------------------------------------------------
#
# One ssh round trip: the path list goes in on stdin and the router walks it.
# Files are compared by content hash, so a mode or mtime difference is ignored —
# only what a deploy would actually overwrite counts as drift.
if ! printf '%s\n' "$FILES" | ssh "$TARGET" 'while read -r p; do
        if [ -f "/$p" ]; then
            printf "%s %s\n" "$(md5sum "/$p" | cut -d" " -f1)" "$p"
        else
            printf "ABSENT %s\n" "$p"
        fi
    done' > "$TMP/remote" 2>"$TMP/err"; then
    echo "could not reach $TARGET:" >&2
    cat "$TMP/err" >&2
    exit 2
fi

# ---- 3. this tree's side --------------------------------------------------
#
# .gitattributes pins `* text=auto eol=lf`, so the working tree is LF on Windows
# too and these hashes are comparable with the router's. Without that the whole
# comparison would report every file as changed.
printf '%s\n' "$FILES" | while read -r p; do
    printf '%s %s\n' "$(md5sum "$p" | cut -d' ' -f1)" "$p"
done > "$TMP/local"

# ---- 4. compare -----------------------------------------------------------
awk '
    NR == FNR { loc[$2] = $1; next }
    {
        if ($1 == "ABSENT")     print "absent " $2
        else if (loc[$2] != $1) print "changed " $2
        else                    print "same " $2
    }
' "$TMP/local" "$TMP/remote" > "$TMP/verdict"

# grep -c prints 0 AND exits 1 when it matches nothing, which under `set -e`
# would end the script here. The `|| true` is load-bearing.
n_changed=$(grep -c '^changed ' "$TMP/verdict" || true)
n_absent=$(grep -c '^absent '  "$TMP/verdict" || true)
n_same=$(grep -c '^same '      "$TMP/verdict" || true)

rc=0
echo
if [ "$n_changed" -gt 0 ]; then
    rc=1
    say "CHANGED on the router — a deploy from this tree would overwrite these ($n_changed)"
    sed -n 's/^changed //p' "$TMP/verdict" | while read -r p; do note "$p"; done
    echo
fi

if [ "$n_absent" -gt 0 ]; then
    rc=1
    say "TRACKED here but ABSENT on the router ($n_absent)"
    sed -n 's/^absent //p' "$TMP/verdict" | while read -r p; do note "$p"; done
    echo
fi

# ---- 5. new preserve entries ---------------------------------------------
#
# A file added to the router needs three things or it is lost on the next
# firmware upgrade AND missing from every backup: the repo, the install.sh
# preserve list, and /etc/sysupgrade.conf. The third is the one that gets
# forgotten, so a new line here is the signal that a new file exists at all.
ssh "$TARGET" 'cat /etc/sysupgrade.conf' > "$TMP/sysup"

if [ ! -f "$SNAP" ]; then
    cp "$TMP/sysup" "$SNAP"
    say "Baseline written: $SNAP"
    note "First run — nothing to compare preserve entries against yet."
    echo
elif ! cmp -s "$SNAP" "$TMP/sysup"; then
    rc=1
    say "PRESERVE LIST changed since the snapshot"
    diff "$SNAP" "$TMP/sysup" | sed -n 's/^> /  added:   /p;s/^< /  removed: /p' || true
    note "If a line was added, that file needs all three tracks before it is safe."
    echo
fi

# ---- 6. verdict -----------------------------------------------------------
if [ "$rc" = 0 ]; then
    say "In sync — $n_same/$N tracked files match, preserve list unchanged."
else
    say "Drift found. Nothing has been changed on either side."
    note "To inspect one file:  ssh $TARGET cat /PATH | diff PATH -"
    note "To accept a change:   ssh $TARGET cat /PATH > PATH   (then review, then commit)"
    note "To discard it:        ./install.sh $ROUTER           (redeploys this tree)"
fi

exit $rc
