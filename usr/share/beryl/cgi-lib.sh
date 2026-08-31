#!/bin/sh
# /usr/share/beryl/cgi-lib.sh  —  helpers shared by every *-api CGI.
#
# SOURCED, never executed, and deliberately OUTSIDE /www: uhttpd runs anything
# under /www/cgi-bin as a CGI, so a library kept beside its callers would be a
# fetchable endpoint in its own right.
#
# Why this file exists. These functions used to be copy-pasted into each
# endpoint, which made every fix to one of them an N-file edit: hardening
# guard_post against a hostname origin had to be applied five times and verified
# five times, and a single miss would have left one endpoint exposed while the
# rest looked correct. The copies had also drifted where nobody was watching —
# jnum accepted a minus sign in dashboard-api and rejected it in the other two,
# with nothing to say which behaviour was intended. One definition removes both
# problems: there is no second copy to forget, and no second answer to reconcile.
#
# rate-api does NOT source this. It has no parameters, no writes and no strings
# to escape, and its whole reason for existing is that it is cheap enough to
# poll once a second — sourcing a library it would not call is pure cost.
#
# Contract for callers:
#   POST_MAX   set it BEFORE calling read_body if the 8 KB default is wrong.
#   BODY       set by read_body; qs_get reads it, so read_body comes first.
#   fail       writes a JSON error and exits, so the response headers must
#              already have been printed by the time anything here can fail.

# ------------------------------------------------------------- JSON output ---
# JSON forbids a raw control byte inside a string, and JSON.parse enforces it —
# one such byte anywhere in a payload invalidates the WHOLE response, so the page
# renders nothing and the cause is invisible. Stripping only \n\r\t left BEL, VT,
# FF, ESC and the rest passing through verbatim; reachable through any name the
# router did not author, e.g. a device renamed via setdev, whose own filter also
# only removes \n\r\t.
#
# The range is spelled in octal, NOT as [:cntrl:]. busybox tr does not implement
# POSIX classes and silently treats [:cntrl:] as the literal set { [ : c n t r l ] },
# so `tr -d '[:cntrl:]'` turns "hello world" into "heo wod" — measured on this
# router. That would have quietly corrupted every name containing c, n, t, r or l.
esc() { printf '%s' "$1" | tr -d '\001-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# A JSON number, or 0. Never the input verbatim when the input is not a number:
# an unquoted stray there invalidates the whole document exactly as a control
# byte does, and the field this guards is usually a sysfs read that can come
# back empty.
#
# One leading minus is allowed, because signal strengths are negative and the
# dashboard's copy had to allow them. It did so by adding '-' to the rejected
# set, which also let through "1-2" and "--5" — neither is a JSON number, and
# both would have been emitted raw. Stripping a single leading minus and
# requiring digits for the rest accepts exactly -?[0-9]+ and nothing else.
jnum() {
    _jn="${1#-}"
    case "$_jn" in
        ''|*[!0-9]*) printf '0' ;;
        *) printf '%s' "$1" ;;
    esac
}

# A JSON boolean. The uplink panel is drawn by one renderer from two endpoints,
# so tethering-api and repeater-api emit the same shape and had the same helper
# twice — once as jbool, once as jbool_r purely to avoid a name that was never
# actually taken.
jbool() { case "$1" in 1|true) printf 'true' ;; *) printf 'false' ;; esac; }

fail() { printf '{"ok":false,"error":"%s"}' "$(esc "$1")"; exit 0; }

