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
    gp_src="${gp_src#*://}"; gp_src="${gp_src%%[:/]*}"
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
