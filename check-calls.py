#!/usr/bin/env python3
"""Report calls to functions that nothing in the page defines.

WHY THIS EXISTS. There is no JavaScript engine on the machine this console is
developed from, so bump-assets.sh will happily stamp a page whose script throws
on the first render and nothing notices. Brace balance, id existence and CSS
class checks all pass in that case: a function that is simply absent is
invisible to every one of them.

It caught nothing hypothetical. A block replacement once began at a comment
that sat above transportKnobs, so the function went with it. The call threw a
ReferenceError, render died mid-way, and the page shipped with a section that
drew its heading and then stopped. This is the check that would have said so.

It is deliberately dumb: a regex, not a parser. It cannot understand scope, so
it reports names rather than proving absence, and a name it does not recognise
is a line to read rather than a failure. Run it, read the list, stop when the
list is empty.

    python check-calls.py [page.html ...]        (default: every www/*/index.html)
"""
import re
import sys
import glob
import io
import os

# What the browser provides, plus the locals every page pulls off OS at the top
# of its IIFE. Not exhaustive by design: an unknown name is a prompt to look,
# and padding this list to silence the tool would defeat the tool.
KNOWN = set("""
window document navigator location history console
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame fetch
matchMedia AbortController FileReader
Math String Number Object Array JSON Date Promise RegExp Boolean Error Set Map
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent
encodeURI decodeURI alert confirm prompt Intl
if for while switch catch return typeof function do else try finally new delete
void in instanceof case break continue throw var let const of
""".split())


def strip_noise(body):
    """Remove comments and string literals.

    Without this the tool reported York, Angeles, differently and minmax --
    prose lifted out of comments and CSS out of style strings. A check that
    cries wolf is one nobody reads, which is the same failure it exists to
    prevent.
    """
    body = re.sub(r"/\*.*?\*/", " ", body, flags=re.S)
    body = re.sub(r"//[^\n]*", " ", body)
    body = re.sub(r"'(?:[^'\\\n]|\\.)*'", "''", body)
    body = re.sub(r'"(?:[^"\\\n]|\\.)*"', '""', body)
    return body


def check(path):
    src = io.open(path, encoding="utf-8").read()
    # the inline script only; the HTML above it has no calls to make
    i = src.find("<script>")
    body = strip_noise(src[i:] if i >= 0 else src)

    defined = set(re.findall(r"function\s+([A-Za-z_$][\w$]*)\s*\(", body))
    # Any `var x =` at all: these pages alias OS members that way (var $ = OS.$),
    # and reporting those was pure noise.
    defined |= set(re.findall(r"(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=", body))
    # ...and every further name in a comma-separated declaration. Every page
    # opens with one of these, so without it the tool reported $, clear and
    # setTxt on all five and drowned the one name that mattered.
    defined |= set(re.findall(r",\s*([A-Za-z_$][\w$]*)\s*=", body))
    # parameters, so a callback's own arguments are not reported
    for params in re.findall(r"function\s*[\w$]*\s*\(([^)]*)\)", body):
        for p in params.split(","):
            p = p.strip()
            if p:
                defined.add(p)

    called = set()
    for m in re.finditer(r"(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(", body):
        called.add(m.group(2))

    return sorted(called - defined - KNOWN)


def main():
    files = sys.argv[1:] or sorted(glob.glob("www/*/index.html"))
    bad = 0
    for f in files:
        unknown = check(f)
        name = os.path.basename(os.path.dirname(f)) or f
        if unknown:
            bad += 1
            print("%-12s %s" % (name, ", ".join(unknown)))
        else:
            print("%-12s clean" % name)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