# --------------------------------------------------------------- firewall ---
# Is there an fw4 ruleset loaded at all? Prints ok | absent | unknown.
#
# This matters far beyond the VPN pages. fw4 loads its whole ruleset in ONE nft
# transaction, so a single malformed file anywhere in /etc/nftables.d/ — from any
# package, not just this console — means nothing loads. Measured on this router
# by planting a broken file and rebooting: `nft list tables` came back completely
# empty. No zone policies, no WAN input filtering, nothing. The console has no
# login and relies entirely on the firewall to keep it off the internet, so that
# is the whole security model absent, silently, from boot.
#
# THE TABLE EXISTING IS NOT THE QUESTION. The first version of this asked
# whether `nft list tables` mentioned `table inet fw4`, and that was a false
# NEGATIVE on the real condition — the worst possible failure for a security
# alarm. Measured across two induced boots with a broken foreign file:
#
#   boot A   nft list tables came back completely empty
#   boot B   `table inet fw4` was listed, but the table held 0 rules, had no
#            input chain at all, and was every bit as open as boot A
#
# Something else (the https-dns-proxy post-include) can leave the fw4 table
# existing as an empty shell after fw4 itself fails to load. So the question has
# to be "is there a WORKING ruleset", not "does the name exist".
#
# Two queries, in this order, and the order is the point:
#
#   1. `nft list tables` purely for its EXIT CODE — it establishes that nft is
#      usable at all. This is the only way to tell "nft is broken" from "the
#      thing I asked about is missing", because a missing chain and a missing
#      table produce the SAME message ("Error: No such file or directory") and
#      the same exit 1. Parsing that error text would be a fragile contract;
#      the exit code of a query that must succeed is a stable one.
#   2. `nft list chain inet fw4 input` for the fact. fw4 always builds an input
#      chain with a policy, so its presence is the honest test of a loaded
#      ruleset, and it fails identically whether the table or the chain is gone
#      — which is correct here, because both mean the same thing to the owner:
#      nothing is being filtered.
#
# ~14ms for the pair. Call it once per request, never in a loop. Anything that
# is not a confirmed absence reports unknown, and callers must stay silent on
# unknown: a false alarm would train the owner to dismiss the one message that
# means their router is open.
fw_table_state() {
    nft list tables >/dev/null 2>&1 || { printf 'unknown'; return 0; }
    _fwi=$(nft list chain inet fw4 input 2>/dev/null) || { printf 'absent'; return 0; }
    case "$_fwi" in
        *policy*) printf 'ok' ;;
        *) printf 'absent' ;;
    esac
}

# ---------------------------------------------------------------- address ---
# A literal unicast IPv4 address and nothing else.
#
# NOT a hostname: probe-api resolving one could go out through the VPN, or fail
# during exactly the outage the probe exists to measure. vpn-api has a second
# reason — an unresolvable name reaching nft aborts the whole ruleset, and a
# resolvable one silently pins whatever it resolved to at load time. NOT
# multicast or broadcast, which mean nothing as a round-trip target or a
# resolver. A LAN address IS allowed: both callers have legitimate uses for one.
# On success, IP4_CANON holds the canonical dotted quad and is what callers
# must STORE - never the raw input. On EVERY failure it is the empty string,
# which it was not: the canonical form used to be appended to IP4_CANON octet by
# octet as the loop ran, so an out-of-range reject left the octets it had already
# accepted standing ("1.2.3.256" left "1.2.3"), and a charset reject returned
# before the variable was touched at all, leaving the PREVIOUS call's value - or
# a previous reject's fragment - in place. Every caller gates on the return code,
# so nothing was reading it; that is luck, not a contract, and the next caller to
# read IP4_CANON after a check it forgot to test would get a valid-looking
# address that was never valid. The value is now built in _canon and copied out
# only on the success path, so no failure route can leave a fragment behind.
# Decision, made deliberately: a leading-zero
# octet is read as DECIMAL padding ("192.168.008.001" means .8.1), because the
# alternative - the kernel and inet_aton reading it as OCTAL - is exactly the
# surprise this exists to remove. Canonicalising rather than rejecting keeps a
# provider config with zero-padded octets working instead of failing with a
# message about an address that looks perfectly fine. Because the stored form
# has no leading zeros, the console and the kernel cannot disagree about it.
#
# The old version compared the first octet as a STRING between two arithmetic
# checks, so "00.1.2.3" walked straight past the "this network" guard that
# visibly existed. Every octet comparison below is arithmetic on the
# canonicalised value.
valid_ip4() {
    # Cleared FIRST, before any route out of this function exists, so the two
    # early rejects below cannot return with a stale value still in it.
    IP4_CANON=""
    case "$1" in
        ''|*[!0-9.]*|*..*|.*|*.) return 1 ;;
    esac
    _c=0; _first=""; _canon=""
    _oldifs=$IFS; IFS=.
    for _o in $1; do
        case "$_o" in ''|*[!0-9]*) IFS=$_oldifs; return 1 ;; esac
        [ "${#_o}" -gt 3 ] && { IFS=$_oldifs; return 1; }
        # strip leading zeros textually - $((...)) would read them as octal
        while [ "${#_o}" -gt 1 ]; do
            case "$_o" in 0*) _o=${_o#0} ;; *) break ;; esac
        done
        [ "$_o" -gt 255 ] && { IFS=$_oldifs; return 1; }
        _c=$((_c + 1))
        [ "$_c" -eq 1 ] && _first=$_o
        _canon="$_canon${_canon:+.}$_o"
    done
    IFS=$_oldifs
    [ "$_c" -eq 4 ] || return 1
    [ "$_first" -eq 0 ] && return 1      # "this network"
    [ "$_first" -ge 224 ] && return 1    # multicast, 255.x broadcast
    # The ONLY assignment to IP4_CANON that is not the empty string.
    IP4_CANON=$_canon
    return 0
}

