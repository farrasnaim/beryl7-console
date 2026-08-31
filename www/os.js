/* ============================================================================
   BERYL console — shared runtime.
   One file for every page: DOM helpers, formatters, icon set, the polling
   transport, the navigation spine, toasts and dialogs.

   Design constraint that shaped this file: the router is a 4-core A53 serving
   CGI shell scripts. Every poll forks a shell. So the transport below is
   deliberately conservative — it never polls a hidden tab, never allows two
   requests in flight, aborts anything that hangs, and backs off on failure.
   That is strictly less router load than a naive setInterval.
   ========================================================================= */
(function (global) {
'use strict';

/* ------------------------------------------------------------------ DOM --- */
function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;      // textContent everywhere: no page
    return n;                                   // in this console builds HTML
}                                               // from router-supplied strings.
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
function setTxt(n, t) { if (n && n.textContent !== String(t)) n.textContent = t; }
function frag() { return document.createDocumentFragment(); }

/* KEYED LIST — the reason a live panel can animate at all.
   os.css already carries the transitions (400ms on a scale's fill and marker,
   var(--t) on a meter segment). They never fired anywhere on this page because
   every poll ran clear(box) and built fresh nodes: a brand-new element has no
   previous computed style to travel from, so it simply appears at its final
   value. Exactly the same failure as the flow-dash phase reset above — the
   animation was authored, the element just never survived long enough to run it.

   So: same key, same DOM node, contents updated in place. The tree is only
   touched when the SEQUENCE actually changes, and in the steady state the
   commit loop below moves nothing at all.

   Deliberately not CSS `order`: the clients list styles .tbl__group:first-child
   and .row:last-child, which follow DOM order, not visual order — reordering
   visually would put those borders on the wrong rows. Panels with no such
   sibling selectors (the traffic grid) can and do use `order` instead, which
   avoids moving a node mid-transition.

   want(key, build) -> { node, fresh }; call commit() when the sequence is done.
   Nodes that stopped being wanted are removed, as is anything in the box that
   the keyed set never owned (an empty state, a hint).

   unordered:true keeps every surviving node exactly where it is and appends new
   ones at the end — for a box that ranks itself with CSS `order`, where a swap
   would otherwise yank a node out of the tree mid-transition. */
function keyed(box, unordered) {
    var map = box._keyed || (box._keyed = {});
    var seq = [], seen = {};
    return {
        want: function (key, build) {
            var n = map[key], fresh = false;
            if (!n) { n = map[key] = build(); fresh = true; }
            seen[key] = 1; seq.push(n);
            return { node: n, fresh: fresh };
        },
        commit: function () {
            Object.keys(map).forEach(function (k) {
                if (seen[k]) return;
                if (map[k].parentNode) map[k].parentNode.removeChild(map[k]);
                delete map[k];
            });
            if (unordered) {
                for (var j = 0; j < seq.length; j++) {
                    if (!seq[j].parentNode) box.appendChild(seq[j]);
                }
                return;
            }
            var cur = box.firstChild;
            for (var i = 0; i < seq.length; i++) {
                if (cur === seq[i]) { cur = cur.nextSibling; continue; }
                box.insertBefore(seq[i], cur);
            }
            while (cur) { var nx = cur.nextSibling; box.removeChild(cur); cur = nx; }
        }
    };
}

/* Parse a trusted static icon string into nodes. Only ever called with the
   literal SVG constants below — never with data from the router. */
/* Phase for the marching-dash flow animation.
   Every poll replaces the whole SVG, and a freshly created element starts its
   animation at zero — so the dashes snapped back to the start every 5 seconds
   and the diagram looked like it was stuttering rather than flowing. Offsetting
   each new path by where the wall clock currently sits in the cycle means the
   replacement picks up exactly where the old one left off. Every flow path
   derives from the same clock, so they also stay in step with each other.
   FLOW_CYCLE must match the animation-duration of .topo .flow in os.css. */
var FLOW_CYCLE = 1700;
function flowPhase() { return '-' + ((Date.now() % FLOW_CYCLE) / 1000).toFixed(3) + 's'; }
function svg(markup) {
    var d = document.createElement('div');
    d.innerHTML = markup;
    return d.firstChild;
}

/* --------------------------------------------------------------- format --- */
function bytes(b) {
    b = +b || 0;
    if (b < 1024) return b + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < 3);
    return (b < 10 ? b.toFixed(1) : Math.round(b)) + ' ' + u[i];
}
/* Split value/unit so the readout component can typeset them differently. */
function rate(bps) {
    bps = +bps || 0;
    if (bps >= 1e9) return [(bps / 1e9).toFixed(2), 'Gb/s'];
    if (bps >= 1e6) return [(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1), 'Mb/s'];
    if (bps >= 1e3) return [Math.round(bps / 1e3), 'kb/s'];
    return [bps ? Math.round(bps) : 0, 'b/s'];
}
function brate(Bps) { return rate((+Bps || 0) * 8); }
function dur(s) {
    s = Math.max(0, Math.round(+s || 0));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return s + 's';
}
function ago(t, now) {
    var s = Math.max(0, (now || Math.floor(Date.now() / 1e3)) - t);
    if (s < 45) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
}
function clock(ts) {
    var d = new Date(ts * 1000);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
/* RSSI -> 0..4 bars. Thresholds match what actually matters for 802.11 rate
   selection, not an arbitrary linear map. */
function bars(dbm) {
    if (dbm == null || dbm === 0) return 0;
    if (dbm >= -55) return 4;
    if (dbm >= -67) return 3;
    if (dbm >= -75) return 2;
    return 1;
}
function signalWord(dbm) {
    var b = bars(dbm);
    return ['no signal', 'poor', 'weak', 'good', 'excellent'][b];
}
/* The UCI name of the router's primary network. OpenWrt calls it "lan" out of
   the box and every guide, LuCI screen and netifd default agrees, so it is the
   one name worth assuming — everything else (extra SSIDs, their networks, their
   bands) is read back from the router instead of being written down here. */
var LANNET = 'lan';
function bandLabel(b) {
    return b === '2g' ? '2.4 GHz' : b === '5g' ? '5 GHz' : b === '6g' ? '6 GHz' : (b || 'Radio');
}
/* "iot" -> "IoT", "guest" -> "Guest": a network's own name, presented. */
function netLabel(n) {
    if (!n) return 'Secondary';
    if (n.toLowerCase() === 'iot') return 'IoT';
    return n.charAt(0).toUpperCase() + n.slice(1);
}

var GEN = { 0: 'Wi-Fi 4', 4: 'Wi-Fi 4', 5: 'Wi-Fi 5', 6: 'Wi-Fi 6', 7: 'Wi-Fi 7' };
function genOf(st) {
    var r = (st && (st.tx || st.rx)) || {};
    if (r.eht) return 7; if (r.he) return 6; if (r.vht) return 5; return 4;
}

/* ---------------------------------------------------------------- icons --- */
/* 20px grid, 1.5px stroke, drawn for this console. Kept minimal on purpose:
   an icon earns its place only where a word would be slower to parse. */
var I = {
    overview: '<svg viewBox="0 0 20 20"><path d="M3 10.5 10 4l7 6.5"/><path d="M5 9.4V16h10V9.4"/></svg>',
    routing:  '<svg viewBox="0 0 20 20"><path d="M10 3l5.5 2.3v4.2c0 3.4-2.3 6.2-5.5 7.5-3.2-1.3-5.5-4.1-5.5-7.5V5.3z"/><path d="m7.7 9.7 1.7 1.7 3-3.2"/></svg>',
    wifi:     '<svg viewBox="0 0 20 20"><path d="M3.6 8.4a9 9 0 0 1 12.8 0"/><path d="M6.2 11a5.4 5.4 0 0 1 7.6 0"/><circle cx="10" cy="14.6" r="1.2" fill="currentColor" stroke="none"/></svg>',
    usb:      '<svg viewBox="0 0 20 20"><path d="M12.5 6H14a4 4 0 0 1 0 8h-1.5"/><path d="M7.5 6H6a4 4 0 0 0 0 8h1.5"/><path d="M7 10h6"/></svg>',
    globe:    '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3a11 11 0 0 1 0 14a11 11 0 0 1 0-14"/></svg>',
    chip:     '<svg viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="1"/><path d="M8 3v3M12 3v3M8 14v3M12 14v3M3 8h3M3 12h3M14 8h3M14 12h3"/></svg>',
    phone:    '<svg viewBox="0 0 20 20"><rect x="6" y="2.5" width="8" height="15" rx="1.6"/><path d="M9 15.2h2"/></svg>',
    pad:      '<svg viewBox="0 0 20 20"><rect x="4" y="2.5" width="12" height="15" rx="1.6"/><path d="M9 15.2h2"/></svg>',
    laptop:   '<svg viewBox="0 0 20 20"><rect x="4" y="5" width="12" height="8" rx="1"/><path d="M2.5 15.5h15"/></svg>',
    computer: '<svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="9" rx="1"/><path d="M7.5 16.5h5M10 13v3.5"/></svg>',
    tv:       '<svg viewBox="0 0 20 20"><rect x="2.5" y="5" width="15" height="10" rx="1"/><path d="M7 2.5 10 5l3-2.5"/></svg>',
    watch:    '<svg viewBox="0 0 20 20"><rect x="6" y="6" width="8" height="8" rx="2"/><path d="M8 6V3.5h4V6M8 14v2.5h4V14"/></svg>',
    bulb:     '<svg viewBox="0 0 20 20"><path d="M10 3a4.4 4.4 0 0 0-2.6 7.9c.4.3.6.8.6 1.3v.3h4v-.3c0-.5.2-1 .6-1.3A4.4 4.4 0 0 0 10 3z"/><path d="M8.5 15h3M9 17h2"/></svg>',
    router:   '<svg viewBox="0 0 20 20"><rect x="2.5" y="11" width="15" height="6" rx="1"/><path d="M6 14h.01M9 14h.01"/><path d="M10 8V4M7.5 6 10 3.5 12.5 6"/></svg>',
    eth:      '<svg viewBox="0 0 20 20"><rect x="3" y="7" width="14" height="7" rx="1"/><path d="M6.5 14v2M10 14v2M13.5 14v2M6.5 7V5M13.5 7V5"/></svg>',
    dev:      '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="2"/></svg>',
    alert:    '<svg viewBox="0 0 20 20"><path d="M10 3.5 2.8 16h14.4z"/><path d="M10 8v3.5M10 13.6h.01"/></svg>',
    info:     '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 9v4.5M10 6.6h.01"/></svg>',
    check:    '<svg viewBox="0 0 20 20"><path d="m4.5 10.5 3.5 3.5 7.5-8"/></svg>',
    x:        '<svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"/></svg>',
    plus:     '<svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg>',
    refresh:  '<svg viewBox="0 0 20 20"><path d="M16.5 8A6.8 6.8 0 0 0 4.6 6.3"/><path d="M3.5 12A6.8 6.8 0 0 0 15.4 13.7"/><path d="M4.2 3v3.4h3.4M15.8 17v-3.4h-3.4"/></svg>',
    search:   '<svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/></svg>',
    empty:    '<svg viewBox="0 0 20 20"><path d="M3 7h14v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 7l2-4h10l2 4"/></svg>',
    pen:      '<svg viewBox="0 0 20 20"><path d="M10 17h7"/><path d="M13.7 3.2a1.7 1.7 0 0 1 2.4 2.4L6 15.7 3 16.6l.9-3z"/></svg>',
    lock:     '<svg viewBox="0 0 20 20"><rect x="4.5" y="8.5" width="11" height="8" rx="1.2"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/></svg>',
    sliders:  '<svg viewBox="0 0 20 20"><path d="M3 6h14M3 10h14M3 14h14"/><circle cx="8" cy="6" r="1.9" fill="var(--bg)"/><circle cx="13" cy="10" r="1.9" fill="var(--bg)"/><circle cx="6" cy="14" r="1.9" fill="var(--bg)"/></svg>',
    power:    '<svg viewBox="0 0 20 20"><path d="M10 3v7"/><path d="M14.5 5.6a6 6 0 1 1-9 0"/></svg>'
};
var CLASS_ICON = {
    phone: 'phone', pad: 'pad', laptop: 'laptop', computer: 'computer',
    television: 'tv', watch: 'watch', smartappliances: 'bulb', router: 'router'
};
function icon(name) { return svg(I[name] || I.dev); }

/* --------------------------------------------------------------- widgets -- */
/* Segmented meter. Ten segments by default, so each one is a clean 10% and
   the eye can count them without trying; twelve made every reading an
   awkward fraction. The count is a parameter and is remembered on the node,
   because meterSet has to light the same number it was built with - a
   mismatch would leave stale segments lit at the end of the row.
   Signal strength passes 5, the shape everyone already reads as bars. */
function meter(frac, tone, small, segs) {
    var n = segs || 10;
    var m = el('div', 'meter' + (small ? ' meter--sm' : ''));
    m._segs = n;
    for (var i = 0; i < n; i++) m.appendChild(el('i'));
    meterSet(m, frac, tone);
    return m;
}
/* Re-light an existing meter. Only the segments that changed are written, so
   the ones that did not are never restyled and never re-run their fade. */
function meterSet(m, frac, tone) {
    if (tone) m.setAttribute('data-tone', tone); else m.removeAttribute('data-tone');
    var n = m._segs || m.children.length || 10;
    var lit = Math.max(0, Math.min(n, Math.round(frac * n)));
    for (var i = 0; i < n; i++) {
        var want = i < lit ? 'on' : '';
        if (m.children[i].className !== want) m.children[i].className = want;
    }
}
function readout(k, v, u, meta, state, small) {
    var r = el('div', 'ro' + (small ? ' ro--sm' : ''));
    if (state) r.setAttribute('data-state', state);
    r.appendChild(el('div', 'ro__k', k));
    var vv = el('div', 'ro__v');
    vv.appendChild(document.createTextNode(v));
    if (u) vv.appendChild(el('span', 'ro__u', u));
    r.appendChild(vv);
    if (meta) r.appendChild(el('div', 'ro__m', meta));
    return r;
}
function chip(text, kind) {
    return el('span', 'chip' + (kind ? ' chip--' + kind : ''), text);
}
/* No action button here by design. Every page keeps its one action in the
   header, where it also lives once the page has content; putting a second copy
   in the empty state meant two identical controls on screen at once. The copy
   names the header control instead, so the next step is still explicit. */
function emptyState(title, sub, ic) {
    var e = el('div', 'empty'), b = el('div', 'empty__i');
    b.appendChild(icon(ic || 'empty'));
    e.appendChild(b);
    e.appendChild(el('div', 'empty__t', title));
    if (sub) e.appendChild(el('div', 'empty__s', sub));
    return e;
}
function note(text, kind, ic) {
    var n = el('div', 'note' + (kind ? ' note--' + kind : ''));
    n.appendChild(icon(ic || (kind === 'bad' ? 'alert' : kind === 'warn' ? 'alert' : 'info')));
    n.appendChild(el('div', null, text));
    return n;
}

/* Sparkline. Returns an <svg>; caller sizes it with CSS.
   viewBox is fixed and preserveAspectRatio is none, so the stroke would smear
   vertically — vector-effect on the trace classes keeps it 1.5px true. */
/* rangeHint: as with ribbon()'s peakHint, an eased [min,max] from the caller so
   the trace does not re-scale vertically the instant an outlier leaves the
   window. _rawRange always reports what this window actually contains. */
/* GAPS ARE POSITIONS, NOT ABSENCES. A null or negative entry means that slot
   was measured and produced nothing (a lost probe) or was never measured at
   all. This used to filter them out and space the survivors evenly, which meant
   a 30-second outage did not merely disappear from the trace — it dragged
   everything after it leftwards, so the remaining data pointed at the wrong
   time. On a chart whose whole job is "when did this happen", that is worse
   than drawing nothing. x now comes from the slot's own index, and the line
   breaks across a hole instead of bridging it. */
function spark(vals, h, rangeHint) {
    h = h || 46;
    var W = 300, P = 3, i, v;
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 ' + W + ' ' + h);
    s.setAttribute('preserveAspectRatio', 'none');
    s.setAttribute('class', 'chart');
    s.style.height = h + 'px';
    s.setAttribute('aria-hidden', 'true');
    var n = vals.length;
    var pts = vals.filter(function (x) { return x != null && x >= 0; });
    if (pts.length < 2 || n < 2) return s;
    var mn = Math.min.apply(null, pts), mx = Math.max.apply(null, pts);
    if (mx - mn < 4) { var mid = (mx + mn) / 2; mn = mid - 2; mx = mid + 2; }
    s._rawRange = [mn, mx];
    if (rangeHint && rangeHint.length === 2 && rangeHint[1] > rangeHint[0]) {
        mn = rangeHint[0]; mx = rangeHint[1];
    }
    /* Full width horizontally, like ribbon() — the padding is vertical only.
       Insetting x by P put these traces 1% short at each end, which is
       invisible alone but obvious once a spark sits directly under a ribbon on
       the same panel and the two are meant to share a time axis. Half a stroke
       clips at the extreme edges; ribbon() has always done the same. */
    function X(k) { return ((k / (n - 1)) * W).toFixed(1); }
    function Y(y) { return (h - P - ((y - mn) / (mx - mn)) * (h - 2 * P)).toFixed(1); }

    var segs = [], cur = null;
    for (i = 0; i < n; i++) {
        v = vals[i];
        if (v == null || v < 0) { cur = null; continue; }
        if (!cur) { cur = { a: i, pts: [] }; segs.push(cur); }
        cur.b = i;
        cur.pts.push(X(i) + ',' + Y(v));
    }
    var base = (h - P).toFixed(1), dTrace = '', dFill = '';
    segs.forEach(function (g) {
        if (g.pts.length < 2) return;   /* a lone sample has no line to draw */
        var body = g.pts.join(' L');
        dTrace += (dTrace ? ' ' : '') + 'M' + body;
        dFill  += (dFill ? ' ' : '') + 'M' + X(g.a) + ',' + base +
                  ' L' + body + ' L' + X(g.b) + ',' + base + ' Z';
    });
    if (!dTrace) return s;
    var poly = document.createElementNS(s.namespaceURI, 'path');
    poly.setAttribute('class', 'fill');
    poly.setAttribute('d', dFill);
    var line = document.createElementNS(s.namespaceURI, 'path');
    line.setAttribute('class', 'trace');
    line.setAttribute('d', dTrace);
    s.appendChild(poly); s.appendChild(line);
    s._range = [mn, mx];
    return s;
}

/* Dual-direction throughput ribbon: download mirrored below the axis, upload
   above. One glyph answers "is anything moving, and which way" — two stacked
   line charts do not, because the eye has to compare across a gap. */
/* peakHint: draw against a caller-supplied vertical scale instead of this
   window's own maximum. Without it the chart renormalises on every redraw, so
   the moment a spike ages out of the ring the whole trace jumps to a new
   height at once — the single most visible piece of judder on the page. The
   caller eases the hint between frames; the geometry here is unchanged. */
function ribbon(down, up, h, peakHint) {
    h = h || 84;
    var W = 300, mid = h / 2, ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 ' + W + ' ' + h);
    s.setAttribute('preserveAspectRatio', 'none');
    s.setAttribute('class', 'chart');
    s.style.height = h + 'px';
    s.setAttribute('aria-hidden', 'true');
    var all = down.concat(up).filter(function (v) { return v != null; });
    var peak = Math.max.apply(null, all.concat([1]));
    s._rawPeak = peak;
    if (peakHint > 0) peak = peakHint;
    function side(vals, dir, clsF, clsL) {
        if (vals.length < 2) return;
        var d = vals.map(function (v, i) {
            var x = (i / (vals.length - 1)) * W;
            var y = mid - dir * ((v || 0) / peak) * (mid - 3);
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        var p = document.createElementNS(ns, 'polygon');
        p.setAttribute('class', clsF);
        p.setAttribute('points', '0,' + mid + ' ' + d + ' ' + W + ',' + mid);
        var l = document.createElementNS(ns, 'polyline');
        l.setAttribute('class', clsL);
        l.setAttribute('points', d);
        s.appendChild(p); s.appendChild(l);
    }
    side(up, 1, 'fill-2', 'trace-2');
    side(down, -1, 'fill', 'trace');
    var ax = document.createElementNS(ns, 'line');
    ax.setAttribute('class', 'axis');
    ax.setAttribute('x1', 0); ax.setAttribute('x2', W);
    ax.setAttribute('y1', mid); ax.setAttribute('y2', mid);
    s.appendChild(ax);
    s._peak = peak;
    return s;
}

/* INTERNET SOURCES — shared by the Wi-Fi and USB uplink pages. Both are just
   different implementations of "a way out", and the failover order decides
   which of the two wins, so the same panel is served on both rather than
   making the user cross pages to change it. `uplinks[]` has an identical shape
   in repeater-api and tethering-api; priority is always written to
   tethering-api, which owns the metrics. */
var SRC_ICON = { wan: 'eth', wwan: 'wifi', tethering: 'usb' };
/* Kept to ~21 characters: these same strings are the rail's branch descriptors,
   and the rail value slot is 182px at the narrow breakpoint — anything longer
   gets ellipsised there. */
var SRC_NOTE = {
    wan: 'Cable in the WAN port',
    wwan: 'Someone else’s Wi-Fi',
    tethering: 'Phone or modem on USB'
};
function sourcesList(box, d) {
    clear(box);
    var ups = (d.uplinks || []).slice().sort(function (a, b) {
        if (a.active !== b.active) return a.active ? -1 : 1;
        if (a.up !== b.up) return a.up ? -1 : 1;
        return (a.metric || 99) - (b.metric || 99);
    });
    if (!ups.length) {
        box.appendChild(emptyState('No internet sources', 'Ethernet, Wi-Fi, and USB sources appear here.', 'globe'));
        return ups;
    }
    ups.forEach(function (u) {
        var r = el('div', 'row'); r.style.cursor = 'default';
        r.style.gridTemplateColumns = 'minmax(0,1fr) auto auto';
        var id = el('div', 'row__id');
        var ic = el('div', 'row__ico'); ic.appendChild(icon(SRC_ICON[u.name] || 'globe'));
        if (u.active) { ic.style.borderColor = 'var(--sig-line)'; ic.style.color = 'var(--sig-fg)'; }
        id.appendChild(ic);
        var txt = el('div'); txt.style.minWidth = '0';
        var top = el('div', 'row__title');
        top.appendChild(el('span', 'row__nm', u.label || u.name));
        txt.appendChild(top);
        txt.appendChild(el('div', 'row__sub',
            (u.ip || SRC_NOTE[u.name] || '') + (u.device ? '   ·   ' + u.device : '')));
        id.appendChild(txt);
        r.appendChild(id);
        var st = el('div'); st.style.textAlign = 'right';
        st.appendChild(u.active ? stateWord('CARRYING', 'ok')
                     : u.up     ? stateWord('STANDBY', null)
                                : stateWord('DOWN', 'bad'));
        r.appendChild(st);
        var right = el('div'); right.style.cssText = 'text-align:right;min-width:56px';
        right.appendChild(el('div', 'row__num', u.metric != null ? String(u.metric) : '—'));
        right.appendChild(el('div', 'row__cap', 'metric'));
        r.appendChild(right);
        box.appendChild(r);
    });
    return ups;
}
function failoverControl(box, ups, onDone) {
    clear(box);
    var t = ups.filter(function (u) { return u.name === 'tethering'; })[0] || {};
    var w = ups.filter(function (u) { return u.name === 'wwan'; })[0] || {};
    var prefersUsb = (t.metric || 99) <= (w.metric || 99);
    var lab = el('div');
    lab.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap';
    var txt = el('div'); txt.style.cssText = 'flex:1;min-width:220px';
    txt.appendChild(el('div', 'ro__k', 'Failover order'));
    txt.appendChild(el('div', 'hint',
        'Ethernet is always tried first. This decides which backup wins when both a USB device ' +
        'and a Wi-Fi uplink are connected at the same time.')).style.marginTop = '4px';
    lab.appendChild(txt);
    var seg = el('div', 'seg');
    [['modem', 'USB first', prefersUsb], ['wifi', 'Wi-Fi first', !prefersUsb]].forEach(function (o) {
        var b = el('button', 'btn btn--sm');
        b.textContent = o[1];
        b.setAttribute('aria-pressed', o[2] ? 'true' : 'false');
        if (!o[2]) b.addEventListener('click', function () {
            /* tethering-api owns the metrics on both pages */
            act(b, '/cgi-bin/tethering-api', { action: 'priority', pref: o[0] },
                { ok: o[1] + ' from now on.', delay: 1500, refresh: false })
              .then(function (j) { if (j && j.ok && onDone) onDone(); });
        });
        seg.appendChild(b);
    });
    lab.appendChild(seg);
    box.appendChild(lab);
}

/* ---------------------------------------------------------------- toast --- */
var toastBox = null;
function toast(msg, kind, ms) {
    if (!toastBox) {
        toastBox = el('div', 'toasts');
        toastBox.setAttribute('role', 'status');
        toastBox.setAttribute('aria-live', 'polite');
        document.body.appendChild(toastBox);
    }
    var t = el('div', 'toast' + (kind ? ' toast--' + kind : ''));
    t.appendChild(el('i', 'toast__b'));
    t.appendChild(el('div', null, msg));
    toastBox.appendChild(t);
    setTimeout(function () {
        t.style.transition = 'opacity 220ms, transform 220ms';
        t.style.opacity = '0'; t.style.transform = 'translateY(6px)';
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 240);
    }, ms || (kind === 'bad' ? 6500 : 3600));
}

/* --------------------------------------------------------------- dialog --- */
/* One dialog implementation for confirm / password / form. Returns a promise
   that resolves with the collected value, or null when dismissed. Focus is
   trapped to the dialog and restored on close. */
function dialog(opts) {
    return new Promise(function (resolve) {
        var prev = document.activeElement;
        var veil = el('div', 'veil on');
        var dlg = el('div', 'dlg');
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');

        var h = el('div', 'dlg__h');
        h.appendChild(el('div', 'dlg__t', opts.title));
        dlg.appendChild(h);

        var b = el('div', 'dlg__b');
        if (opts.body) {
            if (typeof opts.body === 'string') {
                var p = el('div', null, opts.body);
                p.style.cssText = 'font-size:12.5px;line-height:1.55;color:var(--ink-2)';
                b.appendChild(p);
            } else b.appendChild(opts.body);
        }
        var input = null;
        if (opts.field) {
            var f = el('div', 'field');
            f.style.marginTop = opts.body ? '16px' : '0';
            f.appendChild(el('label', 'label', opts.field.label));
            input = el('input', 'input');
            input.type = opts.field.type || 'text';
            if (opts.field.placeholder) input.placeholder = opts.field.placeholder;
            if (opts.field.value) input.value = opts.field.value;
            input.autocomplete = opts.field.type === 'password' ? 'current-password' : 'off';
            f.appendChild(input);
            b.appendChild(f);
        }
        var errBox = el('div');
        errBox.style.cssText = 'font-size:12px;color:var(--bad-fg);margin-top:8px;display:none';
        b.appendChild(errBox);
        dlg.appendChild(b);

        var f2 = el('div', 'dlg__f');
        var cancel = el('button', 'btn', opts.cancelText || 'Cancel');
        cancel.type = 'button';
        var okBtn = el('button', 'btn ' + (opts.danger ? 'btn--danger' : 'btn--primary'),
                       opts.okText || 'Confirm');
        okBtn.type = 'button';
        f2.appendChild(cancel); f2.appendChild(okBtn);
        dlg.appendChild(f2);
        veil.appendChild(dlg);
        document.body.appendChild(veil);

        function close(val) {
            document.removeEventListener('keydown', onKey, true);
            if (veil.parentNode) veil.parentNode.removeChild(veil);
            if (prev && prev.focus) try { prev.focus(); } catch (e) {}
            resolve(val);
        }
        function fail(msg) {
            errBox.textContent = msg;
            errBox.style.display = '';
            okBtn.classList.remove('is-busy'); okBtn.disabled = false;
        }
        function submit() {
            errBox.style.display = 'none';
            var v = true;
            if (opts.field) {
                v = input.value;
                if (!v && opts.field.required !== false) {
                    return fail(opts.field.emptyMsg || 'This field is required.');
                }
            }
            /* onSubmit lets a dialog validate and act while STAYING OPEN, so a
               rejected input never costs the user what they typed. Return true
               to close, a string to show as an inline error, or a promise of
               either. Without it the old behaviour (close immediately) holds. */
            if (!opts.onSubmit) return close(v);
            okBtn.classList.add('is-busy'); okBtn.disabled = true;
            Promise.resolve(opts.onSubmit(v)).then(function (r) {
                if (r === true || r == null) close(v);
                else fail(String(r));
            }, function (e) { fail(String((e && e.message) || e)); });
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); close(null); }
            else if (e.key === 'Tab') {
                var f = $$('button,input,select,textarea,[href]', dlg)
                        .filter(function (n) { return !n.disabled; });
                if (!f.length) return;
                var first = f[0], last = f[f.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            } else if (e.key === 'Enter' && input && document.activeElement === input) {
                e.preventDefault(); submit();
            }
        }
        cancel.addEventListener('click', function () { close(null); });
        okBtn.addEventListener('click', submit);
        veil.addEventListener('mousedown', function (e) { if (e.target === veil) close(null); });
        document.addEventListener('keydown', onKey, true);
        setTimeout(function () { (input || okBtn).focus(); }, 40);
    });
}
/* okText names the action being authorised ("Restart", "Delete") — a confirm
   button that says what happens beats a generic "Authorise". danger paints it
   red for destructive actions, matching the button that opened the dialog. */
/* Confirmation, not authentication. The console is unauthenticated by design
   (see the README's security model): it is reachable only from the trusted LAN,
   where the firewall — not a password field — is what keeps other people out.
   These dialogs exist so a consequential action states its consequence first;
   they guard against a misclick, not against an intruder.
   Resolves true when confirmed, null when dismissed. */
function askConfirm(title, body, okText, danger) {
    return dialog({
        title: title, body: body, okText: okText || 'Confirm', danger: !!danger
    });
}

/* ------------------------------------------------------------- transport -- */
/* Ages the last successful poll into one of four states. Panels dim from
   'stale' upward. 'sync' is the brief moment a request is in flight. */
var TP = { LIVE: 'live', SYNC: 'sync', STALE: 'stale', OFF: 'offline' };

function Transport(url, onData, opts) {
    opts = opts || {};
    var base = opts.interval || 5000;
    var self = this;
    var timer = null, inflight = null, fails = 0, lastOk = 0, stopped = false;

    this.lastData = null;

    function setState(s, detail) {
        $$('.tp').forEach(function (n) {
            n.setAttribute('data-tp', s);
            var lbl = $('.tp__x', n);
            if (lbl) lbl.textContent = detail || s;
        });
        var m = $('.main');
        if (m) m.setAttribute('data-stale', (s === TP.STALE || s === TP.OFF) ? '1' : '0');
    }
    this.setState = setState;

    function age() { return lastOk ? Math.round((Date.now() - lastOk) / 1000) : 0; }

    function tick() {
        if (stopped || document.visibilityState !== 'visible' || inflight) return;
        var ctl = ('AbortController' in global) ? new AbortController() : null;
        inflight = ctl || true;
        var killed = false;
        var killer = setTimeout(function () {
            killed = true;
            if (ctl) ctl.abort();
        }, opts.timeout || 9000);
        if (lastOk) setState(TP.SYNC, 'sync');

        fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (j) {
                clearTimeout(killer); inflight = null; fails = 0; lastOk = Date.now();
                self.lastData = j;
                setState(TP.LIVE, 'live');
                try { onData(j); } catch (e) {
                    if (global.console) console.error('render', e);
                }
                schedule(base);
            })
            .catch(function (e) {
                clearTimeout(killer); inflight = null; fails++;
                var a = age();
                if (fails >= 3 || !lastOk) setState(TP.OFF, 'no link');
                else setState(TP.STALE, a + 's old');
                if (opts.onError) opts.onError(killed ? 'timeout' : String(e.message || e), fails);
                /* back off: 5s -> 10 -> 20 -> 30 cap. A router that is busy
                   rebooting a radio should not also be answering a poll storm. */
                schedule(Math.min(base * Math.pow(2, fails), 30000));
            });
    }
    function schedule(ms) {
        clearTimeout(timer);
        if (!stopped) timer = setTimeout(tick, ms);
    }

    /* Age the label between polls so "stale" is honest even while idle. */
    setInterval(function () {
        if (stopped || !lastOk || inflight) return;
        var a = age();
        if (a > (base / 1000) * 3) setState(TP.STALE, a + 's old');
    }, 2000);

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { clearTimeout(timer); tick(); }
        else clearTimeout(timer);
    });

    this.refresh = function (delay) { clearTimeout(timer); timer = setTimeout(tick, delay || 60); };
    this.stop = function () { stopped = true; clearTimeout(timer); };
    this.start = function () { stopped = false; tick(); };
    this.age = age;
}

