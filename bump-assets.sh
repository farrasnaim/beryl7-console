#!/bin/sh
# Stamp the current content hash of the shared assets into every page that
# loads them, so a changed file is a changed URL.
#
# WHY: uhttpd sends no Cache-Control for static files, so a browser falls back to
# heuristic caching and will happily serve an os.css or os.js from earlier in the
# day. On 2026-08-11 that silently defeated four separate UI changes in a row: the
# deployed file was correct on the router every time, and the page kept running
# the old one. The failure mode is the worst kind — it looks exactly like a
# broken deploy.
#
# A hash rather than a hand-bumped number, because a number only works if the
# person editing os.css remembers to raise it, and the evidence says they don't.
#
# ---------------------------------------------------------------------------
# WHAT uhttpd ACTUALLY DOES. Measured 2026-08-12 against
# uhttpd-2026.06.16~7b1bec45-r1 on OpenWrt 25.12.5 r33051, by reading its own
# option list, running `strings` on the binary, and putting conditional requests
# to it. An earlier version of this header asserted more than had been checked
# and the guess was wrong in a way that cost real time twice — it was quoted as
# grounds for ruling out an option that turns out to exist. So: what follows was
# measured, and anything not listed here has not been.
#
#   No Cache-Control knob. Confirmed — it appears in neither the CLI options nor
#   the binary's strings, so uhttpd never emits one for a static file.
#
#   BUT it is NOT true that "the only knobs are timeouts, prefixes and TLS", as
#   this header used to claim. `-i .ext=path` sets an interpreter per extension
#   and is reachable from UCI — /etc/init.d/uhttpd parses an `interpreter` list
#   option — so pages CAN be routed through a handler that sets its own headers.
#   Any CGI can: rate-api returns Cache-Control: no-store today.
#
#   ETag works, If-Modified-Since does not. If-None-Match returns 304; a plain
#   If-Modified-Since returns 200 and the whole body. So REVALIDATION IS ALREADY
#   CHEAP. What makes staleness bite is that browsers never revalidate: with no
#   Cache-Control they use heuristic freshness, roughly proportional to the
#   file's age, so the longer a file sits unchanged the longer a browser serves
#   it stale after it finally changes.
#
# SCOPE LIMIT — READ THIS BEFORE CONCLUDING THE PROBLEM IS SOLVED. Everything
# above is about the os.css and os.js references INSIDE pages, which is all this
# script rewrites. NOTHING VERSIONS THE PAGES THEMSELVES. A change confined to a
# page's own markup or inline script can therefore still be served stale, and
# because a stale page carries the old asset references, the page and its assets
# go stale together — the whole chain is anchored to the page this script cannot
# version. Reaching /dashboard/ by bookmark or typed address is the ordinary way
# in and bypasses every link this script touches. That gap is half the problem
# and it is not fixed here.
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