# A literal IPv6 address. A sanity check, NOT a full RFC 4291 parser: its job is
# to keep things that are not addresses out of a config file, and the one caller
# that could reach nft syntax consumes only IPv4 anyway. Accepts the embedded
# IPv4 form (::ffff:10.0.0.1) because that is a real way to write a resolver.
valid_ip6() {
    case "$1" in
        ''|*[!0-9A-Fa-f:.]*) return 1 ;;
        *:::*) return 1 ;;                   # ":::" is never valid
        *::*::*) return 1 ;;                 # at most one "::"
        *:*) ;;                              # must contain a colon
        *) return 1 ;;
    esac
    case "$1" in ::*) ;; :*) return 1 ;; esac    # a lone leading colon
    case "$1" in *::) ;; *:) return 1 ;; esac    # a lone trailing colon
    # NOT _oldifs: valid_ip4 uses that name for its own save/restore, and calling
    # it from inside this loop would overwrite the IFS this function has to put
    # back — leaving IFS as ":" for the rest of the request.
    _n=0; _v6ifs=$IFS; IFS=:
    for _g in $1; do
        [ -n "$_g" ] || continue             # the empty group of "::"
        case "$_g" in
            *.*) valid_ip4 "$_g" || { IFS=$_v6ifs; return 1; }
                 _n=$((_n + 2)) ;;           # an embedded v4 fills two groups
            *)   [ "${#_g}" -gt 4 ] && { IFS=$_v6ifs; return 1; }
                 _n=$((_n + 1)) ;;
        esac
    done
    IFS=$_v6ifs
    [ "$_n" -ge 1 ] && [ "$_n" -le 8 ]
}

# ----------------------------------------------------------------- request ---
# Read the POST body up-front and bounded, into BODY, so `action` can be parsed
# from it before dispatch — qs_get looks in QUERY_STRING and BODY together, so
# calling it before this leaves body parameters invisible.
#
# A body is read only for POST. A GET that carries one is ignored rather than
# parsed: every write on this console is POST-only precisely so the origin check
# gates it, and honouring GET parameters smuggled in a body would be a way
# around that.
read_body() {
    BODY=""
    [ "$REQUEST_METHOD" = "POST" ] || return 0
    _cl="${CONTENT_LENGTH:-0}"
    case "$_cl" in ''|*[!0-9]*) _cl=0 ;; esac
    [ "$_cl" -gt "${POST_MAX:-8192}" ] && fail "body too large"
    [ "$_cl" -gt 0 ] && BODY=$(dd bs=1 count="$_cl" 2>/dev/null)
    return 0
}