/* POST helper. Every write in this console is a POST — the APIs reject writes
   over GET, which is what closes the CSRF-by-link hole. */
function post(url, params) {
    var body = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(params[k] == null ? '' : params[k]);
    }).join('&');
    var ctl = ('AbortController' in global) ? new AbortController() : null;
    var killer = setTimeout(function () { if (ctl) ctl.abort(); }, 25000);
    return fetch(url, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body, signal: ctl ? ctl.signal : undefined
    }).then(function (r) { clearTimeout(killer); return r.json(); })
      .catch(function (e) {
          clearTimeout(killer);
          return { ok: false, error: /abort/i.test(String(e)) ? 'timed out' : 'could not reach the router' };
      });
}

/* Run a write with full lifecycle feedback: busy -> toast -> refresh.
   Centralised so no page can forget a state. */
function act(btn, url, params, opts) {
    opts = opts || {};
    var label = btn ? btn.textContent : '';
    if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
    return post(url, params).then(function (j) {
        if (btn) { btn.classList.remove('is-busy'); btn.disabled = false; btn.textContent = label; }
        if (j && j.ok) {
            if (opts.ok !== false) toast(opts.ok || 'Done.', 'ok');
            if (opts.refresh !== false && global.OS.tp) global.OS.tp.refresh(opts.delay || 700);
        } else {
            toast((opts.failPrefix || 'Failed') + ': ' + ((j && j.error) || 'unknown error'), 'bad');
        }
        return j;
    });
}

