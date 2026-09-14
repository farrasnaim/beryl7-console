/* tiles.js — every instrument on the Beryl 7 control grid, and its sheet.
   Data comes from the router's CGIs through G.poll; every threshold and every
   state word is computed here from raw payload fields, as the contract lists
   them. Nothing is inserted as HTML; payload strings only ever meet textContent. */
(function () {
'use strict';
var el = G.el, $ = G.$, $$ = G.$$, clear = G.clear, setTxt = G.setTxt, ui = G.ui, fmt = G.fmt, icon = G.icon;
var DASH = '/cgi-bin/dashboard-api', RATE = '/cgi-bin/rate-api', VPN = '/cgi-bin/vpn-api', WG = '/cgi-bin/wireguard-api',
    REP = '/cgi-bin/repeater-api', USB = '/cgi-bin/tethering-api', SET = '/cgi-bin/settings-api', TOOLS = '/cgi-bin/tools-api',
    PROBE = '/cgi-bin/probe-api';
var UPLABEL = { wan: 'Ethernet', wwan: 'Wi-Fi', tethering: 'USB', none: 'None' };
var UPICON = { wan: 'ethernet', wwan: 'wifi', tethering: 'usb', none: 'link' };
var now = function () { return Math.floor(Date.now() / 1000); };
function D() { return G.data; }
function tsOf(p) { return (p && p.ts) || now(); }

/* ═══ the device model (Overview contract §Device) ═════════════════════════ */
var LAN = 'lan';
function devices(d) {
    if (!d || !d.aps) return [];
    var map = {};
    function dev(mac) { mac = mac.toUpperCase(); return map[mac] || (map[mac] = { mac: mac, links: [], blocked: [], wired: null }); }
    d.aps.forEach(function (ap) {
        ((ap.assoc && ap.assoc.results) || []).forEach(function (st) {
            dev(st.mac).links.push({ band: ap.band === '5g' ? '5' : '2.4', ssid: ap.info && ap.info.ssid, section: ap.section, net: ap.network, ifname: ap.ifname, st: st });
        });
        if (ap.macfilter === 'deny') (ap.maclist || []).forEach(function (m) { dev(m).blocked.push({ section: ap.section, band: ap.band, ssid: ap.info && ap.info.ssid }); });
    });
    (d.wired || []).forEach(function (w) { var v = dev(w.mac); v.wired = w; });
    var cm = d.classmap || {}, le = d.leases || {}, ho = d.hosts || {};
    var out = Object.keys(map).map(function (mac) {
        var v = map[mac], c = cm[mac] || {}, l = le[mac] || {}, h = ho[mac] || {};
        v.name = c.name || (l.name && l.name !== '*' ? l.name : '') || (h.name ? String(h.name).replace(/\.lan$/, '') : '') || mac;
        v.named = !!c.name;
        v.ip = c.ip || l.ip || (h.ipaddrs && h.ipaddrs[0]) || (v.wired && v.wired.ip) || '';
        v.ip6 = (h.ip6addrs || []).slice(0, 2);
        v.cls = c.class || 'default';
        v.vpn = (d.vpn || {})[mac] || null;
        v.neigh = (d.neigh || {})[mac] || '';
        v.x = (d.sta || {})[mac] || {};
        v.links.sort(function (a, b) { return (b.st.signal || -100) - (a.st.signal || -100); });
        if (v.links.length) { v.medium = v.links[0].band; v.signal = v.links[0].st.signal; }
        else if (v.wired && v.wired.link === 'wired') v.medium = 'eth';
        else if (v.blocked.length && !(v.wired && v.wired.link)) v.medium = 'blocked';
        else v.medium = 'idle';
        v.zone = v.links[0] ? (v.links[0].net === LAN ? '' : v.links[0].net) : (c.zone || '');
        v.group = (v.medium === 'idle' || v.medium === 'blocked') ? v.medium : (v.zone && v.zone !== LAN ? v.zone : v.medium);
        v.gen = v.links.length ? Math.max.apply(null, v.links.map(function (L) { return G.genOf(L.st); })) : 0;
        v.online = v.medium !== 'idle' && v.medium !== 'blocked';
        var row = null;
        if (d.nlbw && d.nlbw.data && d.nlbw.columns) {
            var ci = d.nlbw.columns.indexOf('mac'), rx = d.nlbw.columns.indexOf('rx_bytes'), tx = d.nlbw.columns.indexOf('tx_bytes');
            d.nlbw.data.some(function (r) { if (String(r[ci]).toUpperCase() === mac) { row = { dn: +r[rx] || 0, up: +r[tx] || 0 }; return true; } });
        }
        v.traffic = row;
        return v;
    });
    var ORDER = { eth: 0, '5': 1, '2.4': 2, blocked: 4, idle: 5 };
    out.sort(function (a, b) {
        var ga = ORDER[a.group] != null ? ORDER[a.group] : 3, gb = ORDER[b.group] != null ? ORDER[b.group] : 3;
        if (ga !== gb) return ga - gb;
        if (ga === 3 && a.group !== b.group) return G.netRank(a.group) - G.netRank(b.group) || a.group.localeCompare(b.group);
        if (a.gen !== b.gen) return b.gen - a.gen;
        return a.name.localeCompare(b.name);
    });
    return out;
}
var GROUPWORD = { eth: 'Wired', '5': '5 GHz', '2.4': '2.4 GHz', blocked: 'Blocked', idle: 'Not connected' };
function groupWord(g) { return GROUPWORD[g] || G.netLabel(g); }

/* ═══ polls ════════════════════════════════════════════════════════════════ */
G.poll('dash', DASH, 5000);
G.poll('rate', RATE, 1500, { timeout: 4000 });
G.poll('vpn', VPN, 10000);
G.poll('rep', REP, 12000);
G.poll('usb', USB, 12000);
G.poll('set', SET, 20000);
G.poll('tools', TOOLS + '?n=60', 20000);
function loadProbe() { G.get(PROBE + '?action=list').then(function (j) { if (j && j.ok) { G.data.probe = j; G.bus.emit('data:probe', j); } }).catch(function () {}); }

/* the throughput ring: bytes/s from consecutive rate samples, kept 5 minutes */
var ring = [], rPrev = null;
G.bus.on('data:rate', function (j) {
    if (rPrev && rPrev.dev === j.dev && j.up > rPrev.up && j.rx >= rPrev.rx && j.tx >= rPrev.tx) {
        var dt = j.up - rPrev.up;
        ring.push({ t: j.up, dn: (j.rx - rPrev.rx) / dt, up: (j.tx - rPrev.tx) / dt });
        if (ring.length > 300) ring.shift();
    }
    rPrev = j;
});

/* ═══ shared bits ══════════════════════════════════════════════════════════ */
function uplinkOf(d) { return (d && d.uplink && d.uplink.active) || 'none'; }
function online(d) { return uplinkOf(d) !== 'none' && !(d.probe && d.probe.online === false); }
function pingSeries(rate) {
    var v = (rate && rate.ring && rate.ring.v) || [];
    return v.map(function (x) { return x > 0 ? x : (x === -1 ? -1 : null); });
}
function lossOf(rate) {
    var v = (rate && rate.ring && rate.ring.v) || [], probed = 0, lost = 0;
    v.forEach(function (x) { if (x === -2 || x === -3) return; probed++; if (x < 0) lost++; });
    if (!probed) return null;
    return { pct: lost * 100 / probed, lost: lost, probed: probed };
}
function jitterOf(rate) {
    var v = (rate && rate.ring && rate.ring.v) || [], s = 0, n = 0;
    for (var i = 1; i < v.length; i++) if (v[i] > 0 && v[i - 1] > 0) { s += Math.abs(v[i] - v[i - 1]); n++; }
    return n ? s / n : null;
}
function pingMax(series) { var m = 0; series.forEach(function (x) { if (x > m) m = x; }); return Math.max(40, m * 1.6); }
function fine(n) { return n >= 10 ? Math.round(n) : Math.round(n * 10) / 10; }
function lossWord(l) {
    if (!l) return ['No data', 'idle'];
    if (l.lost === 0) return ['Clean', 'ok'];
    return fine(l.pct) < 1 ? ['Patchy', 'warn'] : ['Lossy', 'bad'];
}
function jitterWord(j) { if (j == null) return ['No data', 'idle']; return j <= 5 ? ['Steady', 'ok'] : j <= 15 ? ['Uneven', 'warn'] : ['Erratic', 'bad']; }
function tunnelState(t, ts) {
    if (t.disabled) return { word: 'Off', tone: 'idle', key: 'off' };
    if (!t.up) return { word: 'Down', tone: 'bad', key: 'down' };
    if (!t.handshake) return { word: 'Connecting', tone: 'warn', key: 'connecting' };
    var age = ts - t.handshake;
    if (age > 200) return { word: 'No handshake', tone: 'bad', key: 'stale' };
    return { word: 'Connected', tone: 'ok', key: 'up', age: age };
}
function tunnelLive(t, ts) { return !t.disabled && t.up && t.handshake && (ts - t.handshake) <= 200; }
function confirm(o) { return ui.confirm(o); }
function toneOf(word) { return word[1] === 'idle' ? null : word[1]; }

/* a form section: label + controls + apply row, with dirty tracking */
function form(api, opts) {
    var f = el('div'); var dirty = false;
    var apply = ui.act(opts.applyLabel || 'Apply', 'primary', function () { opts.onApply(apply); });
    apply.disabled = true;
    var reset = ui.act('Reset', 'quiet', function () { opts.onReset(); });
    f.addEventListener('input', mark); f.addEventListener('change', mark);
    function mark(e) { if (e.target && e.target.getAttribute('data-nodirty')) return; dirty = true; apply.disabled = false; apply.className = 'act act--primary'; }
    var row = el('div', 'inline'); row.style.cssText = 'justify-content:flex-end;margin-top:4px';
    if (opts.extra) opts.extra.forEach(function (n) { row.appendChild(n); });
    row.appendChild(reset); row.appendChild(apply);
    return { root: f, row: row, apply: apply, isDirty: function () { return dirty; }, clean: function () { dirty = false; apply.disabled = true; } };
}

/* ═══ 1. PATH ═════════════════════════════════════════════════════════════ */
G.tile({
    id: 'path', order: 0, path: true, label: 'Path', icon: 'link',
    render: function (frag, X) {
        var d = X.dash, r = X.rate, v = X.vpn;
        var nodes = el('div', 'nodes');
        function node(ic, k, val, tone, open) {
            var n = el('button', 'node'); n.type = 'button'; n.setAttribute('data-tone', tone || '');
            var i = el('span', 'node__ico'); i.appendChild(icon(ic)); n.appendChild(i);
            n.appendChild(el('span', 'node__k', k)); n.appendChild(el('span', 'node__v num', val));
            n.setAttribute('aria-label', k + ': ' + val);
            n.addEventListener('click', function (e) { e.stopPropagation(); G.sheet.open(open); });
            nodes.appendChild(n);
        }
        if (!d) { node('globe', 'Internet', '…', '', 'internet'); node('link', 'Uplink', '…', '', 'uplink'); node('shield', 'VPN', '…', 'off', 'vpn'); frag.appendChild(nodes); return; }
        var up = uplinkOf(d), on = online(d);
        var ping = r && r.ping != null ? fmt.ms(r.ping) : (on ? 'Reachable' : '');
        node('globe', 'Internet', on ? ping : (up === 'none' ? 'No route' : 'Not responding'), on ? 'ok' : 'bad', 'internet');
        node(UPICON[up] || 'link', 'Uplink', UPLABEL[up] + ((d.wan && d.wan.ip) ? ' · ' + d.wan.ip : ''), up === 'none' ? 'bad' : 'ok', 'uplink');
        var routed = Object.keys(d.vpn || {}).length, stale = (d.vpn_stale || []).length;
        if (routed) node('shield', 'VPN', fmt.plural(routed, 'device') + (stale ? ' · ' + stale + ' stranded' : ''), stale ? 'bad' : 'ok', 'vpn');
        else node('shield', 'VPN', (d.tunnels_total ? fmt.plural(d.tunnels_up || 0, 'tunnel') + ' up' : 'No tunnels'), 'off', 'vpn');
        frag.appendChild(nodes);
    }
});

/* ═══ 2. DEVICES ══════════════════════════════════════════════════════════ */
G.tile({
    id: 'devices', order: 10, label: 'Devices', icon: 'devices',
    render: function (frag, X) {
        var d = X.dash;
        G.face.hd(frag, 'devices', 'Devices');
        if (!d) { G.face.value(frag, '—'); G.face.sub(frag, 'reading the network…'); return; }
        var list = devices(d), on = list.filter(function (v) { return v.online; });
        G.face.value(frag, String(on.length), on.length === 1 ? 'online' : 'online', null, true);
        var recent = (d.events || []).filter(function (e) { return e.ev === 'join' && e.name; }).slice(-3).reverse().map(function (e) { return e.name; });
        var names = recent.length ? recent : on.slice(0, 3).map(function (v) { return v.name; });
        var blocked = list.filter(function (v) { return v.medium === 'blocked'; }).length;
        G.face.sub(frag, names.join(' · ') + (blocked ? ' · ' + blocked + ' blocked' : ''));
        return { tone: blocked ? 'warn' : null };
    },
    sheet: function (body, api) {
        var filter = 'all', view = null;   /* view = mac when a device is open */
        var head = el('div'), list = el('div'), detail = el('div');
        body.appendChild(head); body.appendChild(list); body.appendChild(detail);
        function draw() {
            var d = api.data.dash; if (!d) { clear(list); list.appendChild(ui.wait(4)); return; }
            var all = devices(d);
            if (view) { drawDetail(all.filter(function (v) { return v.mac === view; })[0]); return; }
            detail.hidden = true; list.hidden = false; head.hidden = false;
            var on = all.filter(function (v) { return v.online; });
            api.meta(fmt.plural(on.length, 'device') + ' online');
            var groups = []; all.forEach(function (v) { if (v.group !== 'idle' && groups.indexOf(v.group) < 0) groups.push(v.group); });
            clear(head);
            var opts = [{ value: 'all', label: 'All' }].concat(groups.map(function (g) { return { value: g, label: groupWord(g) }; }));
            if (opts.filter(function (o) { return o.value === filter; }).length === 0) filter = 'all';
            head.appendChild(ui.pick(opts, filter, function (v) { filter = v; draw(); }));
            clear(list);
            var shown = all.filter(function (v) { return v.group !== 'idle' && (filter === 'all' || v.group === filter); });
            if (!shown.length) { list.appendChild(ui.empty('devices', 'Nobody here', 'No device is connected in this group.')); return; }
            list.appendChild(ui.cells(shown.map(function (v) {
                var right = v.links.length ? ui.fan(v.signal) : ui.mark(v.medium === 'eth' ? 'Wired' : v.medium === 'blocked' ? 'Blocked' : '', v.medium === 'eth' ? 'ok' : 'bad');
                var s = v.links.length ? (groupWord(v.links[0].band) + ' · Wi-Fi ' + v.gen + (v.signal ? ' · ' + v.signal + ' dBm' : ''))
                      : v.medium === 'eth' ? (v.wired.speed ? (v.wired.speed >= 1000 ? (v.wired.speed / 1000) + ' Gb/s' : v.wired.speed + ' Mb/s') : 'wired') : 'blocked on ' + (v.blocked[0] && v.blocked[0].ssid || 'Wi-Fi');
                return ui.cell({ k: v.zone && v.zone !== LAN ? G.netLabel(v.zone) : (v.vpn ? 'VPN · ' + v.vpn : (v.ip || '')), t: v.name, s: s, right: right, on: !!v.vpn, dim: !v.online,
                    onClick: function () { view = v.mac; draw(); } });
            })));
        }
        function drawDetail(v) {
            head.hidden = true; list.hidden = true; detail.hidden = false; clear(detail);
            if (!v) { detail.appendChild(ui.empty('devices', 'Gone', 'This device is no longer in the list.')); detail.appendChild(ui.act('Back', 'quiet', function () { view = null; draw(); })); return; }
            api.meta(v.name);
            var back = ui.act('All devices', 'quiet', function () { view = null; draw(); }, 'chevron'); back.style.cssText = 'margin:-4px 0 10px -6px'; back.firstChild.style.transform = 'rotate(180deg)';
            detail.appendChild(back);
            var L = v.links[0], st = L && L.st;
            var reads = [];
            if (L) {
                var q = G.quality(v.signal);
                reads.push(ui.readout('Signal', v.signal + ' dBm', q.word + (st.noise ? ' · SNR ' + (v.signal - st.noise) + ' dB' : ''), q.tone === 'fair' ? 'ok' : q.tone));
                reads.push(ui.readout('Link', groupWord(L.band), 'Wi-Fi ' + v.gen + (st.tx && st.tx.mhz ? ' · ' + st.tx.mhz + ' MHz' : '')));
                if (st.tx && st.tx.rate) reads.push(ui.readout('Rate', Math.round(st.tx.rate / 1000) + ' / ' + Math.round((st.rx && st.rx.rate || 0) / 1000), 'tx / rx Mb/s'));
                if (st.connected_time) reads.push(ui.readout('Connected', fmt.dur(st.connected_time), st.inactive != null ? 'idle ' + Math.round(st.inactive / 1000) + 's' : ''));
            } else if (v.medium === 'eth') {
                reads.push(ui.readout('Link', v.wired.speed ? (v.wired.speed >= 1000 ? (v.wired.speed / 1000) + ' Gb/s' : v.wired.speed + ' Mb/s') : 'Wired', (v.wired.duplex ? v.wired.duplex + ' duplex' : '') + (v.wired.port ? ' · ' + v.wired.port : ''), 'ok'));
            } else if (v.medium === 'blocked') reads.push(ui.readout('State', 'Blocked', 'on ' + v.blocked.map(function (b) { return b.ssid; }).join(', '), 'bad'));
            if (v.traffic) reads.push(ui.readout('Today', fmt.bytes(v.traffic.dn + v.traffic.up), '↓ ' + fmt.bytes(v.traffic.dn) + ' · ↑ ' + fmt.bytes(v.traffic.up)));
            if (reads.length) detail.appendChild(ui.readouts(reads));
            var neigh = v.neigh === 'REACHABLE' ? 'reachable' : v.neigh === 'FAILED' ? 'not answering ARP' : (v.neigh || '').toLowerCase();
            detail.appendChild(ui.kv([['MAC', v.mac], ['IPv4', v.ip], ['IPv6', v.ip6.join('  ')], ['Hostname', ((api.data.dash.leases || {})[v.mac] || {}).name !== '*' ? ((api.data.dash.leases || {})[v.mac] || {}).name : ''], ['Reachability', neigh], ['Internet route', v.vpn ? v.vpn + ' · VPN' : 'Direct · normal uplink'], ['Network', v.zone ? G.netLabel(v.zone) : 'Main']]));
            var acts = el('div', 'inline'); acts.style.marginBottom = '14px';
            acts.appendChild(ui.act('Rename', null, function () {
                var sel = ui.select(['phone', 'pad', 'laptop', 'computer', 'television', 'watch', 'smartappliances', 'router', 'default'].map(function (c) { return { value: c, label: c === 'smartappliances' ? 'smart appliance' : c }; }), v.cls);
                var wrap = el('div'); wrap.appendChild(ui.field('Category', sel));
                confirm({ title: 'Name this device', body: wrap, field: { label: 'Name', value: v.named ? v.name : '', placeholder: v.name }, okText: 'Save' }).then(function (val) {
                    if (val == null) return; val = String(val).trim(); if (!val) { G.pop('Name cannot be empty.', 'warn'); return; }
                    G.act(null, DASH, { action: 'setdev', mac: v.mac, name: val, 'class': sel.value }, { ok: 'Saved.', refresh: ['dash'] });
                });
            }, 'devices'));
            var tunnels = (api.data.vpn && api.data.vpn.tunnels) || [];
            if (tunnels.length && (L || v.medium === 'eth')) {
                var cur = ((api.data.vpn && api.data.vpn.policies) || []).filter(function (p) { return p.mac.toUpperCase() === v.mac && (p.enabled || p.auto_paused); })[0];
                var curName = cur ? (tunnels.filter(function (t) { return t.iface === cur.iface; })[0] || {}).name || '' : '';
                var rsel = ui.select([{ value: '', label: 'Direct · normal uplink' }].concat(tunnels.map(function (t) { return { value: t.name, label: (t.label || t.name) + (t.disabled ? '  (off)' : '') }; })), curName, { inline: true, label: 'Internet route for ' + v.name });
                rsel.setAttribute('data-nodirty', '1');
                rsel.addEventListener('change', function () {
                    G.act(null, VPN, { action: 'route', mac: v.mac, name: rsel.value }, { ok: rsel.value ? 'Routed through ' + rsel.options[rsel.selectedIndex].text : 'Back on the normal uplink.', refresh: ['vpn', 'dash'] })
                        .then(function (j) { if (j && j.ok && j.warn) G.pop(j.warn, 'warn'); });
                });
                acts.appendChild(rsel);
            }
            var sec = L ? L.section : (v.blocked[0] && v.blocked[0].section);
            if (sec) {
                var isB = v.medium === 'blocked';
                acts.appendChild(ui.act(isB ? 'Unblock' : 'Block', isB ? null : 'danger', function (b) {
                    (isB ? Promise.resolve(true) : confirm({ title: 'Block ' + v.name + '?', body: 'It is kicked off Wi-Fi now and refused until you unblock it.', okText: 'Block', danger: true })).then(function (ok) {
                        if (!ok) return;
                        G.act(b, DASH, { action: 'aclset', mac: v.mac, sec: sec, block: isB ? '0' : '1' }, { ok: isB ? 'Unblocked.' : 'Blocked.', refresh: ['dash'], delay: 3000 });
                    });
                }));
            }
            detail.appendChild(acts);
            if (st) {
                var x = v.x || {};
                detail.appendChild(ui.kv([['Transmit', st.tx ? 'MCS ' + st.tx.mcs + ' · ' + st.tx.nss + ' streams · ' + st.tx.mhz + ' MHz' : ''], ['Receive', st.rx ? 'MCS ' + st.rx.mcs + ' · ' + st.rx.nss + ' streams · ' + st.rx.mhz + ' MHz' : ''],
                    ['Expected throughput', st.thr ? Math.round(st.thr / 1000) + ' Mb/s' : ''], ['Packets', st.tx && st.tx.packets != null ? (+st.tx.packets).toLocaleString() + ' sent · ' + (+(st.rx && st.rx.packets) || 0).toLocaleString() + ' received' : ''],
                    ['Retries', st.tx && st.tx.retries != null ? (+st.tx.retries).toLocaleString() + (st.tx.packets ? ' · ' + (st.tx.retries * 100 / st.tx.packets).toFixed(1) + '%' : '') : ''],
                    ['Per antenna', x.chains ? x.chains.split(',').join(' / ') + ' dBm' : ''], ['Security', [st.authorized ? 'authorised' : '', st.mfp ? 'PMF' : '', st.wme ? 'WMM' : ''].filter(Boolean).join(' · ')]]));
            }
        }
        draw();
        api.on('dash', draw); api.on('vpn', function () { if (view) draw(); });
    }
});

/* ═══ 3. INTERNET ═════════════════════════════════════════════════════════ */
G.tile({
    id: 'internet', order: 11, label: 'Internet', icon: 'globe',
    render: function (frag, X) {
        var d = X.dash, r = X.rate;
        G.face.hd(frag, 'globe', 'Internet', r && r.ring && r.ring.name ? r.ring.name : '');
        if (!d && !r) { G.face.value(frag, '—'); return; }
        var on = d ? online(d) : true;
        var lw = lossWord(lossOf(r));
        if (!on) { G.face.value(frag, uplinkOf(d) === 'none' ? 'No route' : 'Down', null, 'bad'); }
        else if (r && r.ping != null) G.face.value(frag, fine(r.ping), 'ms', null, true);
        else G.face.value(frag, 'no reply', null, 'warn');
        var series = pingSeries(r).slice(-60);
        if (series.length > 2) frag.appendChild(ui.spark(series, { w: 120, h: 36, fill: true, dot: true, max: pingMax(series) }));
        G.face.sub(frag, lw[0] + ' · ' + (lossOf(r) ? fine(lossOf(r).pct) + '% loss' : 'no data'), toneOf(lw));
        return { tone: on ? toneOf(lw) : 'bad' };
    },
    sheet: function (body, api) {
        var top = el('div'), chart = el('div'), target = el('div'), saved = el('div');
        body.appendChild(top); body.appendChild(chart); body.appendChild(target); body.appendChild(saved);
        function live() {
            var r = api.data.rate, d = api.data.dash;
            clear(top);
            var l = lossOf(r), j = jitterOf(r), lw = lossWord(l), jw = jitterWord(j);
            var v = pingSeries(r).filter(function (x) { return x > 0; });
            var avg = v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
            top.appendChild(ui.readouts([
                ui.readout('Ping', r && r.ping != null ? fine(r.ping) : '—', avg != null ? 'avg ' + fine(avg) + ' ms over 5 min' : 'no reply', r && r.ping != null ? 'ok' : 'warn', r && r.ping != null ? 'ms' : ''),
                ui.readout('Loss', l ? fine(l.pct) : '—', lw[0] + (l ? ' · ' + l.lost + ' of ' + l.probed : ''), toneOf(lw), l ? '%' : ''),
                ui.readout('Jitter', j != null ? fine(j) : '—', jw[0], toneOf(jw), j != null ? 'ms' : '')
            ]));
            if (r && r.ring && r.ring.note) top.appendChild(ui.say(r.ring.note, 'warn'));
            else if (r && r.ring && r.ring.state === 'silent') top.appendChild(ui.say('This address does not answer pings. That is the target, not the link.', null));
            if (d && d.sys && d.sys.v6_loss != null && d.sys.v6_loss >= 0) top.appendChild(ui.say('IPv6 ' + (d.sys.v6_loss >= 100 ? 'is not reachable' : 'reachable'), d.sys.v6_loss >= 100 ? 'bad' : 'ok', 'globe'));
            clear(chart);
            var s = pingSeries(r);
            if (s.length > 2) { var sp = ui.spark(s, { w: 300, h: 90, fill: true, dot: true, zero: true, max: pingMax(s) }); sp.style.height = '110px'; chart.appendChild(sp); chart.appendChild(el('div', 'field__h', 'last 5 minutes · one probe a second · gaps are lost probes')); }
        }
        function drawTarget() {
            clear(target);
            var r = api.data.rate, p = api.data.probe, ring = r && r.ring;
            var liveSel = ring ? (ring.sel === 'custom' ? 'ip:' + ring.target : ring.sel) : (p && p.sel) || 'cf';
            var opts = [{ value: 'cf', label: 'Cloudflare' }, { value: 'google', label: 'Google' }, { value: 'gw', label: 'Gateway' }];
            ((p && p.targets) || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (t) { opts.push({ value: 'ip:' + t.ip, label: t.name + ' · ' + t.ip }); });
            if (/^ip:/.test(liveSel) && !opts.some(function (o) { return o.value === liveSel; })) opts.push({ value: liveSel, label: liveSel.slice(3) + ' (not saved)' });
            opts.push({ value: 'custom', label: 'Another address…' });
            var sel = ui.select(opts, liveSel, { label: 'What to probe' });
            var wrap = el('div', 'inline'); wrap.appendChild(sel);
            var ipIn = ui.input({ placeholder: '203.0.113.7', inputmode: 'decimal', maxlength: 15, inline: true, label: 'Address to probe' }); ipIn.hidden = true;
            var go = ui.act('Probe', 'primary sm', function (b) {
                var ip = ipIn.value.replace(/\s+/g, ''); if (!ip) return;
                G.act(b, PROBE, { action: 'set', sel: 'custom', ip: ip }, { ok: 'Probing ' + ip, refresh: ['rate'] });
            }); go.hidden = true;
            wrap.appendChild(ipIn); wrap.appendChild(go);
            sel.addEventListener('change', function () {
                if (sel.value === 'custom') { ipIn.hidden = false; go.hidden = false; ipIn.focus(); return; }
                var v = sel.value, params = /^ip:/.test(v) ? { action: 'set', sel: 'custom', ip: v.slice(3) } : { action: 'set', sel: v };
                G.act(null, PROBE, params, { ok: 'Probe target changed — the 5-minute history starts over.', refresh: ['rate'] });
            });
            ipIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
            target.appendChild(ui.field('Probe target', wrap, 'Changing it resets the history for every open console.'));
        }
        function drawSaved() {
            clear(saved);
            var p = api.data.probe; if (!p) return;
            var h = el('div', 'field__l', 'Saved addresses' + (p.targets && p.targets.length ? ' · ' + p.targets.length + ' of ' + (p.max || 12) : '')); saved.appendChild(h);
            var rows = (p.targets || []).map(function (t) {
                var del = ui.act('Remove', 'danger sm', function (b) { G.act(b, PROBE, { action: 'del', ip: t.ip }, { ok: 'Removed.' }).then(function (j) { if (j && j.ok) { G.data.probe.targets = j.targets; drawSaved(); drawTarget(); } }); });
                var b = el('span'); b.appendChild(el('b', null, t.name)); b.appendChild(document.createTextNode('  ' + t.ip));
                return ui.line(null, b, del);
            });
            if (rows.length) saved.appendChild(ui.lines(rows));
            var addIp = ui.input({ placeholder: '203.0.113.7', inputmode: 'decimal', maxlength: 15, inline: true, label: 'Address' });
            var addName = ui.input({ placeholder: 'Name (optional)', inline: true, maxlength: 24, label: 'Name' });
            var add = ui.act('Add', 'sm', function (b) {
                var ip = addIp.value.replace(/\s+/g, ''); if (!ip) return;
                G.act(b, PROBE, { action: 'add', ip: ip, name: addName.value.trim() }, { ok: 'Saved.' }).then(function (j) { if (j && j.ok) { G.data.probe.targets = j.targets; addIp.value = ''; addName.value = ''; drawSaved(); drawTarget(); } });
            }, 'plus');
            var row = el('div', 'inline'); row.style.marginTop = '8px'; row.appendChild(addIp); row.appendChild(addName); row.appendChild(add); saved.appendChild(row);
        }
        live(); drawTarget(); drawSaved();
        api.on('rate', live); api.on('dash', live); api.on('probe', function () { drawTarget(); drawSaved(); });
        if (!api.data.probe) loadProbe();
    }
});

/* ═══ 4. UPLINK (Ethernet · Wi-Fi · USB, one surface) ═════════════════════ */
G.tile({
    id: 'uplink', order: 12, label: 'Uplink', icon: 'link',
    render: function (frag, X) {
        var d = X.dash, rep = X.rep, usb = X.usb;
        var up = uplinkOf(d);
        G.face.hd(frag, UPICON[up] || 'link', 'Uplink');
        if (!d) { G.face.value(frag, '—'); return; }
        G.face.value(frag, UPLABEL[up], null, up === 'none' ? 'bad' : null);
        var bits = [];
        if (d.wan && d.wan.ip) bits.push(d.wan.ip);
        if (d.sys && d.sys.wan_uptime >= 0) bits.push('up ' + fmt.dur(d.sys.wan_uptime));
        if (rep && rep.connecting) bits = ['joining ' + (rep.uplink.ssid || 'Wi-Fi') + '…'];
        if (up === 'none') bits = [rep && rep.last_error ? 'Wi-Fi join failed' : 'no route out'];
        G.face.sub(frag, bits.join(' · '));
        return { tone: up === 'none' ? 'bad' : null };
    },
    sheet: function (body, api) {
        var seg = 'sources';
        var pick = ui.pick([{ value: 'sources', label: 'Sources' }, { value: 'wifi', label: 'Wi-Fi uplink' }, { value: 'usb', label: 'USB' }], seg, function (v) { seg = v; draw(); }, true);
        body.appendChild(pick);
        var pane = el('div'); body.appendChild(pane);
        var scanResults = null, scanAt = 0, formLive = null;
        function draw() {
            var rep = api.data.rep, usb = api.data.usb;
            clear(pane); formLive = null;
            if (seg === 'sources') return drawSources(rep || usb);
            if (seg === 'wifi') return drawWifi(rep);
            return drawUsb(usb);
        }
        function drawSources(p) {
            if (!p) { pane.appendChild(ui.wait(3)); return; }
            var ups = (p.uplinks || []).slice().sort(function (a, b) { return (b.active - a.active) || (b.up - a.up) || ((a.metric || 99) - (b.metric || 99)); });
            api.meta(UPLABEL[p.active] === 'None' ? 'no route' : 'via ' + UPLABEL[p.active]);
            var NOTE = { wan: 'Cable in the WAN port', wwan: 'Someone else’s Wi-Fi', tethering: 'Phone or modem on USB' };
            pane.appendChild(ui.cells(ups.map(function (u) {
                var word = u.active ? ['Carrying', 'ok'] : u.up ? ['Standby', null] : ['Down', 'bad'];
                return ui.cell({ k: 'metric ' + (u.metric || '—'), t: u.label, s: (u.ip || NOTE[u.name] || '') + (u.device ? ' · ' + u.device : ''), right: ui.mark(word[0], word[1]), on: !!u.active, dim: !u.up && !u.active });
            })));
            var t = ups.filter(function (u) { return u.name === 'tethering'; })[0] || {}, w = ups.filter(function (u) { return u.name === 'wwan'; })[0] || {};
            var prefersUsb = (t.metric || 99) <= (w.metric || 99);
            pane.appendChild(ui.field('When both a USB device and a Wi-Fi uplink are connected', ui.pick([{ value: 'modem', label: 'USB first' }, { value: 'wifi', label: 'Wi-Fi first' }], prefersUsb ? 'modem' : 'wifi', function (v) {
                G.act(null, USB, { action: 'priority', pref: v }, { ok: (v === 'modem' ? 'USB' : 'Wi-Fi') + ' first from now on.', refresh: ['rep', 'usb', 'dash'], delay: 1500 });
            }, true), 'Ethernet is always tried first. Lower metric wins.'));
            if (p.width && p.width.original !== p.width.current) pane.appendChild(ui.say('The ' + G.bandLabel(p.width.band) + ' radio was narrowed from ' + p.width.original.replace(/^[A-Z]+/, '') + ' to ' + p.width.current.replace(/^[A-Z]+/, '') + ' MHz to fit the uplink’s channel. It widens again when the uplink is removed.', 'warn'));
            if (p.uplink && p.last_error) pane.appendChild(ui.say(p.last_error, 'bad'));
        }
        function drawWifi(rep) {
            if (!rep) { pane.appendChild(ui.wait(3)); return; }
            var u = rep.uplink, w = rep.wwan || {};
            var connected = u.connected && w.up, carrying = rep.active === 'wwan';
            var word = !u.configured ? ['Not joined', 'idle'] : rep.connecting ? ['Connecting', 'warn'] : connected && carrying ? ['Carrying', 'ok'] : connected ? ['Standby', null] : !u.enabled ? ['Off', 'idle'] : ['Down', 'bad'];
            api.meta(word[0]);
            if (rep.last_error) { var e = ui.say(rep.last_error, 'bad'); var dis = ui.act('Dismiss', 'quiet sm', function (b) { G.act(b, REP, { action: 'clearerr' }, { ok: false, refresh: ['rep'] }); }); e.appendChild(dis); pane.appendChild(e); }
            if (u.configured) {
                var reads = [ui.readout('Network', u.assoc_ssid || u.ssid || '(unnamed)', [G.bandLabel(u.band), u.encryption === 'none' ? 'open' : (u.encryption || '').toUpperCase()].filter(Boolean).join(' · '), toneOf(word))];
                if (connected) { reads.push(ui.readout('Address', w.ip || '—', carrying ? 'carrying the default route' : 'connected, Ethernet preferred')); if (u.signal) { var q = G.quality(u.signal); reads.push(ui.readout('Signal', u.signal + ' dBm', q.word, q.tone === 'fair' ? 'ok' : q.tone)); } }
                if (rep.connecting) reads.push(ui.readout('Joining', 'up to ' + rep.connect_timeout + ' s', 'association then DHCP; falls back to Ethernet on failure', 'warn'));
                pane.appendChild(ui.readouts(reads));
                var acts = el('div', 'inline'); acts.style.marginBottom = '16px';
                acts.appendChild(ui.act(u.enabled ? 'Disconnect' : 'Connect', u.enabled ? null : 'primary', function (b) {
                    G.act(b, REP, { action: u.enabled ? 'down' : 'up' }, { ok: u.enabled ? 'Disconnecting.' : 'Connecting — give it 20 seconds.', refresh: ['rep', 'dash'], delay: 3000 });
                }));
                acts.appendChild(ui.act('Forget', 'danger', function (b) {
                    confirm({ title: 'Forget ' + (u.ssid || 'this network') + '?', body: 'The uplink is removed and the router goes back to Ethernet. The saved password is kept under Remembered.', okText: 'Forget', danger: true }).then(function (ok) {
                        if (ok) G.act(b, REP, { action: 'del' }, { ok: 'Forgotten.', refresh: ['rep', 'dash'], delay: 2000 });
                    });
                }));
                pane.appendChild(acts);
            } else pane.appendChild(ui.say('Not joined to anyone else’s Wi-Fi. Scan below to find a network; the router keeps using Ethernet until the uplink actually connects.', null, 'wifi'));
            /* scan */
            var scanHd = el('div', 'inline'); scanHd.style.cssText = 'justify-content:space-between;margin:6px 0 8px';
            scanHd.appendChild(el('span', 'field__l', 'Networks in range' + (scanResults ? ' · ' + scanResults.length + ' · ' + fmt.ago(scanAt) : '')));
            scanHd.appendChild(ui.act('Scan', 'primary sm', function (b) {
                b.disabled = true; b.classList.add('is-busy');
                G.get(REP + '?action=scan', 30000).then(function (j) {
                    b.disabled = false; b.classList.remove('is-busy');
                    if (!(j && j.ok && j.scan && j.scan.results)) { G.pop('Scan failed: ' + ((j && j.error) || 'the radio was busy — try again.'), 'bad'); return; }
                    var seen = {};
                    j.scan.results.forEach(function (n) { var k = n.ssid + '|' + (n.mhz > 3000 ? 5 : 2); if (!seen[k] || n.signal > seen[k].signal) seen[k] = n; });
                    scanResults = Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return b.signal - a.signal; });
                    scanAt = now(); G.pop(fmt.plural(scanResults.length, 'network') + ' found.', 'ok'); draw();
                }, function () { b.disabled = false; b.classList.remove('is-busy'); G.pop('Scan failed: timed out', 'bad'); });
            }, 'search'));
            pane.appendChild(scanHd);
            if (scanResults) {
                var mine = (rep.own_ssids || []).map(function (s) { return s.name; });
                pane.appendChild(ui.cells(scanResults.map(function (n) {
                    var band = n.mhz > 3000 ? '5' : '2', isMine = mine.indexOf(n.ssid) >= 0, hidden = !n.ssid || n.ssid === '(hidden)';
                    var open = !(n.encryption && n.encryption.enabled), known = (rep.known || []).indexOf(n.ssid) >= 0, isCur = n.ssid === u.ssid;
                    var tag = isMine ? 'this router' : isCur ? 'saved' : known ? 'remembered' : open ? 'open' : '';
                    var c = ui.cell({ k: (band === '5' ? '5 GHz' : '2.4 GHz') + ' · ch ' + n.channel, t: hidden ? 'Hidden network' : n.ssid, s: n.signal + ' dBm · ' + G.quality(n.signal).word + (tag ? ' · ' + tag : ''), right: ui.fan(n.signal), dim: isMine || hidden,
                        onClick: (isMine || hidden) ? null : function () { join(n, band, open, known); } });
                    return c;
                })));
            }
            function join(n, band, open, saved) {
                var offs = []; (rep.own_ssids || []).forEach(function (s) { if (s.travel_off && offs.indexOf(s.name) < 0) offs.push(s.name); });
                var bodyTxt = 'The router joins “' + n.ssid + '” on ' + (band === '5' ? '5 GHz' : '2.4 GHz') + ' and uses it as the internet when Ethernet is absent.' + (offs.length ? ' While it is joined, ' + offs.join(' and ') + ' switch off.' : '');
                var o = { title: 'Join ' + n.ssid + '?', body: bodyTxt, okText: 'Join' };
                if (!open && !saved) o.field = { label: 'Password', type: 'password', placeholder: 'Wi-Fi password' };
                confirm(o).then(function (val) {
                    if (val == null) return;
                    if (o.field && !String(val).trim()) { G.pop('This network needs a password.', 'warn'); return; }
                    G.act(null, REP, { action: 'add', ssid: n.ssid, key: (open || saved) ? '' : val, enc: open ? 'none' : 'psk', band: band }, { ok: 'Joining — up to 20 seconds.', refresh: ['rep', 'dash'], delay: 1500 })
                        .then(function (j) { if (j && j.ok && j.used_saved) G.pop('Used the remembered password.', 'ok'); });
                });
            }
            if (rep.known && rep.known.length) {
                pane.appendChild(el('div', 'field__l', 'Remembered · ' + fmt.plural(rep.known.length, 'password') + ' kept'));
                pane.appendChild(ui.lines(rep.known.map(function (s) {
                    var f = ui.act('Forget', 'danger sm', function (b) { confirm({ title: 'Forget the password for ' + s + '?', okText: 'Forget', danger: true }).then(function (ok) { if (ok) G.act(b, REP, { action: 'forget', ssid: s }, { ok: 'Forgotten.', refresh: ['rep'], delay: 400 }); }); });
                    var bb = el('span'); bb.appendChild(el('b', null, s)); if (s === u.ssid) bb.appendChild(document.createTextNode('  in use'));
                    return ui.line(null, bb, f);
                })));
            }
        }
        function drawUsb(usb) {
            if (!usb) { pane.appendChild(ui.wait(3)); return; }
            var i = usb.iface || {};
            var word = !usb.present ? ['Not detected', 'idle'] : !usb.enabled ? ['Off', 'idle'] : i.up && usb.active === 'tethering' ? ['Carrying', 'ok'] : i.up ? ['Standby', null] : usb.carrier ? ['No address', 'warn'] : ['No link', 'bad'];
            api.meta(word[0]);
            if (usb.clash) pane.appendChild(ui.say('Address clash: the device hands out ' + usb.clash.tether + ', which overlaps ' + usb.clash.with + ' on ' + usb.clash.dev + '. The USB uplink was refused. Change the phone’s hotspot subnet or the router’s LAN, then dismiss.', 'bad'));
            if (usb.usbmuxd === false) pane.appendChild(ui.say('usbmuxd is not running, so an iPhone cannot pair.', 'warn'));
            var acts = el('div', 'inline'); acts.style.marginBottom = '16px';
            if (usb.present) {
                var reads = [ui.readout('Device', usb.kind || 'USB network device', [usb.device, usb.driver].filter(Boolean).join(' · '), toneOf(word))];
                if (i.up) { reads.push(ui.readout('Address', i.ip || '—', i.gw ? 'gateway ' + i.gw : '')); reads.push(ui.readout('Up', fmt.dur(i.uptime), (i.dns && i.dns[0]) ? 'DNS ' + i.dns[0] + (i.dns.length > 1 ? ' +' + (i.dns.length - 1) : '') : '')); }
                else if (usb.enabled) reads.push(ui.readout('Link', usb.carrier ? 'up, no address' : 'down', usb.carrier ? 'hotspot off, or Trust not accepted on the phone' : 'switch on tethering on the phone', toneOf(word)));
                pane.appendChild(ui.readouts(reads));
                acts.appendChild(ui.act(usb.enabled ? 'Disconnect' : 'Connect', usb.enabled ? null : 'primary', function (b) { G.act(b, USB, { action: usb.enabled ? 'disable' : 'enable' }, { ok: usb.enabled ? 'Disconnected.' : 'Connecting.', refresh: ['usb', 'dash'], delay: 1800 }); }));
                if (usb.enabled) acts.appendChild(ui.act('Reconnect', null, function (b) { G.act(b, USB, { action: 'up' }, { ok: 'Reconnecting.', refresh: ['usb', 'dash'], delay: 3000 }).then(function (j) { if (j && j.ok && j.hint) G.pop(j.hint, 'warn', 9000); }); }));
                acts.appendChild(ui.act('Forget', 'danger', function (b) { confirm({ title: 'Forget this USB device?', body: 'The binding is cleared; plug it back in or scan to use it again.', okText: 'Forget', danger: true }).then(function (ok) { if (ok) G.act(b, USB, { action: 'forget' }, { ok: 'Forgotten.', refresh: ['usb'], delay: 1500 }); }); }));
            } else pane.appendChild(ui.say('Nothing on USB. Plug in a phone with Personal Hotspot on, or a modem — the router picks it up by itself. On an iPhone, tap Trust when it asks.', null, 'usb'));
            acts.appendChild(ui.act('Scan USB', usb.present ? null : 'primary', function (b) { G.act(b, USB, { action: 'redetect' }, { ok: false, refresh: ['usb'], delay: 1200 }).then(function (j) { if (j && j.ok) G.pop(j.device ? 'Found ' + j.device + '.' : 'No new USB device found.', j.device ? 'ok' : 'warn'); }); }, 'search'));
            pane.appendChild(acts);
            var m = usb.modem || {};
            if (m.is_modem || m.configured) {
                pane.appendChild(el('div', 'field__l', 'Modem profile' + (m.configured ? ' · saved' : '')));
                var p = m.profile || {};
                var fProto = ui.select(['qmi', 'mbim', 'ncm', '3g'].map(function (x) { return { value: x, label: x.toUpperCase() }; }), (m.proto && m.proto !== 'dhcp') ? m.proto : (m.suggest_proto || 'qmi'));
                var fDev = ui.input({ value: p.device || '', placeholder: m.suggest_device || '/dev/cdc-wdm0' });
                var fApn = ui.input({ value: p.apn || '', placeholder: 'internet' });
                var fAuth = ui.select([{ value: '', label: 'none' }, { value: 'pap', label: 'PAP' }, { value: 'chap', label: 'CHAP' }, { value: 'both', label: 'PAP or CHAP' }], p.auth || '');
                var fUser = ui.input({ value: p.username || '' }), fPass = ui.input({ type: 'password', placeholder: p.has_password ? '(saved)' : '' }), fPin = ui.input({ type: 'password', placeholder: p.has_pin ? '(saved)' : '', inputmode: 'numeric' });
                var fPdp = ui.select([{ value: '', label: 'default' }, { value: 'ipv4', label: 'ipv4' }, { value: 'ipv6', label: 'ipv6' }, { value: 'ipv4v6', label: 'ipv4v6' }], p.pdptype || '');
                var g = el('div', 'row2'); g.appendChild(ui.field('Protocol', fProto)); g.appendChild(ui.field('Control device', fDev)); g.appendChild(ui.field('APN', fApn)); g.appendChild(ui.field('Authentication', fAuth)); g.appendChild(ui.field('Username', fUser)); g.appendChild(ui.field('Password', fPass)); g.appendChild(ui.field('PIN', fPin)); g.appendChild(ui.field('PDP type', fPdp));
                pane.appendChild(g);
                var mrow = el('div', 'inline'); mrow.style.justifyContent = 'flex-end';
                if (m.configured) mrow.appendChild(ui.act('Delete profile', 'danger', function (b) { confirm({ title: 'Delete the modem profile?', okText: 'Delete', danger: true }).then(function (ok) { if (ok) G.act(b, USB, { action: 'modemclear' }, { ok: 'Profile deleted.', refresh: ['usb'], delay: 2000 }); }); }));
                mrow.appendChild(ui.act('Save profile', 'primary', function (b) {
                    G.act(b, USB, { action: 'modemsave', proto: fProto.value, device: fDev.value.trim(), apn: fApn.value.trim(), auth: fAuth.value, username: fUser.value.trim(), password: fPass.value, pincode: fPin.value, pdptype: fPdp.value }, { ok: 'Profile saved.', refresh: ['usb'], delay: 2500 });
                }));
                pane.appendChild(mrow);
            }
            if ((usb.usb && usb.usb.length) || (usb.log && usb.log.length)) {
                pane.appendChild(el('div', 'field__l', 'Port'));
                pane.appendChild(ui.lines((usb.usb || []).map(function (u) { var b = el('span'); b.appendChild(el('b', null, [u.vendor, u.product].filter(Boolean).join(' ') || u.id)); b.appendChild(document.createTextNode('  ' + u.id + (u.drivers ? ' · ' + u.drivers : '') + ' · ' + u.kind)); return ui.line(u.port, b); })));
                if (usb.log && usb.log.length) { var lg = el('div', 'field__h'); lg.style.cssText = 'font-family:var(--mono);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere'; lg.textContent = usb.log.slice(-8).join('\n'); pane.appendChild(lg); }
            }
        }
        draw();
        api.on('rep', function () { if (seg !== 'usb') draw(); }); api.on('usb', function () { if (seg !== 'wifi') draw(); });
    }
});