# ------------------------------------------- fill a caption safely ------------
# Fill a message body with AT MOST as many arguments as it has conversions.
#
# WHY THIS EXISTS AT ALL: busybox printf REPEATS its whole format string when it
# is handed more arguments than the format has conversions, rather than ignoring
# the surplus. So a caption the owner reworded in notify.conf with one %s too
# few does not lose a value - it prints the entire sentence twice, the second
# copy filled with whatever was left over. Measured:
#
#     $ printf '%s disconnected from %s GHz.' dev net 5
#     dev disconnected from net GHz.5 disconnected from  GHz.
#
# Too few arguments is the quiet direction: the surplus conversions render as
# empty strings, leaving gaps and stray punctuation.
#
# One caption was hardened against this by hand when its arity changed, and its
# ten siblings were not - which is the four-of-five shape this project keeps
# producing. This is the whole class, in one place, so a new caption is safe by
# default rather than by remembering.
#
# Caps at three, which is the widest caption shipped. A four-slot override takes
# the three-slot branch and renders its fourth conversion empty: wrong, but
# quietly wrong rather than doubled, and four is not a supported arity.
cap_fmt() {   # $1 = format, $2..$4 = values
    _cf=$1; shift
    case "$_cf" in
        *%s*%s*%s*) printf "$_cf" "${1:-}" "${2:-}" "${3:-}" ;;
        *%s*%s*)    printf "$_cf" "${1:-}" "${2:-}" ;;
        *%s*)       printf "$_cf" "${1:-}" ;;
        *)          printf '%s' "$_cf" ;;
    esac
}

# --------------------------------------- announce a deliberate radio reload ---
# apwatch runs once a minute and treats an AP that is configured-but-absent as a
# fault worth acting on IMMEDIATELY - strike one is `wifi up`. That is right when
# a radio has genuinely died: this is a travel router, and an AP that is down is
# the difference between having a way in and not.
#
# It is wrong while WE are the reason the AP is missing. A radio reload takes
# about eight seconds, apwatch samples every sixty, so roughly one reload in
# seven is sampled mid-flight - measured today, when adding a third AP produced
# "AP(s) missing: guest2g (3/4 up) - strike 1" followed by a `wifi up` stacked on
# top of a reload that was already running. It recovered, but that stacking is
# exactly how the 2026-08-10 outage escalated, and apwatch's own header says so.
#
# So every deliberate reload leaves a note first. The repeater path has had this
# for months as /tmp/.repeater-trying; this is the same idea for the four other
# paths that reload a radio. Uptime, not wall clock: monotonic, so an NTP step
# cannot make a stale marker look fresh.
wifi_reloading() { printf '%s\n' "$(cut -d. -f1 /proc/uptime)" > /tmp/.wifi-reloading 2>/dev/null; }

