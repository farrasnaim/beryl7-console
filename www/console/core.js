/* core.js — the runtime under the Beryl 7 control grid.
   New file, new namespace (G). Nothing here is shared with the old pages.

   What lives here: DOM helpers, the icon set, theme, the transport (one poll
   per endpoint, one request in flight each, exponential back-off, silent in
   a hidden tab), writes, the tile registry, the sheet, the components every
   tile composes from, and the formatters. Tiles themselves are in tiles.js.

   Everything is inserted with textContent. The router escapes control
   characters, not HTML — so no string from a payload ever meets innerHTML. */
(function () {
'use strict';

var CONSOLE_VERSION = '2f54577a4d';   /* rewritten by bump-assets.sh; 'dev' means "do not compare" */

var G = window.G = {};

/* ─── DOM ──────────────────────────────────────────────────────────────── */
function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return [].slice.call((root || document).querySelectorAll(sel)); }
function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
function setTxt(n, t) { if (n && n.textContent !== String(t)) n.textContent = t; }
/* markup here is ours (icons, sparklines), never a payload string */
function svg(markup) {
    var w = el('div'); w.innerHTML = markup.trim();
    return w.firstChild;
}
function attrs(n, map) { for (var k in map) if (map[k] != null) n.setAttribute(k, map[k]); return n; }
G.el = el; G.$ = $; G.$$ = $$; G.clear = clear; G.setTxt = setTxt; G.svg = svg;

/* ─── icons: one family, 24 grid, 1.75 stroke, round ends ──────────────── */
var ICONS = {
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5S14.6 18.1 12 20.5M12 3.5C9.4 5.9 8.1 8.7 8.1 12s1.3 6.1 3.9 8.5"/>',
    link: '<path d="M4 12a4 4 0 0 1 4-4h2M14 8h2a4 4 0 0 1 0 8h-2M10 16H8a4 4 0 0 1-4-4M8.5 12h7"/>',
    shield: '<path d="M12 3.5l7 2.8v5.2c0 4.4-3 7.8-7 9-4-1.2-7-4.6-7-9V6.3z"/><path d="M9 12l2 2 4-4.5"/>',
    devices: '<rect x="6.5" y="3.5" width="11" height="17" rx="2.5"/><path d="M10.5 17.5h3"/>',
    wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6.2 13a8.4 8.4 0 0 1 11.6 0M9.3 16.4a4 4 0 0 1 5.4 0"/><circle cx="12" cy="19.4" r="1.1" fill="currentColor" stroke="none"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
    gauge: '<path d="M4.5 16.5a8.5 8.5 0 1 1 15 0"/><path d="M12 15.5l4-5"/><circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    plane: '<path d="M10.5 13.5L4 11.2l1.2-1.6 6.7 1.2 4.3-4.8a1.7 1.7 0 0 1 2.4 2.4l-4.8 4.3 1.2 6.7-1.6 1.2-2.3-6.5-3.2 2.7.2 2.8-1.2.9-1.7-3.6L1.6 15l.9-1.2 2.8.2z"/>',
    speed: '<path d="M4 15.5a8.5 8.5 0 1 1 16 0"/><path d="M12 15.5l3.5-6.5"/><path d="M7 20h10"/>',
    users: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 5.8a3 3 0 0 1 0 5.4M17.5 13.6A5.4 5.4 0 0 1 20.5 19"/>',
    plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>',
    router: '<rect x="3.5" y="12.5" width="17" height="7" rx="2.5"/><path d="M7 16h.01M10.5 16h.01M12 12.5V9M8.3 6.3a5.2 5.2 0 0 1 7.4 0M6 4a8.5 8.5 0 0 1 12 0"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8.5-8.5M15.5 6.5l2.5 2.5M13 9l2 2"/>',
    lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.5M12 17.5h.01"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4.5h-4.5"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12h9.4l.8-12"/>',
    qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 14h2M14 18h2v2M18 18h2v2"/>',
    bolt: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.8"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>',
    usb: '<path d="M12 3v14M12 21v-4M8 8l4-5 4 5M7 13.5l5 3.5 5-3.5"/><circle cx="7" cy="12" r="1.3"/><rect x="15.5" y="10.5" width="3" height="3"/>',
    ethernet: '<rect x="4" y="9" width="16" height="9" rx="2"/><path d="M8 9V6.5h8V9M8 14v1.5M11 14v1.5M13 14v1.5M16 14v1.5"/>',
    log: '<path d="M5 6.5h14M5 12h14M5 17.5h9"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14"/>',
    power: '<path d="M12 4v7"/><path d="M7 7.8a7 7 0 1 0 10 0"/>',
    home: '<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    layers: '<path d="M12 4l8 4.5-8 4.5-8-4.5z"/><path d="M4 13l8 4.5 8-4.5M4 17.5l8 4.5 8-4.5"/>'
};
function icon(name) {
    return svg('<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" ' +
        'stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.info) + '</svg>');
}
G.icon = icon;

/* The brand mark: the i with its arcs, as the capsule wears it. */
function mark() {
    return svg('<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">' +
        '<rect x="10.4" y="10.6" width="3.2" height="10" rx="1.2"/><circle cx="12" cy="7.6" r="1.9"/>' +
        '<path d="M6.9 5.4a7.2 7.2 0 0 1 10.2 0l-1.3 1.3a5.4 5.4 0 0 0-7.6 0z"/>' +
        '<path d="M4.3 2.8a10.9 10.9 0 0 1 15.4 0L18.4 4.1a9.1 9.1 0 0 0-12.8 0z"/></svg>');
}

/* ─── theme (client-only; key is new) ──────────────────────────────────── */
var theme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || 'light'; },
    set: function (t) {
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem('b7.theme', t); } catch (e) {}
        var m = $('meta[name="theme-color"]:not([media])');
        if (!m) { m = el('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
        m.content = t === 'dark' ? '#100f14' : '#e6e8ed';
        bus.emit('theme', t);
    },
    toggle: function () { theme.set(theme.get() === 'dark' ? 'light' : 'dark'); }
};
G.theme = theme;

/* ─── a tiny event bus ─────────────────────────────────────────────────── */
var bus = { h: {} };
bus.on = function (k, fn) { (bus.h[k] = bus.h[k] || []).push(fn); return function () { bus.off(k, fn); }; };
bus.off = function (k, fn) { var a = bus.h[k]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
bus.emit = function (k, v) { (bus.h[k] || []).slice().forEach(function (fn) { try { fn(v); } catch (e) { console.error(k, e); } }); };
G.bus = bus;

/* ─── network ──────────────────────────────────────────────────────────── */
function withAbort(ms) {
    var c = ('AbortController' in window) ? new AbortController() : null;
    var t = c ? setTimeout(function () { c.abort(); }, ms) : null;
    return { signal: c ? c.signal : undefined, done: function () { if (t) clearTimeout(t); } };
}
function get(url, ms) {
    var a = withAbort(ms || 9000);
    return fetch(url, { cache: 'no-store', signal: a.signal }).then(function (r) {
        a.done();
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }, function (e) { a.done(); throw e; });
}
/* writes: urlencoded POST; the browser's Origin header is what the router's
   same-origin guard checks, so this only works from the console's own host */
function post(api, params, ms) {
    var body = Object.keys(params || {}).map(function (k) {
        var v = params[k]; if (v == null) v = '';
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    }).join('&');
    var a = withAbort(ms || 25000);
    return fetch(api, { method: 'POST', body: body, cache: 'no-store', signal: a.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function (r) { a.done(); return r.json(); })
        .catch(function (e) {
            a.done();
            return { ok: false, error: /abort/i.test(String(e)) ? 'timed out' : 'could not reach the router' };
        });
}
/* act: a write with its button held busy and its outcome told once */
function act(btn, api, params, opts) {
    opts = opts || {};
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    return post(api, params).then(function (j) {
        if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
        if (j && j.ok) {
            if (opts.ok !== false) pop(opts.ok || 'Done.', 'ok');
            if (opts.refresh) opts.refresh.forEach(function (s) { polls[s] && polls[s].refresh(opts.delay || 700); });
        } else {
            pop((opts.failPrefix || 'Failed') + ': ' + ((j && j.error) || 'unknown error'), 'bad');
        }
        return j;
    });
}
G.get = get; G.post = post; G.act = act;

/* ─── pops (toasts): appear, stay, go. No motion. ──────────────────────── */
function pop(text, tone, ms) {
    var host = $('#pops'); if (!host) return;
    var p = el('div', 'pop'); if (tone) p.setAttribute('data-tone', tone);
    p.appendChild(icon(tone === 'bad' ? 'alert' : tone === 'warn' ? 'info' : 'check'));
    p.appendChild(el('span', null, text));
    host.appendChild(p);
    setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, ms || (tone === 'bad' ? 6500 : 3600));
}
G.pop = pop;

/* ─── polls ────────────────────────────────────────────────────────────── */
/* One request in flight per endpoint; failures back off ×2 to 30 s; nothing
   is fetched while the tab is hidden and the first tick after it returns is
   immediate. The link state the capsule shows is the dashboard poll's. */
var polls = {};
G.data = {};
function Poll(name, url, interval, opts) {
    var self = this; opts = opts || {};
    this.name = name; this.url = url; this.interval = interval; this.timeout = opts.timeout || 9000;
    this.timer = null; this.inflight = false; this.fails = 0; this.lastOk = 0; this.stopped = false;
    this.tick = function () {
        if (self.stopped || self.inflight || document.visibilityState !== 'visible') return;
        self.inflight = true;
        if (self.lastOk && self === polls.dash) link.set('sync');
        get(self.url, self.timeout).then(function (j) {
            self.inflight = false; self.fails = 0; self.lastOk = Date.now();
            G.data[name] = j;
            if (self === polls.dash) link.set('live');
            bus.emit('data', name); bus.emit('data:' + name, j);
            self.arm(self.interval);
        }, function (e) {
            self.inflight = false; self.fails++;
            if (self === polls.dash) link.set(self.fails >= 3 || !self.lastOk ? 'down' : 'stale');
            self.arm(Math.min(self.interval * Math.pow(2, self.fails), 30000));
        });
    };
    this.arm = function (ms) { clearTimeout(self.timer); self.timer = setTimeout(self.tick, ms); };
    this.refresh = function (delay) { self.arm(delay || 60); };
    this.stop = function () { self.stopped = true; clearTimeout(self.timer); };
    this.start = function () { self.stopped = false; self.tick(); };
    polls[name] = this;
}
G.poll = function (name, url, interval, opts) { return polls[name] || new Poll(name, url, interval, opts); };
G.polls = polls;
document.addEventListener('visibilitychange', function () {
    for (var k in polls) { if (document.visibilityState === 'visible') polls[k].tick(); else clearTimeout(polls[k].timer); }
});
/* the idle ager: a dashboard sample older than three intervals is stale */
setInterval(function () {
    var d = polls.dash; if (!d || !d.lastOk || d.inflight) return;
    var age = (Date.now() - d.lastOk) / 1000;
    if (age > d.interval / 1000 * 3) link.set('stale', Math.round(age) + 's old');
}, 2000);

/* ─── link state → the capsule ─────────────────────────────────────────── */
var link = {
    state: 'sync',
    set: function (s, txt) {
        var cap = $('#cap'); if (!cap) return;
        link.state = s;
        cap.setAttribute('data-link', s);
        setTxt($('#capState'), txt || ({ live: 'live', sync: 'syncing', stale: 'stale', down: 'no link' })[s]);
    }
};
G.link = link;

/* ─── stale page: once, at load ────────────────────────────────────────── */
function checkStale() {
    if (!CONSOLE_VERSION || CONSOLE_VERSION === 'dev') return;
    get('/cgi-bin/version-api', 6000).then(function (j) {
        if (!j || !j.ok || !j.v || j.v === CONSOLE_VERSION) return;
        var s = el('div', 'stale');
        s.appendChild(el('span', null, 'The router has a newer console.'));
        var b = el('button', 'act act--primary act--sm', 'Reload'); b.type = 'button';
        b.addEventListener('click', function () {
            fetch(location.href, { cache: 'reload' }).catch(function () {}).then(function () { location.reload(); });
        });
        s.appendChild(b);
        document.body.appendChild(s);
    }).catch(function () {});
}

/* ─── formatters ───────────────────────────────────────────────────────── */
var fmt = {
    bytes: function (b) {
        b = +b || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
        while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
        return (i === 0 ? b : b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2)) + ' ' + u[i];
    },
    /* bits per second, from bytes per second */
    rate: function (Bps) {
        var b = (+Bps || 0) * 8, u = ['b/s', 'kb/s', 'Mb/s', 'Gb/s'], i = 0;
        while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
        return { n: b >= 100 ? b.toFixed(0) : b >= 10 ? b.toFixed(1) : b.toFixed(2), u: u[i] };
    },
    rateStr: function (Bps) { var r = fmt.rate(Bps); return r.n + ' ' + r.u; },
    dur: function (s) {
        s = Math.max(0, Math.floor(+s || 0));
        var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
        if (d) return d + 'd ' + h + 'h'; if (h) return h + 'h ' + m + 'm'; if (m) return m + 'm'; return s + 's';
    },
    ago: function (ts, now) {
        var s = Math.max(0, Math.round((now || Date.now() / 1000) - ts));
        if (s < 60) return s + 's ago'; if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago'; return Math.round(s / 86400) + 'd ago';
    },
    ms: function (n) { if (n == null || n < 0) return '—'; return (n >= 10 ? Math.round(n) : (+n).toFixed(1)) + ' ms'; },
    pct: function (f) { return Math.round(f * 100) + '%'; },
    clock: function (ts) { var d = new Date(ts * 1000); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); },
    plural: function (n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
};
G.fmt = fmt;

/* ─── components ───────────────────────────────────────────────────────── */
var ui = {};
ui.readout = function (k, v, s, tone, unit) {
    var r = el('div', 'readout'); if (tone) r.setAttribute('data-tone', tone);
    r.appendChild(el('div', 'readout__k', k));
    var vv = el('div', 'readout__v', v); if (unit) vv.appendChild(el('small', null, unit)); r.appendChild(vv);
    if (s) r.appendChild(el('div', 'readout__s', s));
    return r;
};
ui.readouts = function (items) { var g = el('div', 'readouts'); items.forEach(function (i) { g.appendChild(i); }); return g; };
ui.cell = function (o) {
    var c = el(o.onClick ? 'button' : 'div', 'cell' + (o.on ? ' is-on' : '') + (o.dim ? ' is-dim' : ''));
    if (o.onClick) { c.type = 'button'; c.addEventListener('click', o.onClick); }
    var top = el('div', 'cell__top');
    top.appendChild(el('span', 'cell__k', o.k || ''));
    if (o.right) top.appendChild(o.right);
    c.appendChild(top);
    c.appendChild(el('div', 'cell__t', o.t || ''));
    if (o.s != null) { var s = el('div', 'cell__s'); if (typeof o.s === 'string') s.textContent = o.s; else s.appendChild(o.s); c.appendChild(s); }
    return c;
};
ui.cells = function (items) { var g = el('div', 'cells'); items.forEach(function (i) { g.appendChild(i); }); return g; };
ui.mark = function (text, tone, solid) {
    var m = el('span', 'mark' + (solid ? ' mark--solid' : ''), text);
    if (tone) m.setAttribute('data-tone', tone);
    return m;
};
ui.say = function (text, tone, ic) {
    var s = el('div', 'say'); if (tone) s.setAttribute('data-tone', tone);
    s.appendChild(icon(ic || (tone === 'bad' || tone === 'warn' ? 'alert' : 'info')));
    var t = el('div'); if (typeof text === 'string') t.textContent = text; else t.appendChild(text); s.appendChild(t);
    return s;
};
ui.kv = function (pairs) {
    var d = el('dl', 'kv');
    pairs.forEach(function (p) { if (p[1] == null || p[1] === '') return; d.appendChild(el('dt', null, p[0])); var dd = el('dd', 'num'); if (typeof p[1] === 'string' || typeof p[1] === 'number') dd.textContent = p[1]; else dd.appendChild(p[1]); d.appendChild(dd); });
    return d;
};
ui.line = function (t, body, e, tone) {
    var l = el('div', 'line'); if (tone) l.setAttribute('data-tone', tone);
    if (t != null) l.appendChild(el('span', 'line__t', t));
    var b = el('span', 'line__b'); if (typeof body === 'string') b.textContent = body; else b.appendChild(body); l.appendChild(b);
    if (e != null) { var ee = el('span', 'line__e'); if (typeof e === 'string') ee.textContent = e; else ee.appendChild(e); l.appendChild(ee); }
    return l;
};
ui.lines = function (items) { var g = el('div', 'lines'); items.forEach(function (i) { g.appendChild(i); }); return g; };
var fieldSeq = 0;
ui.field = function (label, ctl, hint) {
    var f = el('div', 'field');
    var l = el('label', 'field__l', label);
    var target = ctl.matches && ctl.matches('input,select,textarea') ? ctl : ctl.querySelector && ctl.querySelector('input,select,textarea');
    if (target) { if (!target.id) target.id = 'g' + (++fieldSeq); l.htmlFor = target.id; }
    f.appendChild(l); f.appendChild(ctl);
    if (hint) f.appendChild(el('div', 'field__h', hint));
    return f;
};
ui.input = function (o) {
    o = o || {};
    var i = el('input', 'in' + (o.inline ? ' in--inline' : '') + (o.mono ? ' num' : ''));
    i.type = o.type || 'text'; if (o.value != null) i.value = o.value; if (o.placeholder) i.placeholder = o.placeholder;
    if (o.inputmode) i.inputMode = o.inputmode; if (o.maxlength) i.maxLength = o.maxlength;
    i.autocomplete = o.autocomplete || 'off'; i.spellcheck = false;
    if (o.min != null) i.min = o.min; if (o.max != null) i.max = o.max; if (o.step != null) i.step = o.step;
    if (o.label) i.setAttribute('aria-label', o.label);
    return i;
};
ui.select = function (options, value, o) {
    o = o || {};
    var s = el('select', 'sel' + (o.inline ? ' sel--inline' : ''));
    options.forEach(function (op) {
        var e = el('option', null, op.label != null ? op.label : op.value); e.value = op.value;
        if (op.disabled) e.disabled = true; if (String(op.value) === String(value)) e.selected = true; s.appendChild(e);
    });
    if (o.label) s.setAttribute('aria-label', o.label);
    return s;
};
ui.textarea = function (o) { o = o || {}; var t = el('textarea', 'ta'); if (o.placeholder) t.placeholder = o.placeholder; t.spellcheck = false; if (o.value) t.value = o.value; return t; };
ui.check = function (label, checked, onChange) {
    var l = el('label', 'check'); var i = el('input'); i.type = 'checkbox'; i.checked = !!checked;
    if (onChange) i.addEventListener('change', function () { onChange(i.checked); });
    l.appendChild(i); l.appendChild(el('span', null, label)); return { row: l, input: i };
};
ui.act = function (label, kind, onClick, ic) {
    var b = el('button', 'act' + (kind ? ' act--' + kind.split(' ').join(' act--') : '')); b.type = 'button';
    if (ic) b.appendChild(icon(ic));
    b.appendChild(el('span', null, label));
    if (onClick) b.addEventListener('click', function () { onClick(b); });
    return b;
};
ui.switchEl = function (checked, onChange, label) {
    var s = el('button', 'switch'); s.type = 'button'; s.setAttribute('role', 'switch');
    s.setAttribute('aria-checked', checked ? 'true' : 'false'); if (label) s.setAttribute('aria-label', label);
    s.addEventListener('click', function (e) {
        e.stopPropagation();
        var v = s.getAttribute('aria-checked') !== 'true';
        if (onChange) onChange(v, s);
    });
    return s;
};
ui.setSwitch = function (s, v, busy) { s.setAttribute('aria-checked', v ? 'true' : 'false'); s.disabled = !!busy; };
ui.pick = function (options, value, onChange, fill) {
    var p = el('div', 'pick' + (fill ? ' pick--fill' : '')); p.setAttribute('role', 'group');
    options.forEach(function (op) {
        var b = el('button', null, op.label); b.type = 'button';
        b.setAttribute('aria-pressed', String(op.value) === String(value) ? 'true' : 'false');
        b.addEventListener('click', function () {
            $$('button', p).forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
            onChange(op.value);
        });
        p.appendChild(b);
    });
    return p;
};
/* the Wi-Fi fan: a dot and three arcs lit from the dot outward; four levels */
ui.fan = function (dbm) {
    var w = el('span', 'fan'); w.setAttribute('aria-hidden', 'true');
    w.appendChild(svg('<svg viewBox="0 0 24 20"><circle cx="12" cy="17.5" r="1.7"/>' +
        '<path d="M8.17 14.29A5 5 0 0 1 15.83 14.29"/><path d="M4.72 11.39A9.5 9.5 0 0 1 19.28 11.39"/>' +
        '<path d="M1.28 8.5A14 14 0 0 1 22.72 8.5"/></svg>'));
    ui.fanSet(w, dbm); return w;
};
ui.fanSet = function (w, dbm) {
    var q = quality(dbm); w.setAttribute('data-tone', q.tone === 'fair' ? 'ok' : q.tone);
    var lit = (dbm == null || dbm === 0) ? 0 : q.tone === 'ok' ? 4 : q.tone === 'fair' ? 3 : q.tone === 'warn' ? 2 : 1;
    var kids = w.firstChild.children;
    for (var i = 0; i < 4; i++) kids[i].setAttribute('class', i < lit ? 'on' : '');
};
/* an arc gauge: 240° of ring, filled by fraction */
ui.arc = function (frac, label, value, tone) {
    var a = el('div', 'arc'); if (tone) a.setAttribute('data-tone', tone);
    var r = 20, cx = 24, cy = 24, start = 150, sweep = 240;
    function pt(deg) { var rad = deg * Math.PI / 180; return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]; }
    function path(a0, a1) { var p0 = pt(a0), p1 = pt(a1); var big = (a1 - a0) > 180 ? 1 : 0; return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 ' + big + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2); }
    var f = Math.max(0, Math.min(1, +frac || 0));
    var fill = f > 0.002 ? '<path class="f" d="' + path(start, start + sweep * f) + '"/>' : '';
    a.appendChild(svg('<svg viewBox="0 0 48 46"><path class="t" d="' + path(start, start + sweep) + '"/>' + fill + '</svg>'));
    a.appendChild(el('div', 'arc__v num', value));
    a.appendChild(el('div', 'arc__k', label));
    return a;
};
/* a sparkline: values oldest first; nulls break the line */
ui.spark = function (values, o) {
    o = o || {}; var W = o.w || 200, H = o.h || 48, pad = 2;
    var vals = values.filter(function (v) { return v != null && v >= 0; });
    var max = o.max != null ? o.max : (vals.length ? Math.max.apply(null, vals) : 1) || 1;
    var min = o.min != null ? o.min : 0;
    var n = values.length, dx = n > 1 ? (W - pad * 2) / (n - 1) : 0;
    var d = '', area = '', open = false, lastX = 0, lastY = 0;
    for (var i = 0; i < n; i++) {
        var v = values[i], x = pad + i * dx;
        if (v == null || v < 0) { if (open && o.fill) area += 'L' + lastX.toFixed(1) + ' ' + (H - pad) + 'Z'; open = false; continue; }
        var y = H - pad - (Math.min(max, Math.max(min, v)) - min) / (max - min || 1) * (H - pad * 2);
        if (!open) { d += 'M' + x.toFixed(1) + ' ' + y.toFixed(1); if (o.fill) area += 'M' + x.toFixed(1) + ' ' + (H - pad) + 'L' + x.toFixed(1) + ' ' + y.toFixed(1); open = true; }
        else { d += 'L' + x.toFixed(1) + ' ' + y.toFixed(1); if (o.fill) area += 'L' + x.toFixed(1) + ' ' + y.toFixed(1); }
        lastX = x; lastY = y;
    }
    if (open && o.fill) area += 'L' + lastX.toFixed(1) + ' ' + (H - pad) + 'Z';
    var cls = o.accent ? 'l2' : 'l', acls = o.accent ? 'a2' : 'a';
    var end = (open && o.dot) ? '<circle class="e" cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="2.2"/>' : '';
    return svg('<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        (o.zero ? '<line class="z" x1="0" x2="' + W + '" y1="' + (H - pad) + '" y2="' + (H - pad) + '"/>' : '') +
        (o.fill ? '<path class="' + acls + '" d="' + area + '"/>' : '') + '<path class="' + cls + '" d="' + d + '"/>' + end + '</svg>');
};
ui.bar = function (frac, tone) {
    var b = el('div', 'bar'); if (tone) b.setAttribute('data-tone', tone);
    var i = el('i'); i.style.transform = 'scaleX(' + Math.max(0, Math.min(1, +frac || 0)).toFixed(3) + ')'; b.appendChild(i);
    return b;
};
ui.empty = function (ic, title, text) {
    var e = el('div', 'empty'); e.appendChild(icon(ic || 'info'));
    if (title) e.appendChild(el('b', null, title)); if (text) e.appendChild(el('span', null, text)); return e;
};
ui.wait = function (n) { var w = el('div'); for (var i = 0; i < (n || 3); i++) { var b = el('div', 'wait'); b.style.width = (85 - i * 17) + '%'; w.appendChild(b); } return w; };
ui.qr = function (text) {
    var q = el('div', 'qr');
    try {
        q.innerHTML = window.UQR.renderSVG(text, { pixelSize: 4, border: 1 });
        /* the library sizes the svg in pixels with no viewBox, so CSS could grow the box but not the code */
        var s = q.querySelector('svg');
        if (s && !s.getAttribute('viewBox')) { s.setAttribute('viewBox', '0 0 ' + s.getAttribute('width') + ' ' + s.getAttribute('height')); s.removeAttribute('width'); s.removeAttribute('height'); }
    } catch (e) { q.textContent = 'QR unavailable'; }
    return q;
};
/* a two-button confirmation, drawn as a small sheet-grade pane; no motion */
ui.confirm = function (o) {
    return new Promise(function (resolve) {
        var veil = el('div', 'veil is-open'); veil.style.zIndex = 80;
        var box = el('div', 'ask'); box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true');
        var t = el('h2', 'ask__t', o.title); box.appendChild(t);
        if (o.body) { var b = el('div', 'ask__b'); if (typeof o.body === 'string') b.textContent = o.body; else b.appendChild(o.body); box.appendChild(b); }
        var input = null;
        if (o.field) {
            input = ui.input({ type: o.field.type || 'text', placeholder: o.field.placeholder, value: o.field.value, autocomplete: o.field.type === 'password' ? 'current-password' : 'off' });
            box.appendChild(ui.field(o.field.label, input));
        }
        var row = el('div', 'ask__acts');
        var cancel = ui.act(o.cancelText || 'Cancel', 'quiet', function () { done(null); });
        var ok = ui.act(o.okText || 'Confirm', o.danger ? 'danger' : 'primary', function () { done(input ? input.value : true); });
        row.appendChild(cancel); row.appendChild(ok); box.appendChild(row);
        veil.appendChild(box); document.body.appendChild(veil);
        var prev = document.activeElement;
        function done(v) { document.removeEventListener('keydown', key, true); veil.parentNode && veil.parentNode.removeChild(veil); if (prev && prev.focus) prev.focus(); resolve(v); }
        function key(e) {
            if (e.key === 'Escape') { e.preventDefault(); done(null); }
            if (e.key === 'Enter' && input && document.activeElement === input) { e.preventDefault(); done(input.value); }
            if (e.key === 'Tab') { var f = [input, cancel, ok].filter(Boolean); var i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
        }
        document.addEventListener('keydown', key, true);
        veil.addEventListener('click', function (e) { if (e.target === veil) done(null); });
        (input || ok).focus();
    });
};
G.ui = ui;

/* signal quality: the same thresholds everywhere a word or a fan is drawn */
function quality(dbm) {
    if (dbm == null || dbm === 0) return { word: 'No signal', tone: 'idle' };
    if (dbm >= -55) return { word: 'Excellent', tone: 'ok' };
    if (dbm >= -67) return { word: 'Good', tone: 'fair' };
    if (dbm >= -75) return { word: 'Weak', tone: 'warn' };
    return { word: 'Poor', tone: 'bad' };
}
G.quality = quality;
G.genOf = function (st) { var r = st && (st.tx || st.rx); if (!r) return 4; return r.eht ? 7 : r.he ? 6 : r.vht ? 5 : 4; };
G.bandLabel = function (b) { return ({ '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz' })[b] || b || 'Radio'; };
G.netLabel = function (n) { if (!n) return 'Secondary'; if (n === 'iot') return 'IoT'; return n.charAt(0).toUpperCase() + n.slice(1); };
G.netRank = function (n) { n = (n || '').toLowerCase(); return n === 'lan' ? -1 : n === 'guest' ? 0 : n === 'iot' ? 1 : 2; };

/* ─── tiles ────────────────────────────────────────────────────────────── */
var TILES = [];
G.tile = function (def) { TILES.push(def); return def; };
G.tiles = TILES;
var faces = {};

function buildGrid() {
    var grid = $('#grid'); clear(grid);
    TILES.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    TILES.forEach(function (def) {
        var t = el('div', 'tile' + (def.wide ? ' tile--wide' : '') + (def.path ? ' tile--path' : '') + (def.toggle ? ' tile--ctl' : ''));
        t.setAttribute('data-tile', def.id);
        if (def.sheet) {
            t.setAttribute('role', 'button'); t.tabIndex = 0;   /* its text is its name: label, value, note */
            t.addEventListener('click', function () { sheet.open(def.id); });
            t.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sheet.open(def.id); } });
        }
        var body = el('div', 'tile__body'); body.style.cssText = 'display:contents';
        t.appendChild(body);
        var sw = null;
        if (def.toggle) {
            var ctl = el('div', 'tile__ctl');
            sw = ui.switchEl(false, function (v, s) {
                ui.setSwitch(s, !v, true);      /* hold the old state, busy, until the router answers */
                s.setAttribute('data-busy', '1');
                var done = function () { s.removeAttribute('data-busy'); s.disabled = false; renderTile(def); };
                Promise.resolve(def.toggle.write(v, { data: G.data })).then(done, done);
            }, def.label);
            ctl.appendChild(sw); t.appendChild(ctl);
        }
        faces[def.id] = { el: t, body: body, sw: sw };
        grid.appendChild(t);
        renderTile(def);
    });
}
function renderTile(def) {
    var f = faces[def.id]; if (!f) return;
    try {
        var frag = document.createDocumentFragment();
        var state = def.render(frag, G.data) || {};
        clear(f.body); f.body.appendChild(frag);
        f.el.classList.toggle('is-on', !!state.on);
        f.el.classList.toggle('is-off', state.on === false);
        /* not while a write is in flight; otherwise the switch follows the data — disabled only while there is none */
        if (f.sw && !f.sw.hasAttribute('data-busy')) { var v = def.toggle.read(G.data); f.sw.disabled = v == null; if (v != null) f.sw.setAttribute('aria-checked', v ? 'true' : 'false'); }
        if (state.tone) f.el.setAttribute('data-tone', state.tone); else f.el.removeAttribute('data-tone');
    } catch (e) { console.error('tile ' + def.id, e); }
}
G.renderTile = renderTile;
/* helpers a tile face is made of */
G.face = {
    hd: function (frag, ic, label, right) {
        var h = el('div', 'tile__hd'); h.appendChild(icon(ic)); h.appendChild(el('span', null, label));
        if (right) { var r = el('span', 'push'); if (typeof right === 'string') r.textContent = right; else r.appendChild(right); h.appendChild(r); }
        frag.appendChild(h); return h;
    },
    value: function (frag, v, unit, tone, lg) {
        var d = el('div', 'tile__value num' + (lg ? ' tile__value--lg' : ''), v);
        if (unit) d.appendChild(el('small', null, unit)); if (tone) d.setAttribute('data-tone', tone);
        frag.appendChild(d); return d;
    },
    sub: function (frag, s, tone) { var d = el('div', 'tile__sub', s); if (tone) d.setAttribute('data-tone', tone); frag.appendChild(d); return d; },
    foot: function (frag, left, right) {
        var f = el('div', 'tile__foot');
        var l = el('div', 'tile__sub'); if (typeof left === 'string') l.textContent = left; else if (left) l.appendChild(left); f.appendChild(l);
        if (right) f.appendChild(right);
        frag.appendChild(f); return f;
    }
};