/* ═══ 5. VPN ══════════════════════════════════════════════════════════════ */
G.tile({
    id: 'vpn', order: 13, label: 'VPN', icon: 'shield',
    render: function (frag, X) {
        var d = X.dash, v = X.vpn;
        G.face.hd(frag, 'shield', 'VPN');
        if (!v) { G.face.value(frag, '—'); return; }
        var ts = tsOf(v), up = v.tunnels.filter(function (t) { return tunnelLive(t, ts); }).length;
        var routed = v.policies.filter(function (p) { return p.enabled; }).length, stale = d ? (d.vpn_stale || []).length : 0;
        if (!v.tunnels.length) { G.face.value(frag, 'None'); G.face.sub(frag, 'no tunnels yet'); return { on: false }; }
        G.face.value(frag, routed ? String(routed) : 'Direct', routed ? (routed === 1 ? 'device routed' : 'devices routed') : '', stale ? 'bad' : null, !!routed);
        G.face.sub(frag, up + ' of ' + v.tunnels.length + ' ' + (v.tunnels.length === 1 ? 'tunnel' : 'tunnels') + ' up' + (v.failmode === 'open' ? ' · fail open' : '') + (stale ? ' · ' + stale + ' stranded' : ''), stale ? 'bad' : null);
        return { on: routed > 0 && !stale, tone: stale ? 'bad' : null };
    },
    sheet: function (body, api) {
        var seg = 'tunnels';
        body.appendChild(ui.pick([{ value: 'tunnels', label: 'Tunnels' }, { value: 'routing', label: 'Routing' }, { value: 'access', label: 'Access' }, { value: 'dns', label: 'DNS' }], seg, function (v) { seg = v; draw(); }, true));
        var pane = el('div'); body.appendChild(pane);
        function draw() {
            var v = api.data.vpn; clear(pane);
            if (!v) { pane.appendChild(ui.wait(3)); return; }
            var ts = tsOf(v);
            if (seg === 'tunnels') drawTunnels(v, ts); else if (seg === 'routing') drawRouting(v, ts); else if (seg === 'access') drawAccess(v, ts); else drawDns(v);
        }
        function drawTunnels(v, ts) {
            var ts_ = ts, tuns = v.tunnels.slice().sort(function (a, b) { return (a.label || a.name).localeCompare(b.label || b.name); });
            api.meta(tuns.length ? fmt.plural(tuns.filter(function (t) { return tunnelLive(t, ts_); }).length, 'tunnel') + ' up' : '');
            var dead = tuns.filter(function (t) { var s = tunnelState(t, ts_); return !t.disabled && s.tone === 'bad'; });
            if (dead.length) pane.appendChild(ui.say(dead.map(function (t) { return t.label || t.name; }).join(', ') + (dead.length === 1 ? ' is' : ' are') + ' not answering. ' + (v.failmode === 'closed' ? 'Devices routed through it have no internet until it recovers — switch Routing to fail open if you are travelling.' : (v.vpnwatch === 1 ? 'Devices on it are released to the normal uplink automatically.' : v.vpnwatch === 0 ? 'Automatic release is NOT running.' : 'Automatic release has not reported in yet.')), 'bad'));
            if (tuns.length) pane.appendChild(ui.cells(tuns.map(function (t) {
                var s = tunnelState(t, ts_);
                var sub = s.key === 'up' ? '↓ ' + fmt.bytes(t.rx) + ' · handshake ' + fmt.ago(t.handshake, ts_) : (t.endpoint || '').replace(/:$/, '');
                return ui.cell({ k: t.name, t: t.label || t.name, s: sub, right: ui.mark(s.word, s.tone === 'idle' ? null : s.tone), on: s.key === 'up', dim: t.disabled, onClick: function () { tunnelDetail(t, ts_); } });
            })));
            else pane.appendChild(ui.say('No tunnels yet. Paste a WireGuard .conf from your provider below.', null, 'shield'));
            /* add */
            pane.appendChild(el('div', 'field__l', 'Add a tunnel'));
            var nm = ui.input({ placeholder: 'Name (optional, letters, digits, - _)', maxlength: 12 });
            var conf = ui.textarea({ placeholder: '[Interface]\nPrivateKey = …\nAddress = 10.2.0.2/32\nDNS = 10.2.0.1\n\n[Peer]\nPublicKey = …\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0, ::/0' });
            pane.appendChild(ui.field('Name', nm)); pane.appendChild(ui.field('WireGuard configuration', conf, 'The whole file, [Interface] and [Peer] included. Its private key stays on the router.'));
            var row = el('div', 'inline'); row.style.justifyContent = 'flex-end';
            row.appendChild(ui.act('Add tunnel', 'primary', function (b) {
                var c = conf.value; if (!c.trim() || !/\[Interface\]/i.test(c) || !/PrivateKey/i.test(c)) { G.pop('That does not look like a WireGuard config.', 'warn'); return; }
                G.act(b, VPN, { action: 'add', name: nm.value.trim(), conf: c }, { ok: 'Added — press Connect on it.', refresh: ['vpn'], delay: 400 }).then(function (j) { if (j && j.ok) { conf.value = ''; nm.value = ''; if (j.warn) G.pop(j.warn, 'warn', 9000); } });
            }, 'plus'));
            pane.appendChild(row);
        }
        function tunnelDetail(t, ts) {
            var s = tunnelState(t, ts);
            var box = el('div');
            box.appendChild(ui.kv([['State', s.word], ['Endpoint', (t.endpoint || '').replace(/:$/, '')], ['Interface', t.iface], ['Addresses', t.addresses], ['DNS', t.dns || 'none usable'], ['MTU', t.mtu || '1420'], ['Handshake', t.handshake ? fmt.ago(t.handshake, ts) : 'never'], ['Transfer', '↓ ' + fmt.bytes(t.rx) + ' · ↑ ' + fmt.bytes(t.tx)], ['Server key', t.public_key ? t.public_key.slice(0, 20) + '…' : '']]));
            var routed = api.data.vpn.policies.filter(function (p) { return p.iface === t.iface && p.enabled; }).length;
            confirm({ title: t.label || t.name, body: box, okText: t.disabled ? 'Connect' : 'Disconnect', cancelText: 'Close' }).then(function (ok) {
                if (!ok) return;
                G.act(null, VPN, { action: t.disabled ? 'up' : 'down', name: t.name }, { ok: t.disabled ? 'Connecting.' : 'Disconnected.', refresh: ['vpn', 'dash'], delay: 2200 });
            });
            /* a second, quieter way out: delete */
            var del = ui.act('Delete tunnel', 'danger sm', function () {
                confirm({ title: 'Delete ' + (t.label || t.name) + '?', body: 'Its key is gone for good' + (routed ? ', and ' + fmt.plural(routed, 'device') + ' routed through it go back to the normal uplink' : '') + '.', okText: 'Delete', danger: true }).then(function (ok) { if (ok) G.act(null, VPN, { action: 'del', name: t.name }, { ok: 'Deleted.', refresh: ['vpn', 'dash'], delay: 1200 }); });
            }); del.style.marginTop = '8px'; box.appendChild(del);
        }
        function drawRouting(v, ts) {
            var d = api.data.dash, devs = d ? devices(d) : [];
            var tuns = v.tunnels.slice().sort(function (a, b) { return (a.label || a.name).localeCompare(b.label || b.name); });
            var byIface = {}; tuns.forEach(function (t) { byIface[t.iface] = t; });
            var pol = {}; v.policies.forEach(function (p) { if (p.enabled || p.auto_paused) pol[p.mac.toUpperCase()] = p; });
            var routed = v.policies.filter(function (p) { return p.enabled; }).length;
            api.meta(routed ? fmt.plural(routed, 'device') + ' routed' : 'all direct');
            var wants = v.policies.some(function (p) { return p.enabled; });
            if (wants && v.pbr_active === false) pane.appendChild(ui.say('Per-device routing is not applying — pbr is not running. ' + (v.pbr_rules === 0 ? 'Start it.' : ''), 'bad'));
            if (wants && v.pbr_active === false) { var st = ui.act('Start routing', 'primary sm', function (b) { G.act(b, VPN, { action: 'pbrstart' }, { ok: 'Routing is applying.', refresh: ['vpn'], delay: 700 }); }); st.style.marginBottom = '12px'; pane.appendChild(st); }
            var unrouted = v.policies.filter(function (p) { var t = byIface[p.iface]; return p.enabled && p.carrying === false && t && !t.disabled && t.up; });
            if (unrouted.length) pane.appendChild(ui.say(fmt.plural(unrouted.length, 'device') + ' set to use a tunnel but nothing is routing through it — a policy-routing fault, not the tunnel.', 'warn'));
            /* devices: present ones plus any absent one that still has a rule */
            var rows = devs.filter(function (x) { return x.online && !(x.zone === 'iot'); });
            Object.keys(pol).forEach(function (mac) { if (!rows.some(function (x) { return x.mac === mac; })) rows.push({ mac: mac, name: ((d && d.classmap && d.classmap[mac]) || {}).name || mac, online: false, ip: '', medium: 'idle', links: [] }); });
            rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
            if (!rows.length) { pane.appendChild(ui.wait(3)); return; }
            pane.appendChild(el('div', 'field__l', 'Where each device’s internet goes'));
            pane.appendChild(ui.lines(rows.map(function (x) {
                var p = pol[x.mac], t = p ? byIface[p.iface] : null;
                var sel = ui.select([{ value: '', label: 'Direct' }].concat(tuns.map(function (tt) { return { value: tt.name, label: (tt.label || tt.name) + (tt.disabled ? '  (off)' : '') }; })), t ? t.name : '', { inline: true, label: 'Route for ' + x.name });
                sel.addEventListener('change', function () { G.act(null, VPN, { action: 'route', mac: x.mac, name: sel.value }, { ok: sel.value ? 'Routed.' : 'Direct.', refresh: ['vpn', 'dash'] }).then(function (j) { if (j && j.ok && j.warn) G.pop(j.warn, 'warn', 8000); }); });
                var b = el('span'); b.appendChild(el('b', null, x.name)); if (!x.online) b.appendChild(document.createTextNode('  not connected')); else if (p && p.auto_paused) b.appendChild(document.createTextNode('  waiting for the tunnel'));
                return ui.line(null, b, sel);
            })));
            /* fail mode */
            pane.appendChild(ui.field('If a tunnel goes down', ui.pick([{ value: 'closed', label: 'Block the device' }, { value: 'open', label: 'Keep it online' }], v.failmode === 'open' ? 'open' : 'closed', function (m) {
                G.act(null, VPN, { action: 'failmode', mode: m }, { ok: m === 'open' ? 'Devices stay online without the tunnel while it is down.' : 'Devices are held private: no tunnel, no internet.', refresh: ['vpn'], delay: 400 });
            }, true), v.failmode === 'open' ? 'Not private while the tunnel is down: after three minutes without an answer the device is sent to the normal uplink, and put back when the tunnel returns.' : 'Stays private: a device pinned to a dead tunnel has no internet until it recovers.'));
            if (v.autopaused > 0) pane.appendChild(ui.say(fmt.plural(v.autopaused, 'route') + ' paused because a tunnel stopped responding; they resume on their own.', 'warn'));
            var pa = ui.act('Send every device to the normal uplink', 'danger sm', function (b) {
                confirm({ title: 'Pause all VPN routing?', body: 'Every routed device goes back to the normal uplink. Routing has to be set again per device afterwards — the tunnels themselves stay up.', okText: 'Pause all', danger: true }).then(function (ok) { if (ok) G.act(b, VPN, { action: 'pauseall' }, { ok: 'All devices are on the normal uplink.', refresh: ['vpn', 'dash'] }); });
            }); pane.appendChild(pa);
        }
        function drawAccess(v, ts) {
            var tp = v.transport || {}, road = tp.road, admin = tp.admin;
            if (!road && !admin) { pane.appendChild(ui.empty('key', 'No home access', 'This router has no road-warrior or admin tunnel configured.')); api.meta(''); return; }
            function hs(t) { if (!t.up) return ['switched off', 'idle']; var p = t.peer || {}; if (!p.handshake) return ['never connected', 'bad']; var age = ts - p.handshake; return age < 180 ? ['working', 'ok'] : age < 600 ? [(p.keepalive > 0 ? 'quiet' : 'idle'), p.keepalive > 0 ? 'warn' : 'ok'] : ['not working', 'bad']; }
            if (road) {
                var off = road.disabled, down = road.relay === 'down';
                api.meta(off ? 'home access off' : down ? 'relay unreachable' : fmt.plural((road.devices || []).length, 'device'));
                var w = hs(road);
                var reads = [ui.readout('Home access', off ? 'Off' : 'On', off ? (road.auto_off ? 'paused while off the wired line; reopens itself' : 'switched off') : w[0], off ? null : (w[1] === 'idle' ? null : w[1]))];
                if (road.today_rx || road.today_tx) reads.push(ui.readout('Today', fmt.bytes(road.today_rx + road.today_tx), '↑ ' + fmt.bytes(road.today_tx) + ' · ↓ ' + fmt.bytes(road.today_rx)));
                pane.appendChild(ui.readouts(reads));
                var acts = el('div', 'inline'); acts.style.marginBottom = '14px';
                acts.appendChild(ui.act(off ? 'Turn on' : 'Turn off', off ? 'primary' : 'danger', function (b) {
                    confirm({ title: (off ? 'Turn on' : 'Turn off') + ' home access?', body: off ? 'Your own devices can reach this network from outside again.' : 'Every device using it loses the way in until it is switched back on.', okText: off ? 'Turn on' : 'Turn off', danger: !off }).then(function (ok) { if (ok) G.act(b, WG, { action: 'settunnel', iface: road.iface, state: off ? 'on' : 'off' }, { ok: off ? 'Home access on.' : 'Home access off.', refresh: ['vpn'], delay: 3000 }); });
                }));
                acts.appendChild(ui.act('Add device', off || down ? null : 'primary', function (b) {
                    var routeAll = false; var pk = ui.pick([{ value: 'lan', label: 'This network only' }, { value: 'all', label: 'All traffic' }], 'lan', function (val) { routeAll = val === 'all'; }, true);
                    var wrap = el('div'); wrap.appendChild(ui.field('Route through home', pk));
                    confirm({ title: 'Add a device', body: wrap, field: { label: 'Device name', placeholder: 'iPhone' }, okText: 'Create' }).then(function (name) {
                        if (name == null) return; if (!String(name).trim()) { G.pop('Give the device a name.', 'warn'); return; }
                        G.act(b, WG, { action: 'addpeer', iface: road.iface, name: String(name).trim(), route: routeAll ? 'all' : 'lan' }, { ok: false, refresh: ['vpn'], delay: 300 }).then(function (j) {
                            if (!(j && j.ok)) return;
                            var box = el('div'); box.appendChild(ui.say('Scan this once with the WireGuard app. The private key inside it is shown now and never again.', 'warn'));
                            box.appendChild(ui.qr(j.config)); var ta = ui.textarea({ value: j.config }); ta.readOnly = true; ta.style.minHeight = '140px'; box.appendChild(ta);
                            confirm({ title: j.name + ' · ' + j.address, body: box, okText: 'Done', cancelText: 'Close' });
                        });
                    });
                }, 'plus'));
                if (off || down) acts.lastChild.disabled = true;
                pane.appendChild(acts);
                var devs = (road.devices || []).slice().sort(function (a, b) { return (b.handshake || 0) - (a.handshake || 0); });
                if (off) pane.appendChild(ui.say('Devices appear here while home access is on.', null, 'key'));
                else if (down) pane.appendChild(ui.say('The relay server is not answering, so the device list cannot be read. Devices may still be connected.', 'warn'));
                else if (!devs.length) pane.appendChild(ui.say('No devices yet — add one and scan its code with the WireGuard app.', null, 'key'));
                else pane.appendChild(ui.cells(devs.map(function (dv) {
                    var age = dv.handshake ? ts - dv.handshake : null;
                    var state = age == null ? ['never connected', null] : age >= 86400 ? ['inactive', null] : age < 180 ? ['connected', 'ok'] : [fmt.ago(dv.handshake, ts), null];
                    return ui.cell({ k: dv.address, t: dv.name, s: (dv.rx || dv.tx) ? '↑ ' + fmt.bytes(dv.rx) + ' · ↓ ' + fmt.bytes(dv.tx) : 'no traffic yet', right: ui.mark(state[0], state[1]), on: state[1] === 'ok', onClick: function () {
                        var box = el('div'); box.appendChild(ui.kv([['Last connected', age == null ? 'never' : fmt.ago(dv.handshake, ts)], ['Address', dv.address], ['From this device', fmt.bytes(dv.rx)], ['To this device', fmt.bytes(dv.tx)], ['Key', dv.public_key.slice(0, 20) + '…']]));
                        var rn = ui.act('Rename', 'sm', function () { confirm({ title: 'Rename', field: { label: 'Name', value: dv.name }, okText: 'Save' }).then(function (nmv) { if (nmv == null || !String(nmv).trim()) return; G.act(null, WG, { action: 'setdevicename', iface: road.iface, public_key: dv.public_key, name: String(nmv).trim() }, { ok: 'Renamed.', refresh: ['vpn'], delay: 300 }); }); });
                        var rm = ui.act('Remove', 'danger sm', function () { confirm({ title: 'Remove ' + dv.name + '?', body: 'It has to be added and scanned again to come back.', okText: 'Remove', danger: true }).then(function (ok) { if (ok) G.act(null, WG, { action: 'delpeer', iface: road.iface, public_key: dv.public_key }, { ok: 'Removed.', refresh: ['vpn'] }); }); });
                        var r = el('div', 'inline'); r.appendChild(rn); r.appendChild(rm); box.appendChild(r);
                        confirm({ title: dv.name, body: box, okText: 'Close', cancelText: 'Back' });
                    } });
                })));
                var rp = road.peer || {};
                pane.appendChild(ui.kv([['Relay server', rp.endpoint ? rp.endpoint + (rp.endpoint_port ? ':' + rp.endpoint_port : '') : ''], ['Keepalive', rp.keepalive ? rp.keepalive + ' s' : ''], ['MTU', road.mtu || 'automatic'], ['Interface', road.iface]]));
                var rrow = el('div', 'inline'); rrow.style.marginBottom = '14px';
                rrow.appendChild(ui.act('Change relay address', 'sm', function () { confirm({ title: 'Relay server', body: 'Change this only when the server itself is renumbered. Every tunnel that points at the old address follows; getting it wrong while remote loses the way in.', field: { label: 'Host or address', value: rp.endpoint || '' }, okText: 'Change', danger: true }).then(function (h) { if (h == null) return; h = String(h).trim(); if (!h || h === rp.endpoint) { G.pop(h ? 'That is the address it already uses.' : 'Enter an address.', 'warn'); return; } G.act(null, WG, { action: 'setvpshost', host: h, old: rp.endpoint }, { ok: 'Relay address changed.', refresh: ['vpn'], delay: 4000 }); }); }));
                rrow.appendChild(ui.act('Re-dial', 'sm', function (b) { confirm({ title: 'Re-dial home access?', body: 'Drops and re-establishes the tunnel — a few seconds.', okText: 'Re-dial' }).then(function (ok) { if (ok) G.act(b, WG, { action: 'redial', iface: road.iface }, { ok: 'Re-dialling.', refresh: ['vpn'], delay: 5000 }); }); }));
                pane.appendChild(rrow);
            }
            if (admin) {
                var aw = hs(admin); var ap = admin.peer || {};
                pane.appendChild(el('div', 'field__l', 'Admin link'));
                pane.appendChild(ui.readouts([ui.readout('Maintenance path', aw[0], ap.handshake ? 'last answered ' + fmt.ago(ap.handshake, ts) : 'never answered', aw[1] === 'idle' ? null : aw[1])]));
                pane.appendChild(ui.kv([['Server', ap.endpoint ? ap.endpoint + (ap.endpoint_port ? ':' + ap.endpoint_port : '') : ''], ['Keepalive', ap.keepalive ? ap.keepalive + ' s' : ''], ['Interface', admin.iface]]));
                var ar = ui.act('Re-dial admin link', 'sm', function (b) { confirm({ title: 'Re-dial the admin link?', body: 'If you are connected through it, this cuts you off for a few seconds.', okText: 'Re-dial', danger: true }).then(function (ok) { if (ok) G.act(b, WG, { action: 'redial', iface: admin.iface }, { ok: 'Re-dialling.', refresh: ['vpn'], delay: 5000 }); }); });
                pane.appendChild(ar);
            }
        }
        function drawDns(v) {
            api.meta('');
            var vd = v.vpndns || {};
            var notes = { unprotected: ['IPv6 leak protection is NOT in force: ' + vd.routed + ' routed device(s), and the firewall carries no IPv6 rules for them.', 'bad'], external: ['The firewall is refusing its ruleset because of a file outside this console; protection is still in force from the last good load.', 'warn'], 'rejected-v6only': ['The DNS redirect was refused and dropped. IPv6 is still blocked; routed devices resolve through the normal uplink.', 'warn'], nofirewall: ['There is no firewall loaded. Nothing is filtered, and this console has no login.', 'bad'] };
            if (notes[vd.state]) pane.appendChild(ui.say(notes[vd.state][0], notes[vd.state][1]));
            if (vd.state === 'nodns' && vd.nodns && vd.nodns.length) pane.appendChild(ui.say('No usable DNS server on ' + fmt.plural(vd.nodns.length, 'routed tunnel') + '. IPv6 is still blocked for those devices.', 'warn'));
            pane.appendChild(ui.readouts([ui.readout('Tunnel DNS', vd.state === 'ok' ? 'Protected' : vd.state === 'idle' ? 'Idle' : (vd.state || 'unknown'), vd.routed ? fmt.plural(vd.routed, 'routed device') + ' · ' + (vd.v6_rules || 0) + ' IPv6 rules' : 'nothing routed', vd.state === 'ok' ? 'ok' : vd.state === 'idle' ? null : 'warn')]));
            var td = v.traveldns;
            if (td && td.state !== 'off' && td.state !== 'unknown') {
                var tw = td.state === 'active' ? ['Plaintext fallback', 'warn'] : td.state === 'settling' ? ['Switching', 'warn'] : td.state === 'pending' ? ['Fallback not loaded', 'bad'] : td.state === 'indeterminate' ? ['Cannot tell', 'warn'] : [td.state, 'warn'];
                pane.appendChild(ui.readouts([ui.readout('Travel DNS', tw[0], (td.servers && td.servers.length) ? td.servers.join(', ') : 'this network’s resolver', tw[1])]));
                if (td.state === 'pending') pane.appendChild(ui.say('The fallback is written but dnsmasq has not loaded it. Over SSH: /etc/init.d/dnsmasq reload', 'bad'));
                else pane.appendChild(ui.say('On a hotel or phone uplink, DNS goes to that network’s own resolver in plain text so captive portals can appear. Encrypted DNS returns at home.', null));
            }
            var a = v.adguard;
            if (a) {
                var word = a.up === false ? (a.reason === 'auth' ? ['Credential stale', 'warn'] : ['Down', 'bad']) : (a.upfail && a.upfail.recent >= 2) ? ['Upstreams failing', 'bad'] : a.protection ? ['Filtering', 'ok'] : ['Paused', 'warn'];
                var reads = [ui.readout('Content filtering', word[0], a.up ? (a.reason || '') : (a.reason === 'auth' ? 'service fine, the console’s credential no longer matches' : 'DNS is down with it — /etc/init.d/adguardhome restart over SSH'), word[1])];
                if (a.up) { reads.push(ui.readout('Queries · 24 h', (a.queries || 0).toLocaleString(), '')); reads.push(ui.readout('Blocked', (a.blocked || 0).toLocaleString(), a.queries ? (Math.round(a.blocked * 1000 / a.queries) / 10) + '% of all queries' : '')); }
                pane.appendChild(ui.readouts(reads));
                if (a.up && a.upfail && a.upfail.recent >= 2) pane.appendChild(ui.say(a.upfail.recent + ' upstream failures in the last 30 minutes, last at ' + a.upfail.last + '. Encrypted DNS is not answering; lookups may be slow or fail.', 'bad'));
                if (a.up) { var r = el('div', 'inline'); r.appendChild(ui.act(a.protection ? 'Pause filtering' : 'Resume filtering', a.protection ? null : 'primary', function (b) { G.act(b, VPN, { action: 'aghprot', state: a.protection ? 'off' : 'on' }, { ok: a.protection ? 'Filtering paused.' : 'Filtering on.', refresh: ['vpn'], delay: 300 }); })); var portal = el('a', 'act'); portal.href = 'http://' + location.hostname + ':3010/'; portal.target = '_blank'; portal.rel = 'noopener'; portal.textContent = 'Open the AdGuard portal'; r.appendChild(portal); pane.appendChild(r); }
            }
        }
        draw();
        api.on('vpn', draw); api.on('dash', function () { if (seg === 'routing') draw(); });
    }
});