/* ------------------------------------------------------- stale page check --- */
/* Rewritten by bump-assets.sh. Hashed over os.css, os.js AND every page, so a
   change confined to one page's inline script moves it — that being the whole
   point, and the change class that produced two wasted debugging sessions. */
var CONSOLE_VERSION = 'c5837a540b';

/* WHY THIS EXISTS AT ALL. bump-assets.sh versions the os.css and os.js URLs
   inside a page, so a changed asset can never be served stale. Nothing versions
   the page. uhttpd sends no Cache-Control, so a browser applies heuristic
   freshness — roughly a tenth of the file's age — and a page untouched for a
   month can be served from cache for days after the router starts serving a new
   one. Measured on this router, not reasoned: a page aged 30 days and then
   changed was still returned stale by a plain fetch.

   And a stale page poisons everything downstream, because it carries the OLD
   asset references: the page and its assets go stale together, which is exactly
   why the stamping mechanism cannot rescue this case. Reaching /dashboard/ from
   a bookmark — the ordinary way in — bypasses every link that mechanism touches.

   ONCE, AT LOAD. Not on the poll. The failure being caught is "the page I just
   opened is stale", which is entirely observable at load; watching for a deploy
   that happens mid-session is a different and far less valuable feature, and
   buying it would cost a request every few seconds forever. A prompt that
   reappears after being dismissed is worse than no prompt. */