/* ─── the sheet ────────────────────────────────────────────────────────── */
var sheet = { id: null, subs: [], opener: null, closing: false };
sheet.open = function (id) {
    var def = TILES.filter(function (d) { return d.id === id; })[0];
    if (!def || !def.sheet) return;
    if (sheet.id) sheet.teardown();
    sheet.id = id; sheet.opener = document.activeElement;
    var s = $('#sheet'), v = $('#veil'), b = $('#sheetBody'), f = $('#sheetFoot');
    clear($('#sheetIcon')).appendChild(attrs(icon(def.sheetIcon || def.icon), { 'class': 'ico' }));
    setTxt($('#sheetTitle'), def.sheetTitle || def.label);
    setTxt($('#sheetMeta'), '');
    clear(b); clear(f); f.hidden = true;
    var api = {
        body: b, def: def, data: G.data,
        meta: function (t) { setTxt($('#sheetMeta'), t || ''); },
        foot: function (nodes) { clear(f); (nodes || []).forEach(function (n) { f.appendChild(n); }); f.hidden = !nodes || !nodes.length; },
        on: function (src, fn) { sheet.subs.push(bus.on('data:' + src, fn)); },
        close: function () { sheet.close(); },
        refresh: function (names, delay) { (names || []).forEach(function (n) { polls[n] && polls[n].refresh(delay || 700); }); },
        scrollTop: function () { b.scrollTop = 0; }
    };
    try { def.sheet(b, api); } catch (e) { console.error('sheet ' + id, e); b.appendChild(ui.say('This panel could not be drawn: ' + e.message, 'bad')); }
    s.hidden = false; v.hidden = false;
    /* two frames so the transform transitions from its hidden position */
    requestAnimationFrame(function () { requestAnimationFrame(function () {
        s.classList.add('is-open'); v.classList.add('is-open'); $('#stage').classList.add('is-back');
    }); });
    $('#stage').setAttribute('aria-hidden', 'true');
    if (!(history.state && history.state.sheet === id)) history.pushState({ sheet: id }, '', '#' + id);
    $('#sheetClose').focus();
};
sheet.teardown = function () { sheet.subs.forEach(function (off) { off(); }); sheet.subs = []; };
sheet.close = function (fromHistory) {
    if (!sheet.id) return;
    var s = $('#sheet'), v = $('#veil');
    sheet.teardown(); var was = sheet.id; sheet.id = null;
    s.classList.remove('is-open'); v.classList.remove('is-open'); $('#stage').classList.remove('is-back');
    $('#stage').removeAttribute('aria-hidden');
    var hide = function () { if (!sheet.id) { s.hidden = true; v.hidden = true; } };
    if (matchMedia('(prefers-reduced-motion: no-preference)').matches) setTimeout(hide, 440); else hide();
    if (!fromHistory && history.state && history.state.sheet === was) history.back();
    var op = sheet.opener || faces[was] && faces[was].el; if (op && op.focus) op.focus();
};
$('#sheetClose').addEventListener('click', function () { sheet.close(); });
$('#veil').addEventListener('click', function () { sheet.close(); });
document.addEventListener('keydown', function (e) {
    if (!sheet.id) return;
    if (e.key === 'Escape') { e.preventDefault(); sheet.close(); return; }
    if (e.key === 'Tab') {   /* keep focus inside the sheet */
        var f = $$('#sheet button, #sheet [href], #sheet input, #sheet select, #sheet textarea, #sheet [tabindex]:not([tabindex="-1"])')
            .filter(function (n) { return !n.disabled && n.offsetParent !== null; });
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (!$('#sheet').contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
});
window.addEventListener('popstate', function () {
    var want = history.state && history.state.sheet;
    if (!want && sheet.id) sheet.close(true);
    else if (want && want !== sheet.id) sheet.open(want);
});
G.sheet = sheet;

/* ─── boot ─────────────────────────────────────────────────────────────── */
G.boot = function () {
    clear($('#capMark')).appendChild(mark());
    $('#sheetClose').appendChild(icon('x'));
    buildGrid();
    bus.on('data', function () { TILES.forEach(renderTile); });
    checkStale();
    /* a sheet named in the URL opens once the first data has landed */
    var h = location.hash.replace('#', '');
    if (h) { history.replaceState({ sheet: h }, '', '#' + h); var once = bus.on('data:dash', function () { once(); sheet.open(h); }); }
};
})();