/* ═══ 6. RADIOS ═══════════════════════════════════════════════════════════ */
function radioWord(r) { if (r.disabled) return ['Off', 'idle']; if (!r.current) return ['Down', 'bad']; return ['Up', 'ok']; }
G.tile({
    id: 'radios', order: 14, label: 'Radios', icon: 'wifi',
    render: function (frag, X) {
        var s = X.set, d = X.dash;
        G.face.hd(frag, 'wifi', 'Radios');
        if (!s || !s.wireless) { G.face.value(frag, '—'); return; }
        var rs = s.wireless.radios, up = rs.filter(function (r) { return r.current; }).length;
        G.face.value(frag, up + ' of ' + rs.length, 'up', up < rs.filter(function (r) { return !r.disabled; }).length ? 'warn' : null);
        var bits = rs.filter(function (r) { return r.current; }).map(function (r) { return G.bandLabel(r.band) + ' ch ' + r.current.channel + ' · ' + r.current.width + ' MHz'; });
        var clients = d ? devices(d).filter(function (v) { return v.links.length; }).length : null;
        G.face.sub(frag, bits.join(' · ') || (rs.every(function (r) { return r.disabled; }) ? 'all radios off' : 'starting…'));
        return { on: up > 0 && up === rs.length, tone: up < rs.filter(function (r) { return !r.disabled; }).length ? 'warn' : null };
    },
    sheet: function (body, api) {
        var built = false, cur = null, pane = null, isDirty = function () { return false; };
        function boot() {
            clear(body); var s = api.data.set;
            if (!s) { body.appendChild(ui.wait(4)); return; }
            var rs = s.wireless.radios.slice().sort(function (a, b) { return (a.band || '').localeCompare(b.band || ''); });
            cur = rs[0] && rs[0].id;
            body.appendChild(ui.pick(rs.map(function (r) { return { value: r.id, label: G.bandLabel(r.band) }; }), cur, function (v) { cur = v; draw(); }, true));
            pane = el('div'); body.appendChild(pane); built = true; draw();
        }
        function draw() {
            clear(pane); isDirty = function () { return false; };
            var r = api.data.set.wireless.radios.filter(function (x) { return x.id === cur; })[0]; if (!r) return;
            var w = radioWord(r); api.meta(w[0]);
            var live = r.current;
            var reads = [ui.readout('State', w[0], live ? 'ch ' + live.channel + ' · ' + live.freq + ' MHz · ' + live.width + ' MHz wide · ' + live.txpower + ' dBm' : (r.disabled ? 'switched off' : 'no access point running'), toneOf(w))];
            var clients = api.data.dash ? devices(api.data.dash).filter(function (v) { return v.links.some(function (L) { return L.band === (r.band === '5g' ? '5' : '2.4'); }); }).length : null;
            if (clients != null) reads.push(ui.readout('Devices', String(clients), 'on this band'));
            pane.appendChild(ui.readouts(reads));
            var cfgW = parseInt(String(r.htmode).replace(/^[A-Z]+/, ''), 10) || 20;
            if (live && !r.disabled && (String(live.channel) !== String(r.channel) || live.width !== cfgW)) pane.appendChild(ui.say('Running ch ' + live.channel + ' at ' + live.width + ' MHz, configured ch ' + r.channel + ' at ' + cfgW + ' MHz. ' + (r.band === '2g' && live.width < cfgW ? 'Neighbouring 2.4 GHz networks forced the width down.' : 'The radio negotiated it; the configured value is still the target.'), null));
            /* the form */
            var f = form(api, { onApply: apply, onReset: draw }); isDirty = f.isDirty;
            var en = ui.check('Radio on', !r.disabled);
            var ssid = ui.input({ value: r.ssid, maxlength: 32 }), key = ui.input({ type: 'password', placeholder: 'unchanged', autocomplete: 'new-password' });
            var chSel = ui.select(r.channels.map(function (c) { return { value: String(c.c), label: c.c + ' · ' + c.f + ' MHz' + (c.dfs ? ' · radar' : '') }; }), String(r.channel));
            var modeSel = ui.select([], r.htmode);
            var GW = { HT: [20, 40], VHT: [20, 40, 80, 160], HE: [20, 40, 80, 160], EHT: [20, 40, 80, 160] };
            function modes() {
                var c = r.channels.filter(function (x) { return String(x.c) === chSel.value; })[0], maxw = c ? c.maxw : 20, opts = [];
                [20, 40, 80, 160].forEach(function (wd) { if (wd > maxw) return; (r.gens || []).forEach(function (g) { if (GW[g].indexOf(wd) >= 0) opts.push(g + wd); }); });
                var want = modeSel.value || r.htmode; clear(modeSel);
                opts.forEach(function (m) { var o = el('option', null, m.replace(/^(HT|VHT|HE|EHT)/, function (g) { return ({ HT: 'Wi-Fi 4 · ', VHT: 'Wi-Fi 5 · ', HE: 'Wi-Fi 6 · ', EHT: 'Wi-Fi 7 · ' })[g]; }) + ' MHz'); o.value = m; if (m === want) o.selected = true; modeSel.appendChild(o); });
                if (opts.indexOf(want) < 0) { var ph = el('option', null, 'pick a mode for channel ' + chSel.value); ph.value = ''; ph.selected = true; ph.disabled = true; modeSel.insertBefore(ph, modeSel.firstChild); }
            }
            modes(); chSel.addEventListener('change', modes);
            var pw = ui.select(r.txopts.length ? r.txopts.map(function (o) { return { value: String(o[0]), label: o[0] + '% · ' + o[1] + ' dBm' }; }) : [{ value: String(r.txpct), label: r.txpct + '% — radio is off' }], String(r.txpct));
            pw.setAttribute('data-nodirty', '1'); if (!r.txopts.length) pw.disabled = true;
            pw.addEventListener('change', function (e) { e.stopPropagation(); G.act(null, SET, { action: 'setpower', radio: r.id, pct: pw.value }, { ok: 'Power set.', refresh: ['set'], delay: 1500 }); });
            f.root.appendChild(en.row);
            f.root.appendChild(ui.field('Network name', ssid)); f.root.appendChild(ui.field('Password', key, 'Leave blank to keep the current one. 8–63 characters.'));
            var g = el('div', 'row2'); g.appendChild(ui.field('Channel', chSel)); g.appendChild(ui.field('Mode', modeSel)); f.root.appendChild(g);
            f.root.appendChild(ui.field('Transmit power', pw, 'Applies immediately, nothing disconnects.'));
            var restart = ui.act('Restart radio', 'danger sm', function (b) { confirm({ title: 'Restart the ' + G.bandLabel(r.band) + ' radio?', body: 'Every device on this band drops for a few seconds.', okText: 'Restart', danger: true }).then(function (ok) { if (ok) G.act(b, DASH, { action: 'fixradio', radio: r.id }, { ok: 'Restarting.', refresh: ['set', 'dash'], delay: 4000 }); }); });
            f.row.insertBefore(restart, f.row.firstChild); restart.style.marginRight = 'auto';
            f.root.appendChild(f.row); pane.appendChild(f.root);
            function apply(btn) {
                if (!modeSel.value) { G.pop('Pick a mode that channel ' + chSel.value + ' supports.', 'warn'); return; }
                var off = !en.input.checked && !r.disabled;
                confirm({ title: off ? 'Switch the ' + G.bandLabel(r.band) + ' radio off?' : 'Apply to ' + G.bandLabel(r.band) + '?', body: off ? 'Every device on this band loses Wi-Fi.' : 'The radio reloads; devices on it drop for 10–15 seconds.', okText: off ? 'Switch off' : 'Apply', danger: off }).then(function (ok) {
                    if (!ok) return;
                    G.act(btn, SET, { action: 'setwifi', radio: r.id, enabled: en.input.checked ? '1' : '0', ssid: ssid.value, key: key.value, channel: chSel.value, htmode: modeSel.value }, { ok: 'Applied — the radio is reloading.', refresh: ['set', 'dash'], delay: 6000 }).then(function (j) { if (j && j.ok) f.clean(); });
                });
            }
        }
        boot(); api.on('set', function () { if (!built) boot(); else if (!isDirty()) draw(); });
    }
});