function checkStale() {
    if (!CONSOLE_VERSION || CONSOLE_VERSION === 'dev') return;   /* unstamped tree */
    fetch('/cgi-bin/version-api', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
            if (!j || !j.ok || !j.v || j.v === CONSOLE_VERSION) return;
            var n = note('This page is an old copy held by your browser — the router is ' +
                'serving a newer one. Nothing here is wrong, it is just out of date.', 'warn');
            var b = el('button', 'btn btn--sm', 'Reload');
            b.style.marginLeft = 'auto';
            b.addEventListener('click', function () {
                b.disabled = true;
                /* Priming the HTTP cache first, THEN reloading. A plain reload
                   was measured to fetch fresh content on this engine, so the
                   second call alone would do — but "measured on one engine" is
                   not "true everywhere", and a Reload button that reloads the
                   same stale page would be the `/etc/init.d/firewall start`
                   trap in a new costume: a remedy that silently does nothing.
                   cache:'reload' was measured to bypass the cache AND replace
                   the stored entry, so the reload after it cannot lose. */
                fetch(location.href, { cache: 'reload' })
                    .catch(function () {})
                    .then(function () { location.reload(); });
            });
            n.appendChild(b);
            n.style.marginBottom = '12px';
            var host = $('#alerts') || $('.main');
            if (host) host.insertBefore(n, host.firstChild);
        })
        .catch(function () { /* an older router has no endpoint: say nothing */ });
}

/* --------------------------------------------------- the firewall alarm --- */
/* Shared because two pages can reach the same condition: the Overview detects it
   device-wide, and the VPN page's "no IPv6 protection" resolves to the same
   cause. One implementation so the wording and the remedy cannot drift apart.

   The remedy is a BUTTON, not an SSH command, and that is the whole point. This
   is a travel router; it exists to be operable from a phone in a hotel room,
   which is exactly why apwatch exists — "with only a phone has no way in: no AP,
   no dashboard, no SSH". A remedy that needs a terminal is not a remedy in the
   situation the device is for. The SSH line stays underneath for whoever does
   have a laptop; demoting it is the change, not removing it.

   Handing this action to whoever can reach the console is safe in a way almost
   nothing else is: it RESTORES filtering, so an attacker who presses it locks
   themselves out, and in this state every other write the console offers is
   equally reachable and strictly more dangerous. */
