# Beryl 7 Console

A hand-built web console for the GL.iNet Beryl 7 (GL-MT3600BE) travel router running vanilla OpenWrt. Five pages of plain HTML, CSS, and JavaScript over busybox-ash CGI — no frameworks, no build step, no external requests, no dependencies beyond what the router already ships.

It replaces day-to-day use of LuCI and the vendor UI for the things a travel router actually does: watching who is connected, joining hotel Wi-Fi, tethering a phone, routing devices through WireGuard tunnels, and adjusting the radios — while leaving LuCI untouched at `/cgi-bin/luci/` for everything else.

Built for one specific router, but it does not assume that router: radios, wireless interfaces, and networks are all discovered at runtime, so a stock dual-band OpenWrt box should work unedited. Read the code before deploying it — it is small enough that you can.

> **No login.** This is internal tooling for a network you control — a personal router, its owner, and a few trusted people. Anyone who can reach it over HTTP can change settings. Keep it off the internet and away from your guest and IoT networks. [Security model](#security-model) explains exactly what that means and what is still enforced.

## Quick start

On a freshly flashed OpenWrt router, from a machine on the same network:

```sh
ssh-copy-id root@192.168.1.1     # if you haven't already
git clone https://github.com/farrasnaim/beryl7-console.git
cd beryl7-console
./install.sh 192.168.1.1         # your router's address
```

It prints the URL when it's done. Open `http://192.168.1.1/dashboard/` — there is no login, by design; see [Security model](#security-model).

That is the whole install. Everything else in this README is explanation, not further steps:

- **Optional packages** unlock the VPN and USB-uplink pages — see [Requirements](#requirements). The installer names the ones you're missing; nothing breaks without them.
- **Name your devices** by editing `/etc/dashboard/classmap` on the router, so the client list shows "My Laptop" instead of a MAC.
- **Re-run `./install.sh`** any time to upgrade; it keeps the device names you set.
- **[Back up before you reflash](#backup-and-restore)** — `./backup.sh <router>` captures the config *and* the console in one file.

Read [Security model](#security-model) before putting this on a network you don't control.

## The pages

| Page | Path | What it does |
|---|---|---|
| **Overview** | `/dashboard/` | Live network topology (uplink → router → tunnels → devices), connected clients with per-device throughput and Wi-Fi signal, radio status, today's traffic, system vitals (load, temperature, fan, memory), and a 1-second throughput + latency chart. Per-device detail view with rates, PHY mode, and block control. |
| **VPN** | `/vpn/` | WireGuard tunnels: add from a pasted `.conf`, connect/disconnect, and route individual devices through a tunnel via [pbr](https://github.com/stangri/pbr) policies. Fail-closed by default; an optional watchdog can pause routing when a tunnel dies (see `vpnwatch`). Per-device VPN DNS enforcement so routed devices can't leak DNS to the home uplink (see `beryl-vpndns`). If the `tor` package is installed, a panel here starts and stops it and shows the proxy addresses for reaching `.onion` sites — see [Tor](#tor). |
| **Wi-Fi uplink** | `/repeater/` | Repeater mode: scan, join, and forget upstream networks (hotel/cafe Wi-Fi). Shows the uplink's health and hands over between sources by route metric. |
| **USB uplink** | `/tethering/` | USB tethering: iPhone (ipheth/usbmuxd), Android RNDIS, HiLink dongles, and NCM/QMI/MBIM modems, with APN/PIN configuration where the device needs it. Detects whatever netdev the device presents instead of assuming `eth2`. |
| **Settings** | `/settings/` | Radio configuration (band, channel, width, PHY mode, transmit power, country) with the valid channel/width combinations derived live from what the hardware reports — you cannot select a combination the radio can't do. Plus SSID settings, hostname, timezone, LAN lease settings, device blocking, and radio restart. Under **System**: a one-click **config backup download** (the same `sysupgrade -b` archive LuCI produces), an on-demand update check via [`owut`](https://openwrt.org/docs/guide-user/installation/attended.sysupgrade) that can then upgrade exactly the packages it listed, and a **live system log** filtered by severity — the honest answer to "why is there no internet" when the only device you have is a phone. Firmware is deliberately not flashed from here. |

Every page works from 360 px phones to desktop, in light and dark (system-following or manually pinned), with four accent themes (mint, maroon, navy, grey).

## Design

The UI follows a deliberately quiet design language: warm graphite surfaces, a single cool accent, no gradients, no shadows (only focus rings), uppercase reserved for state words. All of it lives in one token system in `www/os.css`:

- **Theming** is a 4-rule matrix per token set — bare default, `prefers-color-scheme` media rule, and `[data-theme="dark"]` / `[data-theme="light"]` overrides — so the manual toggle always beats the system preference in both directions.
- **Accents** are complete token sets (`--sig`, `--sig-fg`, `--sig-solid`, `--sig-dim`, `--sig-line`), each tuned separately for dark and light grounds. Contrast was computed numerically against alpha-composited backgrounds, not eyeballed.
- **Typography** is the system font stack. Tabular numerals wherever digits align; monospace only for identifiers (MACs, IPs, interface names).

`www/os.js` is the shared runtime: navigation, theme/accent persistence (pre-paint, so no flash of the wrong theme), dialogs, the SVG topology renderer, and the polling machinery.

## Architecture

```
browser ── 5s poll ──► /cgi-bin/<page>-api ── JSON state snapshot
        ── 1s poll ──► /cgi-bin/rate-api   ── counters + ping only
        ── POST ─────► /cgi-bin/<page>-api ── writes (POST + same-origin only)

cron (1 min) ──► dashmon   ── telemetry ring buffers in /tmp
             ──► apwatch   ── Wi-Fi AP watchdog (recovers a wedged radio)
             ──► vpnwatch  ── optional VPN fail-open behaviour

hotplug ──► 30-tethering        ── adopt whatever netdev USB tethering presents
        ──► 31-tethering-clash  ── refuse USB uplinks whose subnet collides
        ──► 15-travel-dns       ── plaintext DNS on travel uplinks (captive portals)
        ──► 99-repeater-iot     ── drop the IoT SSID while travelling
```

Points worth knowing:

- **CGIs are busybox ash.** No bash, no `stat`, no sub-second `sleep`, no `date +%N`. Everything is written against what a stock OpenWrt BusyBox actually provides.
- **The two-endpoint split is the performance design.** The full state snapshot (`dashboard-api`) costs ~455 ms of CPU per call; the counters endpoint (`rate-api`) costs ~9 ms. The 1-second live charts poll only the cheap endpoint (~0.2% of the four cores), and the full snapshot stays at 5 s.
- **Telemetry never touches flash.** `dashmon` keeps its ring buffers (WAN latency history, device presence) in `/tmp` — lost on reboot by design, zero flash wear.
- **State-changing requests are POST-only** and re-validated server-side. GET requests cannot mutate anything.
- **`beryl-vpndns`** regenerates `/etc/nftables.d/30-beryl-vpndns.nft` from the current pbr policies: IPv4 DNS from VPN-routed devices is DNAT-ed into the tunnel's resolver, and IPv6 from those devices is rejected (not dropped) so clients fail fast to IPv4 instead of leaking their location via the home uplink. The file is generated — it is intentionally not in this repo. **If your LAN has working IPv6, the v6 block is what keeps the tunnel honest**: pbr does not mark IPv6 (`ipv6_enabled=0`), so a routed device that resolves an AAAA record would otherwise connect over IPv6 straight out of the home uplink — the tunnel intact, the location given away anyway. Rejecting only port 53 is not enough; the forward chain rejects a routed device's IPv6 outright, while the input chain still takes only DNS so the device keeps reaching the router itself.
- **`apwatch`** exists because `wifi reload` bounces both radios (single PHY), and a failed reload with only a phone in your pocket means no AP, no dashboard, and no SSH. It escalates gently: `wifi up` → `wifi reload` → rate-limited reboot, and stops the moment the AP is back.

## Repository layout

```
install.sh                   first-time install / upgrade, idempotent
backup.sh                    pull a full restore bundle off the router
restore.sh                   put a bundle back onto a fresh router
www/
  os.css                     design system: tokens, themes, accents, components
  os.js                      shared runtime: nav, theming, dialogs, topology, polling
  dashboard/index.html       Overview
  vpn/index.html             VPN
  repeater/index.html        Wi-Fi uplink
  tethering/index.html       USB uplink
  settings/index.html        Settings
  cgi-bin/
    dashboard-api            full state snapshot + device detail + block/deauth
    rate-api                 cheap 1s counters: WAN bytes, ping, load, temp, fan, mem
    vpn-api                  tunnels, per-device routing, fail-mode
    repeater-api             scan/join/forget, uplink status
    tethering-api            USB device detection, modem config, uplink control
    settings-api             radios, SSIDs, hostname, timezone, DHCP, block list
    probe-api                the Overview's ping target, and the saved list
  theme.css                  v1 design system (superseded — kept for reference)
  legacy/                    v1 pages (superseded — kept for reference)

usr/share/beryl/
  cgi-lib.sh                 helpers every *-api sources: JSON escaping, query
                             parsing, and the POST/same-origin guard. Outside
                             /www because uhttpd would serve it as an endpoint.

usr/sbin/
  dashmon                    1-minute telemetry collector (cron)
  apwatch                    Wi-Fi AP watchdog (cron)
  vpnwatch                   optional VPN dead-tunnel handling (cron)
  beryl-vpndns               regenerates per-device VPN DNS nftables rules
  beryl-pbrtbl               reads pbr's fwmark routing tables in one pass
  pingmon                    1s probe; its 5-minute ring feeds the charts

etc/
  crontabs/root              the three cron entries
  dashboard/classmap.example device name/class map — copy to /etc/dashboard/classmap
  hotplug.d/iface/15-travel-dns        captive-portal-safe DNS on travel uplinks
  hotplug.d/iface/31-tethering-clash   reject colliding USB subnets (HiLink!)
  hotplug.d/iface/32-pbr-uplink        repoint pbr when the pinned uplink dies
  hotplug.d/iface/33-uplink-width      narrow AP width to fit the uplink channel
  hotplug.d/iface/34-vpn-resume        resume a paused tunnel when a link returns
  hotplug.d/iface/99-repeater-iot      IoT SSID off while repeating
  hotplug.d/net/30-tethering           bind any tethering netdev name
  hotplug.d/usb/40-usbmuxd             disabled stub (see its header for why)
  init.d/cpugovernor         schedutil instead of a pinned 2.0 GHz
  init.d/pingmon             keeps pingmon running (procd, not cron)
  sysctl.d/99-local.conf     TCP MTU probing for hotel/tunnel PMTU black holes
```

Every script carries a header comment explaining what it does and, more importantly, why it exists. The headers are the real documentation.

## Requirements

**Hardware.** Developed and used daily on a GL.iNet Beryl 7 (GL-MT3600BE) — MediaTek Filogic, quad-core A53, Wi-Fi 7 (BE3600), one 2.4 GHz + one 5 GHz radio on a single PHY, temperature sensor and fan. Radios, interfaces, and networks are all discovered at runtime rather than hardcoded, so a stock dual-band OpenWrt router should work without edits — but that is reasoning, not testing. See [Porting](#porting-to-other-routers).

**Firmware.** Vanilla OpenWrt 25.12 (developed on GL's OpenWrt-based stock firmware, then migrated). uhttpd with CGI enabled — the stock configuration.

**Packages.** Nothing is required — the console installs and runs on stock OpenWrt. Each package below unlocks one page or panel, and the installer tells you which are missing rather than refusing to continue.

| Needed by | Packages |
|---|---|
| VPN page | `pbr`, `wireguard-tools`, `kmod-wireguard` |
| USB uplink page | `kmod-usb-net-ipheth` + `usbmuxd` (iPhone), `kmod-usb-net-rndis` (Android), `kmod-usb-net-cdc-ether`, `kmod-usb-net-cdc-ncm` / `qmi` / `mbim` + `uqmi`/`umbim` as needed |
| Traffic panel | `vnstat2` |
| Travel DNS hotplug | `https-dns-proxy` (the hotplug is a no-op without it) |
| Everything else | stock OpenWrt (`iw`, `ubus`, `uci`, `nftables`, BusyBox) |

On OpenWrt 24.10 and newer (`apk`):

```sh
apk update && apk add pbr wireguard-tools kmod-wireguard vnstat2 https-dns-proxy
```

On older releases (`opkg`):

```sh
opkg update && opkg install pbr wireguard-tools kmod-wireguard vnstat2 https-dns-proxy
```

## Installation

Back up your router first (LuCI → System → Backup, or `sysupgrade -b`). Then, from this repo's root:

```sh
./install.sh 192.168.1.1
```

Pass whatever address your router is on — `192.168.1.1` is the OpenWrt default, GL.iNet ships `192.168.8.1`, and a hostname works too. With no argument it assumes the OpenWrt default. SSH key auth is expected; run `ssh-copy-id root@<router>` first if you haven't.

The script:

- checks it can reach the router, reports the model, and warns about optional packages that are missing rather than failing on them;
- copies the pages, CGI, helper daemons, and hotplug scripts, then sets the executable bits (`cp` does not preserve them reliably, and a non-executable CGI returns 403 while a non-executable hotplug script is ignored *silently*);
- seeds `/etc/dashboard/classmap` only if you don't already have one;
- adds the cron entries and the `/etc/sysupgrade.conf` lines idempotently, so re-running never duplicates them;
- fetches every endpoint from the router itself to confirm the install is live.

Re-run it any time to upgrade — it preserves the device names in your classmap.

Then open `http://<router>/dashboard/`. LuCI is untouched at `http://<router>/cgi-bin/luci/`.

<details>
<summary>Installing by hand instead</summary>

```sh
R=192.168.1.1          # your router

ssh root@$R "mkdir -p /tmp/beryl7"
# tar over ssh, not scp: stock dropbear has no sftp server
tar -cf - www usr etc | ssh root@$R "tar -xf - -C /tmp/beryl7"

ssh root@$R
cp -r /tmp/beryl7/www/* /www/
cp /tmp/beryl7/usr/sbin/* /usr/sbin/
mkdir -p /usr/share/beryl && cp /tmp/beryl7/usr/share/beryl/cgi-lib.sh /usr/share/beryl/
cp -r /tmp/beryl7/etc/hotplug.d /tmp/beryl7/etc/init.d /tmp/beryl7/etc/sysctl.d /etc/

# cgi-lib.sh is sourced, not executed, so it needs no exec bit — but every CGI
# does, and a CGI without one is a 403 with nothing in the log to explain it.
chmod 755 /www/cgi-bin/*-api /usr/sbin/dashmon /usr/sbin/apwatch /usr/sbin/vpnwatch \
          /usr/sbin/beryl-vpndns /usr/sbin/beryl-pbrtbl /usr/sbin/pingmon \
          /etc/hotplug.d/iface/* /etc/hotplug.d/net/30-tethering \
          /etc/init.d/cpugovernor /etc/init.d/pingmon

# dashmon feeds the Overview history panels; the two watchdogs are optional
crontab -l > /tmp/cron; cat /tmp/beryl7/etc/crontabs/root >> /tmp/cron; crontab /tmp/cron

mkdir -p /etc/dashboard
cp /tmp/beryl7/etc/dashboard/classmap.example /etc/dashboard/classmap

# optional: load-based CPU scaling
/etc/init.d/cpugovernor enable && /etc/init.d/cpugovernor start
```

To survive sysupgrades, append the installed paths to `/etc/sysupgrade.conf` — the installer does this for you, and the full list is in [install.sh](install.sh).

</details>

## Tor

Optional. Install the package and a panel appears on the VPN page to start and stop it; without the package the panel is simply absent and nothing else changes.

```sh
apk add tor        # or: opkg install tor
```

The panel reports whether Tor is running, its bootstrap progress while it starts, and the two proxy addresses. Point a browser or app at either to open `.onion` sites:

| Protocol | Address | For |
|---|---|---|
| SOCKS5 | `<router>:9050` | Tor Browser, Firefox, curl, most apps |
| HTTP CONNECT | `<router>:9080` | iOS/macOS Wi-Fi proxy settings, which cannot take a SOCKS host |

Configure them in `/etc/tor/torrc` — the console reads the port numbers from that file rather than assuming them.

**Nothing is routed through Tor automatically.** Only traffic you explicitly send to the proxy uses it, so ordinary browsing keeps its normal path and its VPN policy, and no exit node is involved when you are reaching an onion service.

**Why a proxy and not a transparent redirect.** The usual recipe — `server=/onion/127.0.0.1#9053` in dnsmasq plus an nftables redirect of Tor's virtual `10.192.0.0/10` range to a `TransPort` — cannot work on current OpenWrt. dnsmasq 2.93 implements RFC 7686 and answers `.onion` with NXDOMAIN from local config without ever forwarding the query; an identical `server=` line for any other TLD forwards correctly, and pointing `.onion` at a public resolver still returns NXDOMAIN. There is no option to disable it.

The proxy is the better arrangement regardless: with SOCKS5h or HTTP CONNECT the onion hostname is resolved *inside* Tor, so it never reaches the router's resolver and never appears in its DNS cache or query log. The transparent design would have recorded every onion name you visited.

**On anonymity.** This gives network-level anonymity for traffic sent through it. It does not make an ordinary browser anonymous — fingerprinting identifies you regardless of the path. For that, run Tor Browser on the device itself.

## Backup and restore

Two scripts, because a router you rely on will eventually be reset, reflashed, or upgraded.

```sh
./backup.sh 192.168.8.1                             # -> backups/beryl7-<host>-<date>.tar.gz
./restore.sh 192.168.1.1 backups/beryl7-....tar.gz  # onto a fresh router
```

`backup.sh` uses OpenWrt's own `sysupgrade -b`, which honours `/etc/sysupgrade.conf` — and `install.sh` puts every console path in there. So one tarball holds **both** your router's configuration (networks, SSIDs, firewall, pbr policies, static leases) **and** the console, and it stays correct as the console grows. It saves the installed package list alongside it.

`restore.sh` installs the packages **first**, then restores the configuration. That order is the whole point of the script: `/etc/config/pbr` means nothing until `pbr` exists, and netifd discards WireGuard interfaces it has no protocol handler for — restore first and your tunnels vanish silently.

> **The bundle contains WireGuard private keys and Wi-Fi passphrases.** `backups/` is gitignored here. Keep yours in a *private* repository or encrypted storage — never a public one.

A full recovery from bare firmware is then:

1. Flash OpenWrt, set a root password, install your SSH key (`ssh-copy-id root@192.168.1.1`).
2. `./restore.sh 192.168.1.1 backups/beryl7-....tar.gz`
3. The router reboots onto your old address with your configuration and the console already in place.

If you only want the console back and not the old configuration, run `./install.sh <router>` instead — that is the clean-slate path.

## Security model

**There is no login. Anyone who can reach the router over HTTP can read the console and change settings.**

That is a deliberate choice, not an oversight. This was built for a personal travel router used by its owner and a few friends on a network they control — never reachable from the internet. On that network, a password prompt in front of every action was pure friction: it protected against nobody who wasn't already inside, while making the phone-in-one-hand case (join a hotel Wi-Fi, restart a wedged radio) slower every single time.

**The boundary is the firewall, not the UI.** That is where the decision has to hold:

- WAN input `DROP` or `REJECT` (the reference router runs `REJECT`, OpenWrt's default), so nothing from the internet ever reaches port 80.
- Guest and IoT zones `input REJECT`, so devices you don't trust — a friend's laptop, a smart plug — cannot reach the console either.
- Only the trusted LAN can load it, and everyone on the trusted LAN is assumed to be allowed to run the router.
- No port forwards to the router's own web server. Ever.

If you cannot say all four of those about your network, do not install this until you can.

**What is still enforced**, because it defends against something a firewall cannot:

- **Writes are POST-only and same-origin checked.** Without this, any web page you happened to be visiting could quietly reconfigure your router through your own browser — your LAN position, borrowed. The origin check refuses it, and a `GET ?action=…` write is rejected outright. This is not the password in another form; it stops a completely different attack, and it stays.
- **Destructive actions still confirm**, stating the consequence first — deleting a tunnel, turning a radio off, rebooting. That guards against a misclick, not an intruder.
- **No TLS.** uhttpd serves plain HTTP. Fine on a network you physically control, unacceptable anywhere else.

**If you want it locked down**, the honest answer is not to bolt a password onto these scripts — put uhttpd behind HTTP basic auth, or serve the console only over a WireGuard tunnel into your own LAN. Either is stronger than what was removed.

## Hardware notes and gotchas

Things learned the hard way, encoded in the code and worth knowing before porting:

- **Both radios share one PHY.** `wifi reload` bounces 2.4 GHz and 5 GHz together, and transmit power is coupled across bands. This is why `apwatch` exists and why the Settings page warns about it.
- **Huawei HiLink dongles hand out `192.168.8.0/24`** — byte-identical to the router's own LAN. `31-tethering-clash` tears down any USB uplink whose subnet collides with a routed network, because you cannot know the subnet until DHCP has already answered.
- **Changing the router's own address is the one setting that can lock you out**, so Settings refuses a subnet that collides with anything else the router routes: a live interface (the WAN, a tethered modem, a joined hotel uplink) or a network that merely exists in UCI with its interface down, such as a guest network you have not enabled yet. `192.168.1.1` is the address people reach for first and is also the likeliest upstream subnet; taking it leaves the console reachable while nothing can get out, with no symptom that points at the cause. Note this is deliberately stricter than `31-tethering-clash`, which weighs live routes only — refusing an uplink over a dormant network would strand a traveller, whereas refusing an address costs one retype.
- **iPhone tethering + eager reset scripts don't mix.** The stock `40-usbmuxd` hotplug reset the phone in a loop before ipheth could ever confirm pairing. The stub in this repo documents the failure mode; leave it disabled.
- **DoH breaks captive portals.** Hotel sign-in pages work by hijacking plaintext DNS; if all DNS is DoH, the portal never appears and you are stranded. `15-travel-dns` switches to the uplink's plaintext DNS only while a travel uplink is active, and restores DoH at home.
- **The tethering netdev name is not predictable** (`ethN` / `usbN` / `wwanN` depending on driver flags); `30-tethering` binds whatever appears instead of hardcoding.
- **pbr + fail-closed means a dead tunnel silently strands its devices.** That is the correct default. `vpnwatch` only ever does something if you explicitly opt into fail-open via `/etc/dashboard/vpn-failmode`.

## Porting to other routers

Nothing about your addressing, SSID naming, or radio layout is written into the code. What the console needs, it asks the router for:

| Thing | How it's found |
|---|---|
| Wireless interface names | `iw dev` — never a `wlan*` or `phy0.*` glob, because the naming differs per build |
| Radios and their bands | enumerated from UCI `wifi-device` sections; band comes from the radio, so `radio0` need not be 2.4 GHz |
| Each radio's AP section | the `wifi-iface` pointing at that radio — `default_radio0`, `main2g`, or whatever yours is called |
| Restarting a radio | the page names the radio; the API checks that name against the router's own list rather than mapping a band onto `radio0`/`radio1` |
| A Wi-Fi uplink's band | read from that radio's `band` and sent to the page, so the label is never inferred from the radio's name |
| A secondary SSID (IoT/guest) | the first AP on a network other than `lan`; the panel disappears when there is none |
| Which network an address is on | matched against the interfaces UCI actually defines |
| The LAN bridge | `network.lan.device` |
| Radio capabilities | `iw phy` at request time, per radio — no hardcoded channel tables |
| The uplink | whichever device holds the main-table default route |

The one name assumed is `lan` for the primary network, which is the OpenWrt default everywhere.

What genuinely remains board-specific:

- Temperature and fan reads use `thermal_zone0` and hwmon-by-name; both degrade to "unavailable" rather than breaking.
- PHY capability parsing follows `iw phy` output, which does vary between drivers — the most likely thing to need a tweak.
- The USB uplink page knows the driver set listed in `30-tethering`; an exotic modem may need adding.

A stock dual-band OpenWrt router should work as-is. Verify against your own hardware before trusting it.

## Status

Personal project, actively used daily on one router. Published as a backup and in case it is useful to someone — issues and questions are welcome, but there is no roadmap and no support obligation. The `legacy/` directory and `theme.css` are the first iteration of the UI, superseded by `os.css`/`os.js`, kept for reference.

## License

[MIT](LICENSE)