/* ═══ 7/8. GUEST · IoT (secondary networks) ═══════════════════════════════ */
function secondary(X, net) { var s = X.set; if (!s || !s.wireless) return null; return s.wireless.secondary.filter(function (n) { return n.network === net; })[0] || null; }
function secondaryTile(id, net, ic, label, order) {
    G.tile({
        id: id, order: order, label: label, icon: ic,
        toggle: {
            read: function (X) { var n = secondary(X, net); return n ? !n.disabled : null; },
            write: function (v, ctx) {
                var n = secondary(ctx.data, net); if (!n) return Promise.resolve();
                var reload = (n.bands && n.bands.length > 1 ? 'Both radios reload' : 'The radio reloads') + ' — every network on them drops for a few seconds.';
                return confirm({ title: (v ? 'Turn on ' : 'Turn off ') + label + '?', body: v ? '“' + n.ssid + '” starts advertising again. ' + reload : '“' + n.ssid + '” disappears and its devices lose Wi-Fi. ' + reload, okText: v ? 'Turn on' : 'Turn off', danger: !v })
                    .then(function (ok) { if (!ok) return; return G.act(null, SET, { action: 'setiot', network: net, enabled: v ? '1' : '0', ssid: n.ssid, key: '' }, { ok: label + (v ? ' on.' : ' off.'), refresh: ['set', 'dash', 'rep'], delay: 8000 }); });
            }
        },
        render: function (frag, X) {
            var n = secondary(X, net);
            G.face.hd(frag, ic, label);
            if (!n) { G.face.value(frag, X.set ? 'None' : '—'); if (X.set) G.face.sub(frag, 'no ' + label.toLowerCase() + ' network on this router'); return { on: false }; }
            var cnt = X.dash ? devices(X.dash).filter(function (v) { return v.online && v.zone === net; }).length : null;
            G.face.value(frag, n.disabled ? 'Off' : 'On');
            G.face.sub(frag, n.ssid + (cnt != null && !n.disabled ? ' · ' + fmt.plural(cnt, 'device') : '') + (n.bands && n.bands.length > 1 ? ' · both bands' : ''));
            return { on: !n.disabled };
        },
        sheet: function (body, api) {
            if (!api.data.set) { body.appendChild(ui.wait(3)); var once = false; api.on('set', function () { if (!once) { once = true; clear(body); build(); } }); return; }
            build();
            function build() {
            var n = secondary(api.data, net); if (!n) { body.appendChild(ui.empty(ic, 'No ' + label.toLowerCase() + ' network', 'Nothing on this router is attached to a network called ' + net + '.')); return; }
            api.meta(n.disabled ? 'off' : 'on');
            var facts = [n.bands.length ? n.bands.map(G.bandLabel).join(' + ') : 'no radio', n.isolate ? 'isolated from the main network' : 'not isolated'];
            body.appendChild(ui.say(facts.join(' · ') + (n.legacy ? '. Advertises WPA2-PSK alone, so old devices can join.' : ''), null, ic));
            if (n.split) body.appendChild(ui.say('The two bands of this network have drifted apart (different name or password). Applying writes the same to both.', 'warn'));
            if (net === 'guest') {
                var qbox = el('div'); body.appendChild(qbox);
                function drawQr() { clear(qbox); G.get(TOOLS + '?action=guestqr').then(function (j) { if (!(j && j.ok && j.present)) return; var q = ui.qr(j.wifi); qbox.appendChild(q); qbox.appendChild(el('div', 'field__h', (j.enabled ? 'Scan with a phone camera to join ' : 'Guest is off — the code works once it is on. ') + '“' + j.ssid + '”.')); qbox.lastChild.style.textAlign = 'center'; }).catch(function () {}); }
                drawQr();
            }
            var f = form(api, { onApply: apply, onReset: function () { G.sheet.open(id); } });
            var en = ui.check('Network on', !n.disabled), ssid = ui.input({ value: n.ssid, maxlength: 32 }), key = ui.input({ type: 'password', placeholder: 'unchanged', autocomplete: 'new-password' });
            f.root.appendChild(en.row); f.root.appendChild(ui.field('Network name', ssid)); f.root.appendChild(ui.field('Password', key, 'Leave blank to keep the current one.'));
            f.root.appendChild(f.row); body.appendChild(f.root);
            function apply(btn) {
                var off = !en.input.checked && !n.disabled;
                confirm({ title: 'Apply to ' + label + '?', body: (n.bands.length > 1 ? 'Both radios reload' : 'The radio reloads') + ' — every network on them drops for a few seconds.' + (off ? ' Devices on ' + label + ' lose Wi-Fi.' : ''), okText: 'Apply', danger: off }).then(function (ok) {
                    if (!ok) return;
                    G.act(btn, SET, { action: 'setiot', network: net, enabled: en.input.checked ? '1' : '0', ssid: ssid.value, key: key.value }, { ok: 'Applied.', refresh: ['set', 'dash'], delay: 8000 }).then(function (j) { if (j && j.ok) f.clean(); });
                });
            }
            }
        }
    });
}
secondaryTile('guest', 'guest', 'users', 'Guest Wi-Fi', 15);
secondaryTile('iot', 'iot', 'plug', 'IoT', 16);