function firewallAlert(onDone) {
    var wrap = el('div');
    var n = note('No firewall is loaded. Nothing on this router is being filtered, and this ' +
        'console has no login — anything that can reach the router can read it and change ' +
        'its settings.', 'bad');
    wrap.appendChild(n);

    var row = el('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0 0 30px';
    var b = el('button', 'btn btn--sm btn--danger', 'Restart the firewall');
    b.addEventListener('click', function () {
        dialog({
            title: 'Restart the firewall',
            body: 'This reloads the firewall ruleset. Connections in flight may drop for a ' +
                  'moment. It cannot make things less safe than they are now — right now ' +
                  'nothing is being filtered at all.',
            okText: 'Restart'
        }).then(function (go) {
            if (!go) return;
            act(b, '/cgi-bin/settings-api', { action: 'fwrestart' }, {
                ok: 'Firewall reloaded. Filtering is back on.',
                failPrefix: 'Could not reload it'
            }).then(function (j) {
                if (j && j.ok && typeof onDone === 'function') onDone();
            });
        });
    });
    row.appendChild(b);

    /* Kept, deliberately demoted. Someone with a laptop should still be told the
       exact command — and `restart`, never `start`: after a failed boot-time
       load procd already considers the service started, so `start` replies "The
       fw4 firewall appears to be already loaded." and exits 0 while the ruleset
       stays empty. */
    var hint = el('div', null, 'Over SSH instead:  /etc/init.d/firewall restart');
    hint.style.cssText = 'font:400 12px/1.5 var(--mono,monospace);opacity:.65';
    row.appendChild(hint);

    wrap.appendChild(row);
    return wrap;
}

/* ----------------------------------------------------------- navigation --- */
/* Stage order is the path a packet takes. The nav is the topology.            */
/* Internet and Router are omitted deliberately: the Overview topology already
   draws both, and repeating them here made the rail a second, worse copy of the
   drawing. What remains is navigation in the SAME order as the mobile tab bar,
   with Wi-Fi in / USB in as branch stubs under Uplink — they are alternative
   feeds into it, not peers of it. */
/* `static` is what the row says when the current page cannot measure that
   stage. It shares a column with live values, so it uses the SAME sentence
   casing — mixing lowercase descriptors with sentence-case values made one
   column look like two conventions. A page must never write a lookalike
   descriptor here: either it knows the value or it leaves the static. */
/* Nav labels are IDENTICAL to the page <h1> and <title> they lead to, and the
   branch descriptors are the same sentences the Internet sources panel uses for
   the same two sources. One thing, one name, wherever it appears. */
var STAGES = [
    { id: 'clients',  k: 'Overview',     href: '/dashboard/', icon: 'overview', static: 'Connected devices' },
    { id: 'routing',  k: 'VPN',          href: '/vpn/',       icon: 'routing',  static: 'Tunnels and routing' },
    { id: 'source',   k: 'Uplink',       href: null,          icon: 'eth',      static: 'Active source' },
    { id: 'repeater', k: 'Wi-Fi uplink', href: '/repeater/',  icon: 'wifi',     static: 'Someone else’s Wi-Fi',  branch: true },
    { id: 'tether',   k: 'USB uplink',   href: '/tethering/', icon: 'usb',      static: 'Phone or modem on USB', branch: true }
];
var MTABS = [
    { href: '/dashboard/',  icon: 'overview', label: 'Overview' },
    { href: '/vpn/',        icon: 'routing',  label: 'VPN' },
    { href: '/repeater/',   icon: 'wifi',     label: 'Wi-Fi uplink' },
    { href: '/tethering/',  icon: 'usb',      label: 'USB uplink' }
];

var spineNodes = {};

function buildShell(activeHref) {
    /* spine */
    var sp = $('.spine');
    if (sp) {
        var brand = el('div', 'brand'), mk = el('div', 'brand__mark');
        mk.appendChild(gem());
        mk.appendChild(el('div', 'brand__name', 'Beryl 7'));
        brand.appendChild(mk);
        brand.appendChild(el('div', 'brand__sub', 'network console'));
        sp.appendChild(brand);

        var path = el('nav', 'path');
        path.setAttribute('aria-label', 'Network path');
        STAGES.forEach(function (s) {
            var n = el(s.href ? 'a' : 'div', 'pnode' + (s.branch ? ' pnode--branch' : ''));
            if (s.branch) n.appendChild(el('i', 'pnode__stub'));
            if (s.href) {
                n.href = s.href;
                if (s.href === activeHref) {
                    n.className += ' is-active';
                    n.setAttribute('aria-current', 'page');
                }
            }
            n.appendChild(el('i', 'pnode__dot'));
            n.appendChild(el('div', 'pnode__k', s.k));
            var v = el('div', 'pnode__v', s.static);
            n.appendChild(v);
            spineNodes[s.id] = { node: n, val: v };
            path.appendChild(n);
        });
        sp.appendChild(path);

        var foot = el('div', 'spine__foot');
        foot.appendChild(transportEl());
        var ab = accentPicker(); ab.classList.add('push');
        foot.appendChild(ab);
        foot.appendChild(themeBtn());
        foot.appendChild(settingsBtn(activeHref));
        sp.appendChild(foot);
    }

    /* mobile: sticky top line + bottom tabs */
    var tl = $('.topline');
    if (tl) {
        var mk2 = el('div', 'brand__mark');
        mk2.appendChild(gem());
        mk2.appendChild(el('div', 'brand__name', 'Beryl 7'));
        tl.appendChild(mk2);
        var sp2 = el('div'); sp2.className = 'push';
        tl.appendChild(sp2);
        tl.appendChild(transportEl());
        tl.appendChild(accentPicker());
        tl.appendChild(themeBtn());
        tl.appendChild(settingsBtn(activeHref));
    }
    var mb = $('.mobilebar');
    if (mb) {
        MTABS.forEach(function (t) {
            var a = el('a', 'mtab' + (t.href === activeHref ? ' is-active' : ''));
            a.href = t.href;
            if (t.href === activeHref) a.setAttribute('aria-current', 'page');
            a.appendChild(icon(t.icon));
            a.appendChild(el('span', null, t.label));
            mb.appendChild(a);
        });
    }

    /* Every page calls buildShell exactly once at load, which is precisely the
       moment and the frequency this check wants — so it hooks here rather than
       asking five pages to remember to call it. */
    checkStale();
}
function transportEl() {
    var t = el('div', 'tp');
    t.setAttribute('data-tp', 'sync');
    t.setAttribute('title', 'Live data status');
    t.appendChild(el('i', 'tp__led'));
    t.appendChild(el('span', 'tp__x', 'connecting'));
    return t;
}
/* Settings lives beside the theme toggle — a system control, not a fifth
   section, so it is absent from the topology rail and the mobile tab bar. */
function settingsBtn(activeHref) {
    var a = el('a', 'iconbtn' + (activeHref === '/settings/' ? ' is-active' : ''));
    a.href = '/settings/';
    a.title = 'Settings';
    a.setAttribute('aria-label', 'Settings');
    if (activeHref === '/settings/') a.setAttribute('aria-current', 'page');
    a.appendChild(icon('sliders'));
    return a;
}
/* Accent picker. `key` is the data-accent value; green is the default and is
   represented by the ATTRIBUTE BEING ABSENT, so it stays the zero-config case.
   Labels are the plain colour names, not the internal token names. */
var ACCENTS = [
    { key: 'maroon', label: 'Red',   sw: 'red' },
    { key: '',       label: 'Green', sw: 'green' },
    { key: 'navy',   label: 'Blue',  sw: 'blue' },
    { key: 'grey',   label: 'Grey',  sw: 'grey' }
];
/* painter's palette; the wells carry var(--sig) so the closed button still
   shows which accent is live */
var PALETTE = '<svg viewBox="0 0 20 20">' +
    '<path d="M10 3.2c-3.8 0-6.8 2.9-6.8 6.6s3 6.6 6.8 6.6c.85 0 1.45-.6 1.45-1.4 0-.38-.14-.7-.38-.94' +
    '-.24-.26-.38-.58-.38-.94 0-.78.63-1.4 1.4-1.4h1.15c2.06 0 3.73-1.62 3.73-3.62 0-3.05-3.1-4.9-7-4.9z"/>' +
    '<circle cx="6.5" cy="9.5" r=".95" fill="var(--sig)" stroke="none"/>' +
    '<circle cx="8.9" cy="6.8" r=".95" fill="var(--sig)" stroke="none"/>' +
    '<circle cx="12.4" cy="7.4" r=".95" fill="var(--sig)" stroke="none"/></svg>';

function applyAccent(key) {
    if (key) document.documentElement.setAttribute('data-accent', key);
    else document.documentElement.removeAttribute('data-accent');
    try { localStorage.setItem('beryl-accent', key || 'mint'); } catch (e) {}
}

function accentPicker() {
    var wrap = el('div', 'accent');
    var btn = el('button', 'iconbtn');
    btn.type = 'button';
    btn.title = 'Accent colour';
    btn.setAttribute('aria-label', 'Accent colour');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(svg(PALETTE));
    wrap.appendChild(btn);

    var pop = el('div', 'accent__pop');
    pop.setAttribute('role', 'menu');
    pop.hidden = true;
    var opts = [];
    ACCENTS.forEach(function (a) {
        var o = el('button', 'accent__opt');
        o.type = 'button';
        o.setAttribute('role', 'menuitemradio');
        o.appendChild(el('i', 'accent__sw accent__sw--' + a.sw));
        o.appendChild(el('span', null, a.label));
        var tk = icon('check');
        tk.setAttribute('class', 'tick');
        o.appendChild(tk);
        o.addEventListener('click', function () { applyAccent(a.key); mark(); close(true); });
        opts.push({ el: o, key: a.key });
        pop.appendChild(o);
    });
    wrap.appendChild(pop);

    /* Read the live attribute rather than tracking state: both the rail and the
       topline build a picker, so each must reflect changes made in the other. */
    function mark() {
        var cur = document.documentElement.getAttribute('data-accent') || '';
        opts.forEach(function (o) {
            o.el.setAttribute('aria-checked', o.key === cur ? 'true' : 'false');
        });
    }
    function onDoc(e) { if (!wrap.contains(e.target)) close(false); }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(true); }
    }
    function open() {
        mark();
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        var sel = opts.filter(function (o) {
            return o.el.getAttribute('aria-checked') === 'true';
        })[0];
        (sel || opts[0]).el.focus();
    }
    function close(refocus) {
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
        if (refocus) btn.focus();
    }
    btn.addEventListener('click', function () {
        if (pop.hidden) open(); else close(true);
    });
    return wrap;
}
function themeBtn() {
    var b = el('button', 'iconbtn');
    b.type = 'button';
    b.setAttribute('aria-label', 'Toggle light or dark theme');
    b.appendChild(svg('<svg class="moon" viewBox="0 0 20 20"><path d="M17 10.7A7.5 7.5 0 1 1 9.3 3a5.8 5.8 0 0 0 7.7 7.7z"/></svg>'));
    b.appendChild(svg('<svg class="sun" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v2M10 16v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M2 10h2M16 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4"/></svg>'));
    b.addEventListener('click', function () {
        var cur = document.documentElement.getAttribute('data-theme');
        if (!cur) cur = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        var next = cur === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('beryl-theme', next); } catch (e) {}
    });
    return b;
}
/* On a phone the page action belongs to the thing it acts on, not to a banner
   floating above it — so Add tunnel / Scan move into the header row of the
   first panel and the empty page header collapses. Moves back on a wide
   screen, and re-runs on breakpoint changes so a rotation lands correctly.
   The slot must be a node the page never clears: two of these panels rebuild
   their whole aside on every poll, which would take the button with it. */