# ------------------------------------------------ read a config as DATA ------
# Load KEY=value lines from a config file WITHOUT handing them to the shell as
# code. Every caller of this used to run `. /etc/dashboard/notify.conf`, and
# that file carries a value written by the web UI - so a string arriving over
# HTTP became a line in a file that four root programs then EXECUTED, once a
# minute from cron. Validating the string on the way in is necessary but is not
# the durable fix: it leaves the class open to the next writer, and it does
# nothing about a file that was already written.
#
# The defence is structural. The only thing from the file that ever reaches the
# shell as text is the KEY, which is checked against the portable name charset
# first. The VALUE reaches it only as `$_cv` - a parameter expansion in an
# assignment, which the shell does not re-parse, does not word-split and does
# not glob. A value of `x$(cmd)` therefore ASSIGNS those eight characters
# instead of running anything, and the same is true of a backtick, a semicolon,
# a pipe or an embedded newline.
#
# THAT IS ONLY HALF OF IT, and the half this comment used to claim - "it cannot
# execute" - was true of conf_load and false of the program that called it. The
# charset check answers "is this a shell name", not "is this a name the shell
# already has a meaning for", and PATH, IFS, LD_PRELOAD, LD_LIBRARY_PATH and ENV
# are all perfectly good shell names. `eval "$_ck=\$_cv"` assigned them, and
# notifymon and wifiwatch then run wget, logger, uci and iw UNQUALIFIED as root:
# a line reading `PATH=/tmp/somewhere` was measured selecting an attacker's
# `logger` out of /tmp on the very next command. Nothing executed inside
# conf_load; the caller executed it, one line later, which is the same outcome.
#
# So the key is now checked against an ALLOWLIST as well as a charset. A
# denylist was the other option and was rejected: it has to enumerate every name
# the shell, the C library and the dynamic loader will ever give meaning to, and
# it is wrong the first time one of them adds another. The allowlist is by
# PREFIX rather than by exact name on purpose - notifymon's header invites the
# owner to add MSG_* rewordings by hand and there are 51 documented keys across
# two separately-versioned daemons, so an exact list here would drift and would
# silently drop an override the owner had set. Every key those daemons and
# settings-api actually read begins NOTIFY_ or MSG_ (checked against all three),
# and no name the shell or the loader cares about begins with either.
#
# The cost is that conf_load is NOT a general KEY=value reader any more: it
# reads this project's notify.conf schema. A future caller with a different
# schema must widen the case below deliberately, and will notice immediately
# because its keys arrive unset. That is the intended failure direction.
#
# An already-poisoned file is defused on its first read after this lands - the
# dangerous line is dropped, not assigned - and it is still not cleaned up.
#
# One layer of matching quotes is stripped, because `.` used to consume them
# and the documented override examples in notifymon are written with them.
# Unlike `.`, a trailing `# comment` after a value is NOT stripped - it becomes
# part of the value. Nothing in the shipped format uses one.
#
# Returns 1 if the file cannot be read, so a caller can tell "absent" from
# "present but empty" instead of guessing.
conf_load() {
    [ -r "$1" ] || return 1
    while IFS= read -r _cl || [ -n "$_cl" ]; do
        case "$_cl" in ''|'#'*) continue ;; esac
        _ck=${_cl%%=*}
        [ "$_ck" = "$_cl" ] && continue                 # no '=' on the line
        case "$_ck" in
            ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;;      # not a shell name
        esac
        # ...and being a shell name is not enough. Written as a literal pattern
        # union rather than a loop over a variable, because splitting a list
        # here would depend on IFS - and IFS is one of the names being kept out.
        case "$_ck" in
            NOTIFY_*|MSG_*) ;;
            *) continue ;;                              # not a key we own
        esac
        _cv=${_cl#*=}
        case "$_cv" in
            '"'*'"') _cv=${_cv#\"}; _cv=${_cv%\"} ;;
            "'"*"'") _cv=${_cv#\'}; _cv=${_cv%\'} ;;
        esac
        eval "$_ck=\$_cv"
    done < "$1"
    unset _cl _ck _cv
    return 0
}

# URL-decode in awk, not sed: busybox sed silently drops the backslash in a
# `\\x\1` replacement, so the usual sed+printf%b trick returns the string with
# its escapes stripped and every parsed field comes back empty. awk builds the
# byte directly from the hex pair instead.
urldec() {
    printf '%s' "$1" | awk '
    BEGIN{ for(i=0;i<16;i++){ h=sprintf("%X",i); H[h]=i; H[tolower(h)]=i } }
    { gsub(/\+/," "); s=$0; n=length(s); out=""
      for(i=1;i<=n;i++){ c=substr(s,i,1)
        if(c=="%" && i+2<=n){ a=substr(s,i+1,1); b=substr(s,i+2,1)
          if((a in H) && (b in H)){ out=out sprintf("%c",H[a]*16+H[b]); i+=2; continue } }
        out=out c }
      printf "%s", out }'
}

# Read a key out of QUERY_STRING or the POST body.
# sub() rather than $2: a value may itself contain '=' (base64, urlencoded text).
qs_get() {
    printf '%s' "${QUERY_STRING}&${BODY}" | tr '&' '\n' \
      | awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}'
}
qs_get_dec() { urldec "$(qs_get "$1")"; }