/* ═══ 9. THROUGHPUT ═══════════════════════════════════════════════════════ */
function unitFor(max) { var r = fmt.rate(max); return r.u; }
function inUnit(Bps, u) { var b = Bps * 8, div = { 'b/s': 1, 'kb/s': 1e3, 'Mb/s': 1e6, 'Gb/s': 1e9 }[u]; var x = b / div; return x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2); }
G.tile({
    id: 'throughput', order: 20, wide: true, label: 'Throughput', icon: 'pulse',
    render: function (frag, X) {
        G.face.hd(frag, 'pulse', 'Throughput', ring.length ? 'last ' + Math.round(ring[ring.length - 1].t - ring[0].t) + 's' : '');
        if (ring.length < 2) { G.face.value(frag, '—'); G.face.sub(frag, 'collecting…'); return; }
        var last = ring[ring.length - 1], recent = ring.slice(-60);
        var peak = Math.max.apply(null, recent.map(function (s) { return Math.max(s.dn, s.up); }));
        var u = unitFor(Math.max(peak, last.dn, last.up));
        var v = G.face.value(frag, '↓ ' + inUnit(last.dn, u), u, null, true);
        v.appendChild(el('small', null, '   ↑ ' + inUnit(last.up, u) + ' ' + u));
        frag.appendChild(ui.spark(recent.map(function (s) { return s.dn; }), { w: 240, h: 40, fill: true, max: peak || 1 }));
        G.face.sub(frag, 'peak ' + inUnit(peak, u) + ' ' + u + ' · WAN, every 1.5 s');
    },
    sheet: function (body, api) {
        var top = el('div'), chart = el('div'), tr = el('div');
        body.appendChild(top); body.appendChild(chart); body.appendChild(tr);
        function live() {
            clear(top); clear(chart);
            if (ring.length < 2) { top.appendChild(ui.wait(2)); return; }
            var last = ring[ring.length - 1], peak = Math.max.apply(null, ring.map(function (s) { return Math.max(s.dn, s.up); })), u = unitFor(peak);
            api.meta(fmt.dur(last.t - ring[0].t) + ' window');
            top.appendChild(ui.readouts([ui.readout('Down', inUnit(last.dn, u), 'now', null, u), ui.readout('Up', inUnit(last.up, u), 'now', null, u), ui.readout('Peak', inUnit(peak, u), 'in the window', null, u)]));
            var dn = ui.spark(ring.map(function (s) { return s.dn; }), { w: 300, h: 80, fill: true, max: peak || 1, zero: true }); dn.style.height = '96px';
            var up = ui.spark(ring.map(function (s) { return s.up; }), { w: 300, h: 80, fill: true, max: peak || 1, accent: true }); up.style.height = '96px'; up.style.marginTop = '-96px';
            chart.appendChild(dn); chart.appendChild(up);
            chart.appendChild(el('div', 'field__h', 'download in ink, upload in maroon · same scale'));
        }
        function traffic() {
            clear(tr); var d = api.data.dash; if (!d) return;
            var rows = [], grand = 0, cols = d.nlbw && d.nlbw.columns;
            if (cols && d.nlbw.data) {
                var ci = cols.indexOf('mac'), rx = cols.indexOf('rx_bytes'), tx = cols.indexOf('tx_bytes'), cm = d.classmap || {}, le = d.leases || {};
                d.nlbw.data.forEach(function (r) { var mac = String(r[ci]).toUpperCase(), sum = (+r[rx] || 0) + (+r[tx] || 0); if (!sum) return; grand += sum; rows.push({ name: mac === '00:00:00:00:00:00' ? 'WireGuard' : (cm[mac] && cm[mac].name) || (le[mac] && le[mac].name !== '*' && le[mac].name) || mac, dn: +r[rx] || 0, up: +r[tx] || 0, sum: sum }); });
            }
            rows.sort(function (a, b) { return b.sum - a.sum; });
            var title = d.nlbw_daily ? 'Traffic today' : (d.nlbw_period ? 'Traffic since ' + d.nlbw_period : 'Traffic');
            tr.appendChild(el('div', 'field__l', title + (grand ? ' · ' + fmt.bytes(grand) : '')));
            if (!rows.length) { tr.appendChild(ui.say(d.nlbw_up === false ? 'Per-device accounting is not running, so nothing is being counted.' : 'No per-device accounting yet today.', null)); return; }
            tr.appendChild(ui.lines(rows.slice(0, 12).map(function (r) { var b = el('span'); b.appendChild(el('b', null, r.name)); b.appendChild(document.createTextNode('  ↓ ' + fmt.bytes(r.dn) + ' · ↑ ' + fmt.bytes(r.up))); var pct = r.sum * 100 / grand; return ui.line(null, b, fmt.bytes(r.sum) + ' · ' + (pct < 1 ? '<1' : Math.round(pct)) + '%'); })));
            var uu = d.uplink_usage; if (uu && uu.ok) tr.appendChild(el('div', 'field__h', (uu.kind === 'wwan' ? 'Wi-Fi uplink, this session: ' : uu.kind === 'tethering' ? 'USB uplink, this session: ' : 'This month over Ethernet: ') + fmt.bytes(uu.total)));
        }
        live(); traffic(); api.on('rate', live); api.on('dash', traffic);
    }
});