function dockAction(slotSel) {
    var home = $('.head__aside');
    var btn = home && $('.btn', home);
    var slot = $(slotSel);
    if (!home || !btn || !slot) return;
    var mq = matchMedia('(max-width: 900px)');
    /* the header row aligns on the text baseline, which drops a filled button
       below the title — centre it only while a button is actually in there */
    var ph = slot.closest ? slot.closest('.panel__h') : null;
    function place() {
        if (mq.matches) {
            if (btn.parentNode !== slot) slot.appendChild(btn);
            home.classList.add('is-docked');
        } else {
            if (btn.parentNode !== home) home.appendChild(btn);
            home.classList.remove('is-docked');
        }
        if (ph) {
            if (mq.matches) ph.classList.add('panel__h--act');
            else ph.classList.remove('panel__h--act');
        }
    }
    place();
    if (mq.addEventListener) mq.addEventListener('change', place);
}

/* Set a spine stage's live value and state: 'live' | 'warn' | 'fault' | ''. */
/* The VPN line in the navigation. It used to read "Direct" whenever no device
   was routed, which is the router's normal resting state - so the one word the
   owner saw most often told him nothing, while two tunnels sat connected a few
   pixels away. It now states both facts it has: how many tunnels are actually
   handshaking, and how many devices are riding them.

   Both pages call this so they cannot word it differently; they disagreed
   before, because only the VPN page knew the tunnel count. */
function routingLabel(tunUp, tunTotal, routed) {
    if (!tunTotal) return 'No tunnels';
    var t = (tunUp === tunTotal)
        ? tunUp + (tunUp === 1 ? ' tunnel' : ' tunnels')
        : tunUp + ' of ' + tunTotal + ' tunnels';
    return t + ' \u00b7 ' + (routed ? routed + ' routed' : 'none routed');
}
function stage(id, value, state) {
    var s = spineNodes[id];
    if (!s) return;
    if (value != null) setTxt(s.val, value);
    s.node.setAttribute('data-state', state || '');
}
/* Mobile tabs cannot show a subtitle, so an attention dot carries urgency. */
function flagTab(href, on) {
    var a = $$('.mtab').filter(function (n) { return n.getAttribute('href') === href; })[0];
    if (!a) return;
    var d = $('.mtab__dot', a);
    if (on && !d) a.appendChild(el('i', 'mtab__dot'));
    else if (!on && d) d.parentNode.removeChild(d);
}

/* ===========================================================================
   INSTRUMENTS — the parts that make this a console rather than a dashboard.
   Each one plots a value against its own calibrated axis, because position
   communicates judgement and a bare number does not.
   ======================================================================== */

