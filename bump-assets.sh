#!/bin/sh
# Stamp the current content hash of the shared assets into every page that
# loads them, so a changed file is a changed URL.
#
# WHY: uhttpd sends no Cache-Control for static files, and it has no option to
# add one — the only knobs it exposes are timeouts, prefixes and TLS. With no
# freshness directive a browser falls back to heuristic caching and will happily
# serve an os.css or os.js from earlier in the day. On 2026-08-11 that silently
# defeated four separate UI changes in a row: the deployed file was correct on
# the router every time, and the page kept running the old one. The failure mode
# is the worst kind — it looks exactly like a broken deploy.
#
# A hash rather than a hand-bumped number, because a number only works if the
# person editing os.css remembers to raise it, and the evidence says they don't.
#
# Run after touching os.css or os.js and before copying the tree to the router.
# Safe to run repeatedly: if nothing changed, nothing is rewritten.

set -e
cd "$(dirname "$0")/www"

hash_of() { md5sum "$1" | cut -c1-8; }

CSS=$(hash_of os.css)
JS=$(hash_of os.js)
changed=0

for page in */index.html; do
    case "$page" in legacy/*) continue ;; esac
    [ -f "$page" ] || continue
    before=$(md5sum "$page")

    # matches both the bare form and an already-stamped one
    sed -i \
        -e 's|href="/os\.css\(?v=[0-9a-f]*\)\?"|href="/os.css?v='"$CSS"'"|g' \
        -e 's|src="/os\.js\(?v=[0-9a-f]*\)\?"|src="/os.js?v='"$JS"'"|g' \
        "$page"

    after=$(md5sum "$page")
    if [ "$before" != "$after" ]; then
        echo "  stamped  $page"
        changed=$((changed + 1))
    fi
done

echo "  os.css=$CSS  os.js=$JS  ($changed page(s) rewritten)"