/* ═══ 10. SYSTEM ══════════════════════════════════════════════════════════ */
function health(d, r) {
    var sy = d.sys || {}; var load = parseFloat((r && r.load) || sy.load) || 0, temp = ((r && r.temp) || sy.temp || 0) / 1000;
    var mt = (r && r.memt) || sy.mem_total || 0, ma = (r && r.mema) || sy.mem_avail || 0, memF = mt ? (mt - ma) / mt : 0;
    var ovl = sy.ovl_total ? sy.ovl_used / sy.ovl_total : 0, v6 = sy.v6_loss;
    var word = (temp > 85 || memF > 0.9 || load > 4 || (v6 != null && v6 >= 100) || ovl > 0.9) ? ['Degraded', 'bad'] : (temp > 75 || memF > 0.75 || load > 2.8 || ovl > 0.75) ? ['Warm', 'warn'] : ['Nominal', 'ok'];
    return { load: load, cpu: load / 4, temp: temp, memF: memF, mt: mt, ma: ma, ovl: ovl, word: word, fan: (r && r.fan) || sy.fan_rpm || 0 };
}
G.tile({
    id: 'system', order: 21, label: 'System', icon: 'gauge',
    render: function (frag, X) {
        var d = X.dash, r = X.rate;
        G.face.hd(frag, 'gauge', 'System');
        if (!d) { G.face.value(frag, '—'); return; }
        var h = health(d, r);
        var arcs = el('div', 'arcs');
        arcs.appendChild(ui.arc(Math.min(1, h.cpu), 'CPU', Math.round(h.cpu * 100) + '%', h.cpu >= 1 ? 'bad' : h.cpu > 0.7 ? 'warn' : null));
        arcs.appendChild(ui.arc(Math.min(1, h.temp / 95), 'Temp', Math.round(h.temp) + '°', h.temp > 85 ? 'bad' : h.temp > 75 ? 'warn' : null));
        arcs.appendChild(ui.arc(h.memF, 'Memory', Math.round(h.memF * 100) + '%', h.memF > 0.9 ? 'bad' : h.memF > 0.75 ? 'warn' : null));
        frag.appendChild(arcs);
        var alarms = [];
        if (d.sys && d.sys.firewall === 'absent') alarms.push('no firewall');
        if (d.jobs && d.jobs.state === 'stale' && d.jobs.stale.length) alarms.push('watchdogs stale');
        G.face.sub(frag, alarms.length ? alarms.join(' · ') : (d.sys.host || 'Router') + ' · up ' + fmt.dur(d.sys.uptime), alarms.length ? 'bad' : toneOf(h.word) === 'ok' ? null : toneOf(h.word));
        return { tone: alarms.length ? 'bad' : (h.word[1] === 'ok' ? null : h.word[1]) };
    },
    sheet: function (body, api) {
        var seg = 'health';
        body.appendChild(ui.pick([{ value: 'health', label: 'Health' }, { value: 'network', label: 'Network' }, { value: 'alerts', label: 'Alerts' }, { value: 'router', label: 'Router' }, { value: 'log', label: 'Log' }], seg, function (v) { seg = v; draw(); }, true));
        var pane = el('div'); body.appendChild(pane); var logTimer = null, isDirty = function () { return false; };
        function draw() {
            clearTimeout(logTimer); clear(pane); isDirty = function () { return false; };
            if (seg === 'health') return drawHealth(); if (seg === 'network') return drawNetwork(); if (seg === 'alerts') return drawAlerts(); if (seg === 'router') return drawRouter(); return drawLog();
        }
        function drawHealth() {
            var d = api.data.dash, r = api.data.rate, s = api.data.set; if (!d) { pane.appendChild(ui.wait(3)); return; }
            var h = health(d, r); api.meta(h.word[0]);
            if (d.sys.firewall === 'absent') { var fw = ui.say('There is NO firewall loaded. Nothing is filtered and this console has no login — a file under /etc/nftables.d/ is broken. Restart it now; if that fails, the file has to be removed over SSH.', 'bad'); fw.appendChild(ui.act('Restart firewall', 'primary sm', function (b) { confirm({ title: 'Restart the firewall?', body: 'Connections in flight may drop.', okText: 'Restart' }).then(function (ok) { if (ok) G.act(b, SET, { action: 'fwrestart' }, { ok: 'Firewall reloaded. Filtering is back on.', failPrefix: 'Could not reload it', refresh: ['dash', 'vpn'] }); }); })); pane.appendChild(fw); }
            if (d.jobs && d.jobs.state === 'stale' && d.jobs.stale.length) { var NM = { dashmon: 'history and reachability', apwatch: 'the Wi-Fi watchdog', vpnwatch: 'automatic VPN release', notifymon: 'push notifications', wifiwatch: 'real-time Wi-Fi alerts' }; pane.appendChild(ui.say(d.jobs.cron === false ? 'The scheduler is not running, so no background job is. Over SSH: /etc/init.d/cron restart' : 'Not reporting in: ' + d.jobs.stale.map(function (j) { return NM[j] || j; }).join(', ') + '.' + (d.jobs.stale.indexOf('wifiwatch') >= 0 ? ' Over SSH: /etc/init.d/wifiwatch restart' : ''), 'bad')); }
            pane.appendChild(ui.readouts([
                ui.readout('CPU', Math.round(h.cpu * 100), h.cpu >= 1 ? 'overloaded' : h.cpu > 0.7 ? 'working hard' : h.cpu > 0.25 ? 'comfortable' : 'plenty of headroom', h.cpu >= 1 ? 'bad' : h.cpu > 0.7 ? 'warn' : null, '%'),
                ui.readout('Temperature', h.temp ? h.temp.toFixed(1) : '—', h.fan ? 'fan at ' + h.fan + ' rpm' : 'fan idle', h.temp > 85 ? 'bad' : h.temp > 75 ? 'warn' : null, h.temp ? '°C' : ''),
                ui.readout('Memory', Math.round((h.mt - h.ma) / 1024) + ' / ' + Math.round(h.mt / 1024), 'MB · ' + Math.round(h.ma / 1024) + ' MB free', h.memF > 0.9 ? 'bad' : h.memF > 0.75 ? 'warn' : null),
                d.sys.ovl_total ? ui.readout('Storage', Math.round(d.sys.ovl_used / 1024) + ' / ' + Math.round(d.sys.ovl_total / 1024), 'MB · overlay', h.ovl > 0.9 ? 'bad' : h.ovl > 0.75 ? 'warn' : null) : ui.readout('Uptime', fmt.dur(d.sys.uptime), d.sys.host)
            ]));
            var kv = [['Hostname', d.sys.host], ['Uptime', fmt.dur(d.sys.uptime)]];
            if (d.sys.wan_uptime >= 0) kv.push(['Uplink up', fmt.dur(d.sys.wan_uptime) + (d.sys.uptime - d.sys.wan_uptime > 120 ? ' · dropped since boot' : ' · no drop since boot')]);
            if (d.sys.v6_loss != null && d.sys.v6_loss >= 0) kv.push(['IPv6', d.sys.v6_loss >= 100 ? 'unreachable' : 'reachable']);
            if (s && s.software) kv.push(['OpenWrt', [s.software.running, s.software.revision].filter(Boolean).join(' ')]);
            pane.appendChild(ui.kv(kv));
        }
        function drawNetwork() {
            var s = api.data.set; if (!s) { pane.appendChild(ui.wait(3)); return; }
            api.meta(s.lan.ipaddr);
            var lan = s.lan, f = form(api, { onApply: applyLan, onReset: draw }); isDirty = f.isDirty;
            var ip = ui.input({ value: lan.ipaddr, inputmode: 'decimal', maxlength: 15 }), start = ui.input({ type: 'number', value: lan.dhcp.start, min: 2, max: 254, inputmode: 'numeric' }), limit = ui.input({ type: 'number', value: lan.dhcp.limit, min: 1, max: 253, inputmode: 'numeric' });
            var lease = ui.select(['30m', '1h', '6h', '12h', '24h', '72h'].map(function (x) { return { value: x, label: ({ '30m': '30 minutes', '1h': '1 hour', '6h': '6 hours', '12h': '12 hours', '24h': '24 hours', '72h': '3 days' })[x] }; }), lan.dhcp.leasetime);
            f.root.appendChild(el('div', 'field__l', 'LAN and DHCP'));
            f.root.appendChild(ui.field('Router address', ip, 'Subnet stays 255.255.255.0. Changing this moves the console to the new address.'));
            var g = el('div', 'row2'); g.appendChild(ui.field('Pool starts at', start)); g.appendChild(ui.field('Pool size', limit)); f.root.appendChild(g);
            f.root.appendChild(ui.field('Lease time', lease));
            f.root.appendChild(f.row); pane.appendChild(f.root);
            function applyLan(btn) {
                var v = ip.value.trim(), moving = v !== lan.ipaddr;
                var okIp = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(v) && v.split('.').every(function (o) { return +o <= 255; }) && +v.split('.')[3] >= 1 && +v.split('.')[3] <= 254;
                if (!okIp) { G.pop('That is not a usable router address.', 'warn'); return; }
                (moving ? confirm({ title: 'Move the router to ' + v + '?', body: 'Every device renews its lease within a minute. This console will then be at http://' + v + '/console/', okText: 'Move', danger: true }) : Promise.resolve(true)).then(function (ok) {
                    if (!ok) return;
                    G.act(btn, SET, { action: 'setlan', ipaddr: v, start: start.value, limit: limit.value, leasetime: lease.value }, { ok: moving ? 'Moving…' : 'Applied.', refresh: moving ? [] : ['set'] }).then(function (j) {
                        if (j && j.ok) f.clean();
                        if (j && j.ok && j.moved) { for (var k in G.polls) G.polls[k].stop(); var a = el('a', 'act act--primary'); a.href = 'http://' + j.moved + '/console/'; a.textContent = 'Open the console at ' + j.moved; var box = el('div'); box.appendChild(ui.say('The router is moving to ' + j.moved + '. This page cannot follow it.', 'warn')); box.appendChild(a); confirm({ title: 'Router moving', body: box, okText: 'Close', cancelText: 'Close' }); }
                    });
                });
            }
            /* IPv6 */
            var v6 = s.ipv6; if (!v6) return;
            var LBL = { passthrough: 'Passthrough', native: 'Native', nat6: 'NAT6', off: 'Off' };
            var rd = v6.radns || {};
            pane.appendChild(el('div', 'field__l', 'IPv6'));
            pane.appendChild(ui.readouts([ui.readout('Mode', LBL[v6.mode] || v6.mode, [v6.master ? 'uplink ' + v6.master + (v6.uplink ? '' : ' (no address)') : 'no IPv6 uplink', v6.can_native ? 'prefix delegated' : 'no prefix delegated'].join(' · '), rd.verdict === 'fault' ? 'bad' : v6.mode === 'off' ? null : 'ok')]));
            var msel = ui.select([{ value: 'passthrough', label: 'Passthrough — devices take the ISP prefix directly' }, { value: 'native', label: 'Native — router hands out the delegated prefix' + (v6.can_native ? '' : ' (no prefix)'), disabled: !v6.can_native }, { value: 'nat6', label: 'NAT6 — private IPv6 behind the router' }, { value: 'off', label: 'Off' }], v6.mode);
            var mrow = el('div', 'inline'); mrow.appendChild(msel);
            mrow.appendChild(ui.act('Apply', 'primary sm', function (b) { if (msel.value === v6.mode) { G.pop('That is the mode already in use.', 'warn'); return; } confirm({ title: 'Change IPv6 to ' + LBL[msel.value] + '?', body: 'Every device redoes its IPv6 setup; IPv4 is untouched.', okText: 'Change', danger: true }).then(function (ok) { if (ok) G.act(b, SET, { action: 'setipv6', mode: msel.value }, { ok: 'IPv6 mode changed.', refresh: ['set'], delay: 3000 }); }); }));
            pane.appendChild(ui.field('Mode', mrow));
            if (rd.verdict && rd.verdict !== 'off') {
                var vw = rd.verdict === 'fault' ? ['Unreachable', 'bad'] : rd.verdict === 'none' ? ['None', null] : ['On-link', 'ok'];
                pane.appendChild(ui.readouts([ui.readout('DNS advertised to devices', vw[0], (rd.servers || []).map(function (x) { return x.addr; }).join(', ') || 'no server', vw[1])]));
                pane.appendChild(el('div', 'field__h', rd.source === 'override' ? 'Set explicitly on this router.' : rd.source === 'upstream' ? 'Relayed from the uplink, exactly as the ISP sent it.' : 'The router advertises itself.'));
                if (rd.verdict === 'fault') { var fx = ui.say('A DNS server the router advertises is a link-local address that is not this router — devices cannot reach it and some reconnect every few seconds. Pin the router’s own address.', 'bad'); fx.appendChild(ui.act('Fix', 'primary sm', function (b) { G.act(b, SET, { action: 'ra6fix' }, { ok: 'The router now advertises itself.', refresh: ['set'], delay: 2000 }); })); pane.appendChild(fx); }
            }
        }
        function drawAlerts() {
            var s = api.data.set; if (!s) { pane.appendChild(ui.wait(3)); return; }
            var n = s.notify; api.meta(n.enabled ? 'on' : 'off');
            if (n.weak) pane.appendChild(ui.say('The stored address is guessable. Alerts can be switched off with it in place, but not back on until it is replaced — use the service’s generate button.', 'warn'));
            if (n.queued > 0) pane.appendChild(ui.say(fmt.plural(n.queued, 'message') + ' waiting to be delivered — the router could not reach the service. They go as soon as it can.', 'warn'));
            var f = form(api, { onApply: apply, onReset: draw }); isDirty = f.isDirty;
            var en = ui.check('Send me a message when something changes', n.enabled);
            var u = ui.input({ type: 'password', value: n.url, placeholder: 'https://ntfy.sh/your-private-topic', autocomplete: 'off' }); u.style.flex = '1 1 200px';
            var row = el('div', 'inline'); row.appendChild(u);
            row.appendChild(ui.act('Show', 'quiet sm', function (b) { var m = u.type === 'password'; u.type = m ? 'text' : 'password'; setTxt(b.lastChild, m ? 'Hide' : 'Show'); }));
            row.appendChild(ui.act('Copy', 'quiet sm', function () { var ok = false; try { var was = u.type; u.type = 'text'; u.select(); u.setSelectionRange(0, 99999); ok = document.execCommand('copy'); u.type = was; u.blur(); } catch (e) {} G.pop(ok ? 'Address copied.' : 'Could not copy — tap Show and copy by hand.', ok ? 'ok' : 'warn'); }));
            f.root.appendChild(en.row); f.root.appendChild(ui.field('Where to send it', row, 'Install the ntfy app and subscribe to the topic at the end of this address. Treat it as a password.'));
            f.root.appendChild(el('div', 'field__h', 'Sent: the internet link, IPv6, the firewall, encrypted DNS, traffic accounting, and Wi-Fi arrivals and departures — only when something changes. Never sent: addresses, keys, or anything you browse.'));
            var test = ui.act('Send a test', 'quiet sm', function (b) { G.act(b, SET, { action: 'testnotify' }, { ok: 'Sent — check your phone.', failPrefix: 'Not sent' }); });
            f.row.insertBefore(test, f.row.firstChild); test.style.marginRight = 'auto';
            f.root.appendChild(f.row); pane.appendChild(f.root);
            function apply(btn) {
                var t = u.value.trim();
                G.act(btn, SET, { action: 'setnotify', enabled: en.input.checked ? '1' : '0', keepurl: (t !== '' && t === (n.url || '')) ? '1' : '0', url: t }, { ok: 'Saved.', failPrefix: 'Not saved', refresh: ['set'], delay: 800 }).then(function (j) { if (j && j.ok) f.clean(); });
            }
        }
        function drawRouter() {
            var s = api.data.set; if (!s) { pane.appendChild(ui.wait(3)); return; }
            var sys = s.system; api.meta(sys.hostname);
            /* appearance */
            pane.appendChild(ui.field('Appearance', ui.pick([{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], G.theme.get(), function (v) { G.theme.set(v); }, true), 'Follows the device until you choose here.'));
            var f = form(api, { onApply: apply, onReset: draw }); isDirty = f.isDirty;
            var ZONES = ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Dubai', 'Europe/London', 'Europe/Amsterdam', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
            var zopts = ZONES.map(function (z) { return { value: z, label: z.replace(/_/g, ' ') }; }); if (ZONES.indexOf(sys.zonename) < 0 && sys.zonename) zopts.unshift({ value: sys.zonename, label: sys.zonename + ' (as configured)', disabled: true });
            var hn = ui.input({ value: sys.hostname, maxlength: 24 }), tz = ui.select(zopts, sys.zonename);
            f.root.appendChild(ui.field('Hostname', hn, 'Letters, digits and hyphens.')); f.root.appendChild(ui.field('Time zone', tz, 'Daily traffic totals roll over at midnight in this zone. Time sync ' + (sys.ntp ? 'on' : 'off') + ' · up ' + fmt.dur(sys.uptime)));
            f.root.appendChild(f.row); pane.appendChild(f.root);
            function apply(btn) { G.act(btn, SET, { action: 'setsys', hostname: hn.value.trim(), zonename: tz.value }, { ok: 'Saved.', refresh: ['set', 'dash'] }).then(function (j) { if (j && j.ok) f.clean(); }); }
            /* software */
            var sw = s.software, c = sw.check;
            pane.appendChild(el('div', 'field__l', 'Software'));
            var hasUpd = !!(c && c.to && c.from && c.to !== c.from);
            var word = !sw.owut ? ['No checker', null] : !c ? ['Not checked', null] : hasUpd ? ['Update available', 'warn'] : ['Up to date', 'ok'];
            pane.appendChild(ui.readouts([ui.readout('OpenWrt', sw.running || 'unknown', [sw.revision, sw.target].filter(Boolean).join(' · '), null), ui.readout('Firmware', word[0], c ? (hasUpd ? c.to + ' available' : 'checked ' + fmt.ago(c.checked)) : (sw.owut ? 'never checked' : 'needs attendedsysupgrade-common'), word[1])]));
            var srow = el('div', 'inline'); srow.style.marginBottom = '14px';
            var bk = el('a', 'act'); bk.href = SET + '?action=backup'; bk.setAttribute('download', ''); bk.appendChild(icon('download')); bk.appendChild(el('span', null, 'Download backup')); srow.appendChild(bk);
            if (sw.owut) srow.appendChild(ui.act(c ? 'Check again' : 'Check for updates', null, function (b) { G.act(b, SET, { action: 'updcheck' }, { ok: 'Checked.', refresh: ['set'] }); }, 'refresh'));
            pane.appendChild(srow);
            if (c && c.packages && c.packages.length) {
                pane.appendChild(ui.say(fmt.plural(c.packages.length, 'package') + ' out of date' + (hasUpd ? '; a firmware upgrade replaces files edited in place on this router, so it is deliberately not done from here.' : '.'), hasUpd ? 'warn' : null));
                pane.appendChild(ui.lines(c.packages.slice(0, 20).map(function (p) { var b = el('span'); b.appendChild(el('b', null, p.name)); b.appendChild(document.createTextNode('  ' + p.from + ' → ' + p.to)); return ui.line(null, b); })));
                var upg = ui.act('Update ' + fmt.plural(c.packages.length, 'package'), 'primary', function (b) { confirm({ title: 'Update ' + fmt.plural(c.packages.length, 'package') + '?', body: 'apk upgrades exactly these. No reboot.', okText: 'Update' }).then(function (ok) { if (ok) G.act(b, SET, { action: 'pkgupgrade', names: c.packages.map(function (p) { return p.name; }).join(' ') }, { ok: 'Updated.', refresh: [] }).then(function (j) { if (j && j.ok) G.act(null, SET, { action: 'updcheck' }, { ok: false, refresh: ['set'] }); }); }); }); var urow = el('div', 'inline'); urow.appendChild(upg); pane.appendChild(urow);
            }
            var rb = ui.act('Restart router', 'danger', function (b) { confirm({ title: 'Restart the router?', body: 'Every Wi-Fi network and every tunnel drops for about a minute.', okText: 'Restart', danger: true }).then(function (ok) { if (!ok) return; G.act(b, SET, { action: 'reboot' }, { ok: 'Restarting — back in about a minute.', refresh: [] }).then(function (j) { if (!(j && j.ok)) return; for (var k in G.polls) G.polls[k].stop(); G.link.set('down', 'restarting'); setTimeout(function poll() { G.get(SET, 3000).then(function (jj) { if (jj && jj.ok) location.reload(); else setTimeout(poll, 3000); }, function () { setTimeout(poll, 3000); }); }, 25000); }); }); }, 'power');
            var lu = el('a', 'act act--quiet'); lu.href = '/cgi-bin/luci/'; lu.textContent = 'Open LuCI';
            var last = el('div', 'inline'); last.appendChild(rb); last.appendChild(lu); pane.appendChild(last);
        }
        function drawLog() {
            var level = 'all', q = '', total = -1;
            api.meta('');
            var ctl = el('div', 'inline'); ctl.style.marginBottom = '8px';
            ctl.appendChild(ui.pick([{ value: 'all', label: 'All' }, { value: 'warn', label: 'Warnings' }, { value: 'err', label: 'Errors' }], level, function (v) { level = v; total = -1; fetchLog(); }));
            var search = ui.input({ type: 'search', placeholder: 'Filter, e.g. wireguard', inline: true, label: 'Filter the log' }); var qt;
            search.addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { if (q !== search.value.trim()) { q = search.value.trim(); total = -1; fetchLog(); } }, 300); });
            ctl.appendChild(search); pane.appendChild(ctl);
            var list = el('div'), foot = el('div', 'field__h'); pane.appendChild(list); pane.appendChild(foot);
            function fetchLog() {
                if (seg !== 'log' || G.sheet.id !== 'system') return;
                G.get(SET + '?action=logs&level=' + level + '&n=150&q=' + encodeURIComponent(q) + (total < 0 ? '&total=1' : '')).then(function (j) {
                    if (seg !== 'log' || G.sheet.id !== 'system') return;
                    if (!(j && j.ok)) { clear(list); list.appendChild(ui.say('The log could not be read.', 'bad')); return; }
                    if (typeof j.total === 'number' && j.total >= 0) total = j.total;
                    var scrolled = api.body.scrollTop > 8 && list.childNodes.length;
                    if (!scrolled) {
                        clear(list);
                        if (!j.lines.length) list.appendChild(ui.say(q ? 'Nothing matches.' : level === 'all' ? 'The log is empty.' : 'Nothing at this level.', null));
                        else list.appendChild(ui.lines(j.lines.map(function (l) { var b = el('span'); b.appendChild(el('b', null, l.src)); b.appendChild(document.createTextNode('  ' + l.msg)); return ui.line(l.t, b, null, /^(emerg|alert|crit|err)/.test(l.lvl) ? 'bad' : /^warn/.test(l.lvl) ? 'warn' : null); })));
                    }
                    setTxt(foot, j.lines.length + ' of ' + (total >= 0 ? total : j.lines.length) + ' lines, newest first · ' + (scrolled ? 'paused while you read' : 'following, every 4s'));
                    logTimer = setTimeout(fetchLog, 4000);
                }).catch(function () { logTimer = setTimeout(fetchLog, 8000); });
            }
            fetchLog();
        }
        draw();
        api.on('dash', function () { if (seg === 'health') draw(); }); api.on('rate', function () { if (seg === 'health') draw(); });
        api.on('set', function () { if (seg === 'health' || seg === 'log') return; if (!isDirty()) draw(); });
    }
});