var NS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    /* Every flow path in the console is built here, so phase-aligning at the
       factory covers all of them — the topology, the VPN map, and anything
       added later — instead of relying on ten call sites remembering to. */
    if (attrs && (' ' + (attrs['class'] || '') + ' ').indexOf(' flow ') >= 0) {
        n.style.animationDelay = flowPhase();
    }
    return n;
}
function svtext(x, y, str, cls, anchor) {
    var t = sv('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'start' });
    t.textContent = str;
    return t;
}

/* The GL.iNet wordmark, as shipped by GL.iNet.
   ONE copy, filled with currentColor, rather than the two files it arrived as.
   The light and dark originals differ only in fill (#636363 and #fff), which
   is precisely what a colour token already expresses — and a second file would
   have to be swapped by script on every theme change, including the moment the
   OS preference flips while the page is open. */
function gem() {
    return svg('<svg class="brand__gem" viewBox="131 325.5 562.1 160.4" ' +
        'fill="currentColor" role="img" aria-label="GL.iNet">' +
        '<path d="M219.5,429.3H182c-0.6,0-1,0.4-1,1v13.5c0,0.6,0.4,1,1,1h19.6V468c-3.3,1-8.5,1.6-14.5,1.6' +
        'c-22.3,0-36.2-13.5-36.2-35.1s14.5-35,37.8-35c10.6,0,16.9,2,21.3,3.8l2.1,0.9c0.3,0.1,0.5,0.1,0.8,0' +
        's0.4-0.3,0.5-0.6l4.3-13.5c0.2-0.5-0.1-1-0.5-1.2l-1.6-0.7c-5-2.2-14.6-4.6-26.6-4.6c-34.5,0-57.9,20.7-58,51.5' +
        'c0,15,5.5,28.6,15.1,37.2c10,8.9,23.1,13.2,40,13.2c13.4,0,24.9-2.9,32.2-5.3l1.3-0.4c0.4-0.1,0.7-0.5,0.7-0.9v-48.5' +
        'C220.5,429.7,220.1,429.3,219.5,429.3z"/>' +
        '<path d="M317.4,468.5H275v-83c0-0.6-0.4-1-1-1h-17.2c-0.6,0-1,0.4-1,1v97.9c0,0.6,0.4,1,1,1h60.6c0.6,0,1-0.4,1-1v-14' +
        'C318.4,469,318,468.5,317.4,468.5z"/>' +
        '<path d="M417.8,375.5c-5.9,0-10.3,4.4-10.3,10.3c0,5.8,4.3,10.2,10,10.2c3.1,0,5.9-1.1,7.8-3.1' +
        'c1.8-1.9,2.8-4.4,2.7-7.1C427.9,379.8,423.6,375.5,417.8,375.5z"/>' +
        '<path d="M426.4,411.1h-17.3c-0.6,0-1,0.4-1,1v71.4c0,0.6,0.4,1,1,1h17.3c0.6,0,1-0.4,1-1v-71.4' +
        'C427.4,411.5,427,411.1,426.4,411.1z"/>' +
        '<path d="M536.4,384.6H520c-0.6,0-1,0.4-1,1v41.3c0,8,0.1,16.6,0.5,25.7c-3.5-6.1-7.5-12.4-12-19L474.4,385' +
        'c-0.2-0.3-0.5-0.4-0.8-0.4h-17.5c-0.6,0-1,0.4-1,1v97.9c0,0.6,0.4,1,1,1h16.4c0.6,0,1-0.4,1-1v-42.1' +
        'c0-10.5-0.1-19-0.4-26.9c3.6,6.2,8,13.1,13.3,20.9l32.8,48.7c0.2,0.3,0.5,0.4,0.8,0.4h16.4c0.6,0,1-0.4,1-1v-97.9' +
        'C537.4,385,537,384.6,536.4,384.6z"/>' +
        '<path d="M597.1,409.6c-21.9,0-37.2,16.2-37.2,39.3c0,22.5,15.3,37,38.9,37c12.3,0,20.7-2.4,25.5-4.4l1.5-0.6' +
        'c0.5-0.2,0.7-0.7,0.6-1.2l-3.2-12.5c-0.1-0.3-0.3-0.5-0.5-0.6c-0.3-0.1-0.6-0.1-0.8,0l-2.2,0.9' +
        'c-4.3,1.7-9.6,3.3-19,3.3c-6,0-20-1.8-21.8-17.7h49.8c0.5,0,0.9-0.4,1-0.9l0.3-2.2c0.2-1.3,0.4-3.1,0.4-5.5' +
        'C630.3,428.3,621.6,409.6,597.1,409.6z M579.4,438.3c1.2-4.5,5.2-14.2,16.7-14.2c4.4,0,8,1.2,10.5,3.6' +
        'c3.3,3.1,4.4,7.6,4.7,10.6H579.4z"/>' +
        '<path d="M692,411.1h-18v-19c0-0.3-0.1-0.6-0.4-0.8c-0.2-0.2-0.6-0.3-0.9-0.2l-17,4.2c-0.4,0.1-0.8,0.5-0.8,1v14.8h-10.3' +
        'c-0.6,0-1,0.4-1,1v13.1c0,0.6,0.4,1,1,1H655v34c0,9.4,1.9,15.7,5.9,19.5c3.8,4,9.5,6.1,16.6,6.1' +
        'c5.1,0,9.7-0.7,12.9-1.9l1.3-0.5c0.4-0.2,0.7-0.6,0.6-1l-0.8-12.9c0-0.3-0.2-0.6-0.4-0.7c-0.2-0.2-0.5-0.2-0.8-0.2' +
        'l-2.4,0.6c-1.3,0.3-3.6,0.7-6.9,0.7c-3.5,0-6.9-0.8-6.9-10.3V426h18c0.6,0,1-0.4,1-1v-13.1' +
        'C693,411.5,692.5,411.1,692,411.1z"/>' +
        '<circle cx="357.2" cy="435.3" r="10.6"/>' +
        '<path d="M461.1,341.9c1.3-1.3,1-3.4-0.6-4.3l-1.9-1.1c-12.4-7.2-26.6-11-40.9-11c-14.4,0-28.5,3.8-41,11l-1.8,1.1' +
        'c-1.6,0.9-1.9,3.1-0.6,4.3l5.8,5.8c0.9,0.9,2.3,1.1,3.3,0.4c10.4-6,22.2-9.2,34.2-9.2s23.8,3.2,34.2,9.2h0.1' +
        'c1.1,0.6,2.5,0.4,3.3-0.4L461.1,341.9z"/>' +
        '<path d="M442.9,355.7c-7.7-4.2-16.4-6.5-25.3-6.5c-8.8,0-17.5,2.2-25.2,6.4c-0.7,0.4-1.2,1.2-1.3,2' +
        'c0,0.6,0.2,1.3,0.6,1.7l6.4,6.4c0.8,0.8,2.1,1.1,3.1,0.6c5.1-2.4,10.7-3.6,16.3-3.6c5.7,0,11.3,1.3,16.4,3.6' +
        'c1.1,0.5,2.3,0.2,3.1-0.6l6.2-6.2c0.5-0.5,0.7-1.2,0.7-1.9v-0.2C444,356.8,443.6,356.1,442.9,355.7z"/>' +
        '</svg>');
}

/* Wi-Fi quality, expressed the way an operator says it out loud. Thresholds
   are the ones that actually change rate selection, not a linear split. */
function quality(dbm) {
    if (dbm == null || dbm === 0) return { word: 'NO SIGNAL', tone: 'idle', f: 0 };
    if (dbm >= -55) return { word: 'EXCELLENT', tone: 'ok',   f: 1 };
    if (dbm >= -67) return { word: 'GOOD',      tone: 'fair', f: .72 };
    if (dbm >= -75) return { word: 'WEAK',      tone: 'warn', f: .45 };
    return                 { word: 'POOR',      tone: 'bad',  f: .2 };
}
function stateWord(text, tone) {
    return el('span', 'sw' + (tone ? ' sw--' + tone : ''), text);
}

/* A value on its axis. ticks[] mark the thresholds worth knowing, so the eye
   reads "past the good line" instead of decoding a percentage. */
function scale(val, min, max, ticks, tone, small) {
    var s = el('div', 'scale' + (small ? ' scale--sm' : ''));
    s.appendChild(el('i', 'scale__track'));
    s._fill = el('i', 'scale__fill');
    s.appendChild(s._fill);
    (ticks || []).forEach(function (t) {
        var p = (t - min) / (max - min);
        if (p < 0 || p > 1) return;
        var k = el('i', 'scale__tick'); k.style.left = (p * 100) + '%';
        s.appendChild(k);
    });
    s._m = el('i', 'scale__m');
    s.appendChild(s._m);
    s._min = min; s._max = max;
    scaleSet(s, val, tone);
    return s;
}
/* Move an existing scale to a new value. THIS is what makes the 400ms
   transitions in os.css run: the fill and the marker keep their previous
   computed width/left, so the browser has something to interpolate from.
   min/max are remembered from the build so a caller cannot silently rescale
   the axis under a needle that is mid-flight. */
function scaleSet(s, val, tone) {
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
    var pct = Math.max(0, Math.min(1, (val - s._min) / (s._max - s._min))) * 100;
    s._fill.style.width = pct + '%';
    s._m.style.left = pct + '%';
}
/* RSSI is the number everyone misreads, so it gets a named helper with the
   quality boundaries drawn on the rule itself. */
function rssiClamp(dbm) { return Math.max(-90, Math.min(-20, dbm || -90)); }
/* Four dividers, so the rule reads as five sections at a glance.
   They are placed EVENLY across the axis rather than on the quality
   thresholds (-75/-67/-55) the earlier version marked: those three carried
   meaning but sat bunched in the weak half, which is what made the bar hard
   to read. The meaning has not been lost - it moved to the fill COLOUR, which
   still switches on exactly those thresholds via quality(). */
function rssiScale(dbm, small) {
    return scale(rssiClamp(dbm), -90, -20, [-76, -62, -48, -34], quality(dbm).tone, small);
}
function rssiScaleSet(s, dbm) { scaleSet(s, rssiClamp(dbm), quality(dbm).tone); }

/* SPECTRUM — the occupied band drawn at true centre and true width on the
   real channel axis. The difference between being told "channel 40, EHT160"
   and seeing that it covers a third of the 5 GHz band. */
var BANDS = {
    '2g': { lo: 2390, hi: 2500, chans: [1, 6, 11, 13],
            f: function (c) { return 2407 + 5 * c; } },
    '5g': { lo: 5150, hi: 5900, chans: [36, 64, 100, 132, 165],
            f: function (c) { return 5000 + 5 * c; } }
};
function spectrum(band, chan, centerChan, widthMHz, h) {
    /* The plot SVG stretches to the container (preserveAspectRatio:none), which
       distorts anything drawn inside it that has an aspect ratio of its own —
       the MHz and channel labels came out visibly squashed. So the SVG carries
       only geometry (axis, ticks, band) and every label is real HTML anchored
       by percentage, which never deforms. */
    h = h || 42;
    var B = BANDS[band === '5g' ? '5g' : '2g'];
    var plotH = h - 13;
    var wrap = el('div', 'specwrap');
    wrap.style.height = h + 'px';

    var s = sv('svg', { viewBox: '0 0 300 ' + plotH, 'class': 'spec',
                        preserveAspectRatio: 'none' });
    s.style.cssText = 'width:100%;height:' + plotH + 'px;display:block';
    function pct(mhz) { return (mhz - B.lo) / (B.hi - B.lo) * 100; }
    function xv(mhz) { return 2 + (mhz - B.lo) / (B.hi - B.lo) * 296; }

    s.appendChild(sv('line', { 'class': 'axis', x1: 2, x2: 298, y1: plotH - 1, y2: plotH - 1 }));
    B.chans.forEach(function (c) {
        var px = xv(B.f(c));
        s.appendChild(sv('line', { 'class': 'tick', x1: px, x2: px, y1: plotH - 5, y2: plotH - 1 }));
    });
    var centre = B.f(centerChan || chan);
    var w = widthMHz || 20;
    var x1 = xv(centre - w / 2), x2 = xv(centre + w / 2);
    s.appendChild(sv('rect', { 'class': 'band', x: Math.min(x1, x2), y: 4,
                               width: Math.max(3, Math.abs(x2 - x1)),
                               height: plotH - 5, rx: 1 }));
    wrap.appendChild(s);

    B.chans.forEach(function (c) {
        var t = el('span', 'spec-lab', String(c));
        t.style.left = pct(B.f(c)) + '%';
        wrap.appendChild(t);
    });
    var mhzLab = el('span', 'spec-mhz', w + ' MHz');
    mhzLab.style.left = Math.max(9, Math.min(91, pct(centre))) + '%';
    wrap.appendChild(mhzLab);
    return wrap;
}

/* TOPOLOGY — a drawn network, not columns of text. Left is outside the house,
   right is inside it. The marching dash carries "traffic is moving"; the VPN
   is drawn as what it really is — a second path from the router back to the
   internet that bypasses the uplink node. */
/* Vertical topology — the phone composition of the same drawing. Identical
   node/link/flow vocabulary; the chain simply runs down the page:
   Internet / Uplink / Router / radio lanes / VPN, with the VPN bypass drawn
   up the left margin back to the Internet node. */
function topologyV(m) {
    /* Phone composition of the same drawing, built to be short: each node's
       caption sits INSIDE the box as a label column instead of claiming its own
       line above it, which removes a whole line per node, and every metric is
       tightened. Same nodes, same links, same flow — about a third less height,
       so the clients list starts that much sooner. */
    var W = 360, LX = 34, NW = W - LX - 14, BH = 34, GAP = 10, LANE = 19, LBL = 96;
    var lanes = m.lanes || [];
    var lanesH = lanes.length ? lanes.length * LANE + 8 : 0;
    var vpnH = m.vpn ? GAP + BH : 0;
    var H = BH * 3 + GAP * 2 + (lanesH ? 6 + lanesH : 0) + vpnH + 6;
    var s = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'topo',
                        preserveAspectRatio: 'xMidYMin meet' });
    s.style.width = '100%';
    s.style.height = 'auto';
    var cx = LX + 20, y = 0;

    function block(cap, capOn, t1, t2, cls) {
        /* The caption is ALWAYS on the box's centre line, whatever the value
           column holds beside it. The value column centres too: one line sits
           on the same centre, two lines straddle it at 14/27 (midpoint 20.5).
           Previously the caption inherited the value's first baseline, so on a
           two-line node it rode up level with the top line and read as
           top-aligned next to the single-line nodes above and below it. */
        var yc = y + 21;
        var yv = t2 ? y + 14 : yc;
        s.appendChild(sv('rect', { 'class': 'nodebox ' + (cls || ''),
            x: LX, y: y, width: NW, height: BH, rx: 2 }));
        s.appendChild(svtext(LX + 12, yc, cap, 'cap' + (capOn ? ' capon' : '')));
        s.appendChild(svtext(LX + LBL, yv, t1, 't1'));
        if (t2) s.appendChild(svtext(LX + LBL, y + 27, t2, 't2'));
        var out = { top: y, mid: y + BH / 2, bot: y + BH };
        y += BH;
        return out;
    }
    function connect(y1, y2, on, flow) {
        s.appendChild(sv('path', { 'class': 'link ' + (on ? 'on' : 'off'),
                                   d: 'M' + cx + ' ' + y1 + ' V' + y2 }));
        if (flow) s.appendChild(sv('path', { 'class': 'flow',
                                   d: 'M' + cx + ' ' + y1 + ' V' + y2 }));
    }

    var a = block('Internet', m.online, m.online ? 'Reachable' : 'No route',
                  m.latency, m.online ? 'on' : 'bad');
    y += GAP; connect(a.bot, y, m.online, m.flowing);
    var b = block('Uplink', m.online, m.uplink, m.uplinkSub, m.online ? 'on' : '');
    y += GAP; connect(b.bot, y, m.online, m.flowing);
    var c = block('Router', true, m.router, m.routerSub, 'on');

    if (lanes.length) {
        y += 6;
        var lastLy = 0;
        lanes.forEach(function (L, i) {
            var ly = y + 10 + i * LANE;
            lastLy = ly;
            s.appendChild(sv('path', { 'class': 'link ' + (L.clients ? 'on' : 'off'),
                d: 'M' + cx + ' ' + ly + ' H' + (cx + 16) }));
            s.appendChild(svtext(cx + 24, ly + 4, L.name, 't1'));
            s.appendChild(svtext(W - 14, ly + 4,
                L.clients + (L.clients === 1 ? ' client' : ' clients'), 't2', 'end'));
        });
        s.appendChild(sv('path', { 'class': 'link on',
            d: 'M' + cx + ' ' + c.bot + ' V' + lastLy }));
        y += lanesH;
    }

    if (m.vpn) {
        y += GAP;
        var vTop = y, vMid = vTop + BH / 2;
        s.appendChild(sv('rect', { 'class': 'nodebox ' + (m.vpnUp ? 'on' : 'bad'),
            x: LX, y: vTop, width: NW, height: BH, rx: 2 }));
        /* same label column as the nodes above, so the bypass reads as part of
           the same drawing rather than a footnote to it */
        /* "VPN", not "Encrypted path" — it fits on one line, so the label sits
           on the same centre as every other single-line node instead of being
           split across two. */
        s.appendChild(svtext(LX + 12, vTop + 21, 'VPN', 'cap' + (m.vpnUp ? ' capon' : '')));
        s.appendChild(svtext(LX + LBL, vTop + 21, m.vpnLabel, 't1'));
        /* the bypass: up the left margin, back into the Internet node */
        var d = 'M' + LX + ' ' + vMid + ' H14 V' + a.mid + ' H' + LX;
        s.appendChild(sv('path', { 'class': 'link ' + (m.vpnUp ? 'on' : 'off'), d: d }));
        if (m.vpnUp) s.appendChild(sv('path', { 'class': 'flow rev', d: d }));
    }
    return s;
}