# ------------------------------------------------ POST guard (CSRF origin) ---
# The console has no password: it is unauthenticated on the trusted LAN by
# design. That makes this check, on every write, the only thing standing between
# a mutation and a page the owner happens to be visiting.
guard_post() {
    [ "$REQUEST_METHOD" = "POST" ] || fail "POST required"
    gp_src="${HTTP_ORIGIN:-$HTTP_REFERER}"
    # Reduce the header to a bare host, in RFC 3986 order. This used to be one
    # line that cut at the first ":" or "/", and the ORDER was the whole bug:
    # `http://<router-address>:80@attacker.example` truncated at the colon,
    # yielded the router's OWN address, and passed the allowlist below. Every
    # write endpoint was reachable that way — measured across all six, not
    # theorised.
    #
    # 1. scheme.  2. path — the authority ends at the first "/", and taking the
    # path off FIRST means a "@" or ":" inside a path can never be misread as
    # userinfo or a port delimiter.
    gp_src="${gp_src#*://}"
    gp_src="${gp_src%%/*}"
    # 3. userinfo. A serialised Origin is scheme://host[:port] and never carries
    # userinfo, so its presence means the header is malformed or forged: refuse
    # outright rather than parse it out. Deliberately stricter than RFC authority
    # parsing, which takes the host after the LAST "@" and would therefore accept
    # `http://attacker:80@<router-address>` — a form whose host really is this
    # router, but which no legitimate client would ever send. This cannot
    # over-refuse, precisely because browsers never emit userinfo.
    case "$gp_src" in *@*) gp_src="" ;; esac
    # 4. port, bracket-aware. `ip -o addr` prints IPv6 unbracketed, so brackets
    # have to come off for a match to be possible at all; the old cut landed on
    # the first colon INSIDE them and produced a fragment ("[fdf4") that could
    # never match anything. That direction failed closed, so it was not a hole —
    # but it did mean an IPv6 literal could never be a valid origin. An
    # unterminated bracket is refused rather than guessed at.
    case "$gp_src" in
        \[*\]*) gp_src="${gp_src#\[}"; gp_src="${gp_src%%\]*}" ;;
        \[*)    gp_src="" ;;
        *)      gp_src="${gp_src%%:*}" ;;
    esac
    # DNS is case-insensitive and a browser echoes back whatever was typed
    # in the address bar, so Beryl7.lan and beryl7.lan are one host. The
    # address list is already lowercase, so this cannot affect IP matching.
    gp_src=$(printf '%s' "$gp_src" | tr 'A-Z' 'a-z')
    gp_ok=0
    case "$gp_src" in
        "") gp_ok=0 ;;
        localhost|127.0.0.1|::1) gp_ok=1 ;;
        *) for gp_ip in $(ip -o addr 2>/dev/null | awk '{split($4,x,"/"); print x[1]}'); do
             [ "$gp_ip" = "$gp_src" ] && { gp_ok=1; break; }
           done
           # ...and the names this router answers to. Opening the console by
           # name is an ordinary thing to do, and settings-api even offers a
           # control to CHANGE the hostname — so the console hands you a way to
           # create the condition that disables it. Without this the page loads
           # (GET is unguarded) and every button then fails "bad origin" with
           # nothing pointing at the cause.
           #
           # Read from uci at runtime, never written literally: this repository
           # is public and a hostname baked in here is one deployment's private
           # detail published.
           #
           # NOT Origin == HTTP_HOST, which is the usual fix and is wrong here.
           # That compares two headers the caller controls to each other, so an
           # attacker domain pointed at this router matches itself and passes.
           # Checking against addresses the router actually owns is precisely
           # what defeats DNS rebinding, so it stays an allowlist.
           if [ "$gp_ok" = 0 ]; then
               gp_h=$(uci -q get system.@system[0].hostname | tr 'A-Z' 'a-z')
               gp_d=$(uci -q get dhcp.@dnsmasq[0].domain | tr 'A-Z' 'a-z')
               [ -n "$gp_d" ] || gp_d=lan
               [ -n "$gp_h" ] && { [ "$gp_src" = "$gp_h" ] || [ "$gp_src" = "$gp_h.$gp_d" ]; } && gp_ok=1
           fi ;;
    esac
    [ "$gp_ok" = 1 ] || fail "bad origin"
}