/* ═══ 11. ACTIVITY ════════════════════════════════════════════════════════ */
G.tile({
    id: 'activity', order: 22, label: 'Activity', icon: 'clock',
    render: function (frag, X) {
        var t = X.tools;
        G.face.hd(frag, 'clock', 'Activity');
        if (!t) { G.face.value(frag, '—'); return; }
        var ev = t.events || [];
        if (!ev.length) { G.face.value(frag, 'Quiet'); G.face.sub(frag, 'nothing in the log yet'); return; }
        var day = ev[0].day, n = ev.filter(function (e) { return e.day === day; }).length, d = new Date();
        var today = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getDate();
        G.face.value(frag, String(n), day === today ? (n === 1 ? 'event today' : 'events today') : 'on ' + day);
        G.face.sub(frag, ev.slice(0, 3).map(function (e) { return e.who + ' ' + e.text; }).join(' · '));
        var flaps = ev.filter(function (e) { return e.kind === 'flap'; }).length;
        return { tone: flaps ? 'warn' : null };
    },
    sheet: function (body, api) {
        var kind = 'all';
        body.appendChild(ui.pick([{ value: 'all', label: 'All' }, { value: 'wifi', label: 'Wi-Fi' }, { value: 'uplink', label: 'Uplink' }, { value: 'change', label: 'Changes' }], kind, function (v) { kind = v; draw(); }, true));
        var list = el('div'); body.appendChild(list);
        function draw() {
            var t = api.data.tools; clear(list); if (!t) { list.appendChild(ui.wait(4)); return; }
            var ev = (t.events || []).filter(function (e) { return kind === 'all' || (kind === 'wifi' ? (e.kind === 'join' || e.kind === 'leave' || e.kind === 'flap') : kind === 'uplink' ? e.kind === 'uplink' : (e.kind === 'change' || e.kind === 'alert')); });
            api.meta(fmt.plural(ev.length, 'event'));
            if (!ev.length) { list.appendChild(ui.empty('clock', 'Nothing here', 'Joins, departures, uplink changes and console actions appear as they happen.')); return; }
            var day = ''; var nodes = [];
            ev.forEach(function (e) {
                if (e.day !== day) { day = e.day; nodes.push(el('div', 'field__l', day)); }
                var b = el('span'); b.appendChild(el('b', null, e.who)); b.appendChild(document.createTextNode(' ' + e.text));
                nodes.push(ui.line(e.time.slice(0, 5), b, null, e.tone || null));
            });
            var wrap = el('div', 'lines'); nodes.forEach(function (n) { wrap.appendChild(n); }); list.appendChild(wrap);
        }
        draw(); api.on('tools', draw);
        G.polls.tools.refresh(60);
    }
});