function topology(m, compact) {
    if (compact) return topologyV(m);
    var W = 980, H = m.vpn ? 216 : 170;
    var s = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'topo',
                        preserveAspectRatio: 'xMinYMid meet' });
    s.style.minWidth = '660px';
    s.style.height = H + 'px';
    var midY = m.vpn ? 92 : 84;

    function node(x, y, w, hh, cls) {
        s.appendChild(sv('rect', { 'class': 'nodebox ' + (cls || ''), x: x, y: y,
                                   width: w, height: hh, rx: 2 }));
    }
    function link(x1, y1, x2, y2, cls, live) {
        s.appendChild(sv('path', { 'class': 'link ' + (cls || ''),
                                   d: 'M' + x1 + ' ' + y1 + ' H' + x2 }));
        if (live) s.appendChild(sv('path', { 'class': 'flow',
                                   d: 'M' + x1 + ' ' + y1 + ' H' + x2 }));
    }
    function cap(x, y, t, on) { s.appendChild(svtext(x, y, t, 'cap' + (on ? ' capon' : ''))); }

    var NW = 150, NH = 54;
    var col = [16, 236, 456, 688];

    node(col[0], midY - NH / 2, NW, NH, m.online ? 'on' : 'bad');
    cap(col[0] + 12, midY - NH / 2 - 9, 'Internet', m.online);
    s.appendChild(svtext(col[0] + 12, midY - 4, m.online ? 'Reachable' : 'No route', 't1'));
    s.appendChild(svtext(col[0] + 12, midY + 13, m.latency, 't2'));

    link(col[0] + NW, midY, col[1], midY, m.online ? 'on' : 'off', m.flowing);
    node(col[1], midY - NH / 2, NW, NH, m.online ? 'on' : '');
    cap(col[1] + 12, midY - NH / 2 - 9, 'Uplink', m.online);
    s.appendChild(svtext(col[1] + 12, midY - 4, m.uplink, 't1'));
    s.appendChild(svtext(col[1] + 12, midY + 13, m.uplinkSub, 't2'));

    link(col[1] + NW, midY, col[2], midY, m.online ? 'on' : 'off', m.flowing);
    node(col[2], midY - NH / 2, NW, NH, 'on');
    cap(col[2] + 12, midY - NH / 2 - 9, 'Router', true);
    s.appendChild(svtext(col[2] + 12, midY - 4, m.router, 't1'));
    s.appendChild(svtext(col[2] + 12, midY + 13, m.routerSub, 't2'));

    var lanes = m.lanes || [], n = lanes.length;
    var laneH = 40, spanTop = midY - ((n - 1) * laneH) / 2;
    var bx = col[2] + NW, jx = bx + 24;
    s.appendChild(sv('path', { 'class': 'link ' + (m.online ? 'on' : ''),
        d: 'M' + bx + ' ' + midY + ' H' + jx }));
    if (n > 1) s.appendChild(sv('path', { 'class': 'link ' + (m.online ? 'on' : ''),
        d: 'M' + jx + ' ' + spanTop + ' V' + (spanTop + (n - 1) * laneH) }));

    lanes.forEach(function (L, i) {
        var y = spanTop + i * laneH;
        link(jx, y, col[3], y, L.clients ? 'on' : 'off', L.active);
        node(col[3], y - 15, 122, 30, L.clients ? 'on' : '');
        s.appendChild(svtext(col[3] + 10, y + 4, L.name, 't1'));
        var cx = col[3] + 122 + 16;
        link(col[3] + 122, y, cx, y, L.clients ? 'on' : 'off', false);
        s.appendChild(svtext(cx + 6, y + 5, String(L.clients), 'tn'));
        s.appendChild(svtext(cx + 6 + (String(L.clients).length * 9) + 6, y + 5,
            L.clients === 1 ? 'client' : 'clients', 't2'));
    });

    if (m.vpn) {
        var vy = midY + 78;
        var sx = col[2] + NW / 2;
        var ex = col[0] + NW / 2;
        var lx = (sx + ex) / 2, bw = 196, bx = lx - bw / 2;
        /* Two segments that STOP at the tunnel box, not one run passing behind
           it. .nodebox.on is only 15% opaque, so a continuous path showed the
           marching dash straight through the label. Router -> tunnel -> out. */
        var dR = 'M' + sx + ' ' + (midY + NH / 2) + ' V' + (vy - 14) +
                 ' Q' + sx + ' ' + vy + ' ' + (sx - 20) + ' ' + vy +
                 ' H' + (bx + bw);
        var dL = 'M' + bx + ' ' + vy + ' H' + (ex + 20) +
                 ' Q' + ex + ' ' + vy + ' ' + ex + ' ' + (vy - 14) +
                 ' V' + (midY + NH / 2);
        [dR, dL].forEach(function (dd) {
            s.appendChild(sv('path', { 'class': 'link ' + (m.vpnUp ? 'on' : 'off'), d: dd }));
            if (m.vpnUp) s.appendChild(sv('path', { 'class': 'flow rev', d: dd }));
        });
        s.appendChild(sv('rect', { 'class': 'nodebox ' + (m.vpnUp ? 'on' : 'bad'),
            x: bx, y: vy - 15, width: bw, height: 30, rx: 2 }));
        s.appendChild(svtext(bx + 12, vy + 4, m.vpnLabel, 't1'));
        /* "VPN", matching the phone composition — the desktop drawing kept the
           old "Encrypted path" wording because it is a separate function. */
        cap(bx + 12, vy - 21, 'VPN', m.vpnUp);
    }
    return s;
}

global.OS = {
    el: el, $: $, $$: $$, clear: clear, setTxt: setTxt, frag: frag, svg: svg, icon: icon,
    keyed: keyed,
    I: I, CLASS_ICON: CLASS_ICON,
    bytes: bytes, rate: rate, brate: brate, dur: dur, ago: ago, clock: clock,
    bars: bars, signalWord: signalWord, genOf: genOf, GEN: GEN,
    LANNET: LANNET, bandLabel: bandLabel, netLabel: netLabel,
    meter: meter, meterSet: meterSet, readout: readout, chip: chip,
    emptyState: emptyState, note: note,
    spark: spark, ribbon: ribbon,
    sourcesList: sourcesList, failoverControl: failoverControl,
    sv: sv, svtext: svtext, gem: gem, quality: quality, stateWord: stateWord,
    scale: scale, scaleSet: scaleSet, rssiScale: rssiScale, rssiScaleSet: rssiScaleSet,
    spectrum: spectrum, topology: topology,
    toast: toast, dialog: dialog, askConfirm: askConfirm, firewallAlert: firewallAlert,
    Transport: Transport, post: post, act: act,
    buildShell: buildShell, stage: stage, routingLabel: routingLabel, flagTab: flagTab, dockAction: dockAction,
    tp: null
};
})(window);

/* Apply the stored theme and accent before first paint to avoid a flash. */
(function () {
    try {
        var t = localStorage.getItem('beryl-theme');
        if (t) document.documentElement.setAttribute('data-theme', t);
        var a = localStorage.getItem('beryl-accent');
        /* validate against the known set: a stale or hand-edited value must
           not leave the page stuck on an attribute no CSS defines */
        if (a && a !== 'mint' && ['maroon', 'navy', 'grey'].indexOf(a) >= 0) {
            document.documentElement.setAttribute('data-accent', a);
        }
    } catch (e) {}
})();