/* ═══ 12. TRAVEL ══════════════════════════════════════════════════════════ */
function travelState(X) { return X.tools && X.tools.travel ? X.tools.travel : null; }
G.tile({
    id: 'travel', order: 23, label: 'Travel', icon: 'plane',
    toggle: {
        read: function (X) { var t = travelState(X); return t ? !!t.on : null; },
        write: function (v, ctx) {
            var X = ctx.data, g = secondary(X, 'guest'), i = secondary(X, 'iot'), vp = X.vpn, t = travelState(X) || {}, steps = [];
            if (v) {
                if (g && !g.disabled) steps.push('turn Guest Wi-Fi off'); if (i && !i.disabled) steps.push('turn IoT off');
                if (vp && vp.failmode !== 'open') steps.push('set the VPN to fail open');
            } else {
                if (t.guest_was === '1' && g) steps.push('turn Guest Wi-Fi back on'); if (t.iot_was === '1' && i) steps.push('turn IoT back on');
                if (t.vpn_was === '1') steps.push('set the VPN back to fail closed');
            }
            var wifi = steps.some(function (x) { return /Wi-Fi|IoT/.test(x); });
            return confirm({ title: v ? 'Leave home?' : 'Back home?', body: steps.length ? 'This will ' + steps.join(', ') + '.' + (wifi ? ' Wi-Fi reloads once per network — give it half a minute.' : '') : 'Nothing needs changing; only the flag flips.', okText: v ? 'Away' : 'Home' })
                .then(function (ok) { if (!ok) return; return v ? goAway(X) : comeHome(X); });
        }
    },
    render: function (frag, X) {
        var t = travelState(X);
        G.face.hd(frag, X.tools && X.tools.travel && X.tools.travel.on ? 'plane' : 'home', 'Travel');
        if (!t) { G.face.value(frag, '—'); return; }
        G.face.value(frag, t.on ? 'Away' : 'Home');
        G.face.sub(frag, t.on ? 'since ' + fmt.ago(t.since) + ' · guest and IoT off, VPN fails open' : 'guest and IoT as set, VPN fails closed');
        return { on: !!t.on };
    },
    sheet: function (body, api) {
        function draw() {
            clear(body); var t = travelState(api.data);
            api.meta(t && t.on ? 'away' : 'home');
            body.appendChild(ui.say(t && t.on ? 'Away since ' + fmt.ago(t.since) + '. Switching back puts everything below back the way it was.' : 'One switch for leaving the house with the router.', null, t && t.on ? 'plane' : 'home'));
            var g = secondary(api.data, 'guest'), i = secondary(api.data, 'iot'), v = api.data.vpn;
            body.appendChild(el('div', 'field__l', 'What Away does'));
            body.appendChild(ui.lines([
                ui.line(null, textB('Guest Wi-Fi off', ' — a hotel does not need your guest network' + (g ? ' · now ' + (g.disabled ? 'off' : 'on') : ' · none on this router'))),
                ui.line(null, textB('IoT network off', ' — the plugs stayed at home' + (i ? ' · now ' + (i.disabled ? 'off' : 'on') : ' · none on this router'))),
                ui.line(null, textB('VPN fails open', ' — a hotel that blocks WireGuard must not leave a routed device with no internet' + (v ? ' · now ' + (v.failmode === 'open' ? 'open' : 'closed') : ''))),
                ui.line(null, textB('Travel DNS', ' — automatic: on a Wi-Fi or USB uplink, DNS goes plain so captive portals appear'))
            ]));
            body.appendChild(el('div', 'field__h', 'Home puts back only what Away changed. Each step is one of the console’s ordinary actions; if one fails, the others still stand and the tiles show what is actually true.'));
        }
        draw(); api.on('tools', draw); api.on('set', draw); api.on('vpn', draw);
    }
});
function textB(b, rest) { var s = el('span'); s.appendChild(el('b', null, b)); s.appendChild(document.createTextNode(rest)); return s; }
function goAway(X) {
    var g = secondary(X, 'guest'), i = secondary(X, 'iot'), v = X.vpn;
    var gw = g ? (g.disabled ? '0' : '1') : '0', iw = i ? (i.disabled ? '0' : '1') : '0', vw = v ? (v.failmode === 'open' ? '0' : '1') : '0';
    var steps = [];
    if (g && !g.disabled) steps.push(function () { return G.post(SET, { action: 'setiot', network: 'guest', enabled: '0', ssid: g.ssid, key: '' }); });
    if (i && !i.disabled) steps.push(function () { return G.post(SET, { action: 'setiot', network: 'iot', enabled: '0', ssid: i.ssid, key: '' }); });
    if (v && v.failmode !== 'open') steps.push(function () { return G.post(VPN, { action: 'failmode', mode: 'open' }); });
    return runSteps(steps).then(function (fails) {
        return G.post(TOOLS, { action: 'travel', on: '1', guest_was: gw, iot_was: iw, vpn_was: vw }).then(function () {
            G.pop(fails ? 'Away, but ' + fails + ' step(s) failed — check the tiles.' : 'Away. Guest and IoT off, VPN fails open.', fails ? 'warn' : 'ok');
            ['set', 'vpn', 'tools', 'dash'].forEach(function (k) { G.polls[k].refresh(fails ? 700 : 8000); }); G.polls.tools.refresh(300);
        });
    });
}
function comeHome(X) {
    var t = travelState(X) || {}, g = secondary(X, 'guest'), i = secondary(X, 'iot');
    var steps = [];
    if (t.guest_was === '1' && g) steps.push(function () { return G.post(SET, { action: 'setiot', network: 'guest', enabled: '1', ssid: g.ssid, key: '' }); });
    if (t.iot_was === '1' && i) steps.push(function () { return G.post(SET, { action: 'setiot', network: 'iot', enabled: '1', ssid: i.ssid, key: '' }); });
    if (t.vpn_was === '1') steps.push(function () { return G.post(VPN, { action: 'failmode', mode: 'closed' }); });
    return runSteps(steps).then(function (fails) {
        return G.post(TOOLS, { action: 'travel', on: '0' }).then(function () {
            G.pop(fails ? 'Home, but ' + fails + ' step(s) failed — check the tiles.' : 'Home. Everything is back as it was.', fails ? 'warn' : 'ok');
            ['set', 'vpn', 'dash'].forEach(function (k) { G.polls[k].refresh(8000); }); G.polls.tools.refresh(300);
        });
    });
}
function runSteps(steps) {
    var fails = 0;
    return steps.reduce(function (p, fn) { return p.then(function () { return fn().then(function (j) { if (!(j && j.ok)) { fails++; G.pop((j && j.error) || 'a step failed', 'bad'); } }); }); }, Promise.resolve()).then(function () { return fails; });
}

/* ═══ 13. SPEED TEST · iPerf ══════════════════════════════════════════════ */
G.tile({
    id: 'speed', order: 24, label: 'Speed test', icon: 'speed',
    render: function (frag, X) {
        var t = X.tools, s = X.set, ip = s && s.iperf && s.iperf.running ? ' · iPerf listening' : '';
        G.face.hd(frag, 'speed', 'Speed test');
        if (!t) { G.face.value(frag, '—'); return; }
        var sp = t.speed;
        if (sp && sp.down != null) { G.face.value(frag, String(sp.down), 'Mb/s', null, true); G.face.sub(frag, '↓ down · ↑ ' + (sp.up != null ? sp.up + ' Mb/s' : '—') + ' · ' + fmt.ago(sp.at) + ip); }
        else { G.face.value(frag, 'Run'); G.face.sub(frag, 'down and up, measured from the router' + ip); }
        return { on: !!(s && s.iperf && s.iperf.running) };
    },
    sheet: function (body, api) {
        var res = el('div'); body.appendChild(res);
        var running = false, timer = null, downDone = null;
        function drawRes(prog) {
            clear(res); var t = api.data.tools, sp = t && t.speed;
            if (running && prog) {
                api.meta('measuring');
                var d = prog.phase === 'down' ? String(prog.mbps) : (downDone != null ? String(downDone) : '—');
                var ds = prog.phase === 'down' ? 'measuring · ' + prog.t + ' of ' + prog.of + ' s' : (downDone != null ? 'done' : 'starting');
                var u = prog.phase === 'up' ? String(prog.mbps) : '—', us = prog.phase === 'up' ? (prog.t > 0 ? 'measuring · ' + prog.t + ' of ' + prog.of + ' s' : 'connecting to ' + prog.via) : 'after the download';
                res.appendChild(ui.readouts([ui.readout('Download', d, ds, null, 'Mb/s'), ui.readout('Upload', u, us, null, 'Mb/s')]));
            } else {
                api.meta(sp ? sp.down + ' ↓ · ' + sp.up + ' ↑' : '');
                res.appendChild(ui.readouts([
                    ui.readout('Download', sp ? String(sp.down) : '—', sp ? 'peak ' + sp.down_peak + ' Mb/s' : 'not run yet', null, sp ? 'Mb/s' : ''),
                    ui.readout('Upload', sp && sp.up != null ? String(sp.up) : '—', sp ? (sp.up != null ? 'via ' + sp.up_via : 'no iperf3 server answered') : '', null, sp && sp.up != null ? 'Mb/s' : '')]));
                if (sp) res.appendChild(el('div', 'field__h', fmt.plural(sp.streams, 'stream') + ' · ' + sp.seconds + ' s each way · ' + fmt.ago(sp.at)));
            }
            var run = ui.act(running ? 'Measuring…' : 'Run a speed test', 'primary', start, 'bolt');
            if (running) { run.disabled = true; run.classList.add('is-busy'); }
            res.appendChild(run);
            res.appendChild(el('div', 'field__h', 'What fast.com does, from the router. Down: four parallel streams from Cloudflare for ten seconds, read off the uplink’s own counters with the first two seconds discarded — so anything else using the uplink counts too. Up: iperf3, four streams, ten seconds, to the first public iperf3 server that is free (usually iperf.he.net in California — a long path, so it reads a little under the line). It measures the uplink, not your Wi-Fi; for that, use iPerf below.'));
        }
        function start() {
            if (running) return;
            running = true; downDone = null; var last = null;
            drawRes({ phase: 'down', mbps: '—', t: 0, of: 10 });
            timer = setInterval(function () {
                if (G.sheet.id !== 'speed') { clearInterval(timer); return; }
                G.get(TOOLS + '?action=speedprog', 3000).then(function (p) {
                    if (!running || !p || p.phase === 'idle') return;
                    if (p.phase === 'up' && last && last.phase === 'down') downDone = last.mbps;
                    last = p; drawRes(p);
                }).catch(function () {});
            }, 1000);
            G.post(TOOLS, { action: 'speedtest' }, 75000).then(function (j) {
                clearInterval(timer); running = false;
                if (j && j.ok) { G.pop(j.down + ' Mb/s down · ' + (j.up != null ? j.up + ' Mb/s up' : 'upload: no server free'), j.up != null ? 'ok' : 'warn', 7000); G.polls.tools.refresh(200); }
                else G.pop('Speed test failed: ' + ((j && j.error) || 'unknown'), 'bad');
                if (G.sheet.id === 'speed') drawRes();
            });
        }
        var ip = el('div'); body.appendChild(ip);
        function drawIperf() {
            clear(ip); var s = api.data.set, p = s && s.iperf; if (!p) return;
            ip.appendChild(el('div', 'field__l', 'iPerf server'));
            if (!p.installed) { ip.appendChild(ui.say('Needs the iperf3 package: apk add iperf3 over SSH.', null)); return; }
            var w = p.running ? ['Listening', 'ok'] : p.enabled ? ['Not listening', 'warn'] : ['Off', null];
            var sw = ui.switchEl(p.enabled, function (v, s_) { ui.setSwitch(s_, !v, true); G.act(null, SET, { action: 'setiperf', enabled: v ? '1' : '0', port: port.value }, { ok: v ? 'Listening on ' + p.ip + ':' + port.value : 'iPerf off.', refresh: ['set'] }).then(function () { s_.disabled = false; }); }, 'iPerf server');
            var port = ui.input({ type: 'number', value: p.port, min: 1024, max: 65535, inputmode: 'numeric', inline: true, label: 'Port' }); port.style.maxWidth = '120px';
            var row = el('div', 'inline'); row.appendChild(sw); row.appendChild(ui.mark(w[0], w[1])); row.appendChild(port);
            ip.appendChild(row);
            ip.appendChild(ui.kv([['Listening on', p.ip + ':' + p.port], ['From a laptop', 'iperf3 -c ' + p.ip + ' -p ' + p.port]]));
            ip.appendChild(el('div', 'field__h', 'Reachable from the main network; guest and IoT are kept out by the firewall. Measures your Wi-Fi or cable to the router, not the internet.'));
        }
        drawRes(); drawIperf(); api.on('tools', function () { if (!running) drawRes(); }); api.on('set', drawIperf);
    }
});

/* ═══ boot ════════════════════════════════════════════════════════════════ */
G.boot();
for (var k in G.polls) G.polls[k].start();
loadProbe();
})();
