# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One user: the owner, Farras. Expert — he administers the router over SSH when he has to, and built this so he does not have to. Nobody else opens the console (confirmed 2026-09-15); household members and guests are served by the network, not by the UI.

He reads it on an **iPhone first, an iPad second, a Windows PC at home third**, and occasionally on Android. Two scenes: at home (checking who is connected, routing a device through a tunnel, adjusting radios), and travelling (joining hotel Wi-Fi, tethering a phone, keeping the VPN honest on a hostile uplink) — often with a phone as the only device and one bar of signal.

## Product Purpose

A hand-built web console for the GL.iNet Beryl 7 (GL-MT3600BE) travel router running vanilla OpenWrt 25.12.5. It replaces day-to-day use of LuCI and the vendor UI for the things a travel router actually does: seeing who is connected and how the internet is doing, joining an upstream Wi-Fi, USB tethering, routing devices through WireGuard tunnels, adjusting the radios, and being told when something changes. LuCI stays untouched at `/cgi-bin/luci/` for everything else.

Success is answering "who is here / is the internet OK / why is there no internet" from a phone, without SSH, in a hotel — and having changed the thing that needed changing in the same session.

## Positioning

- **Discovers, never assumes.** Radios, interfaces, networks, the tethering netdev, the uplink carrying the default route — all read from the router at runtime. Nothing about addressing, SSID naming or radio layout is written into the code.
- **State is never a description.** A status word is a live reading or it is absent; the console does not fill space with prose that could be mistaken for a measurement. Colour appearing means something.
- **No login, by decision.** The boundary is the firewall (LAN zone accepts, guest/IoT reject, WAN never reaches it); the console is internal tooling for a network the owner controls. Writes are POST-only and same-origin checked.
- **Measured, not recalled.** Radio limits, contrast ratios, polling costs, regulatory behaviour — decisions cite a measurement on this router, and the code carries the reason in a comment where the decision lives.

## Operating Context

- Served by uhttpd from `/www` over **plain http on the LAN** (no `navigator.clipboard`; `document.execCommand('copy')` is the working path). Reached from anywhere only through a WireGuard tunnel or the Telegram bot on the VPS.
- Backend is **busybox ash CGI** (`/www/cgi-bin/*-api`) sharing `/usr/share/beryl/cgi-lib.sh`. No bash, no `stat`, no sub-second sleep, no `timeout`. Config files are parsed as data, never sourced.
- Full state snapshot every 5 s (`dashboard-api`, ~0.8 s on the router), cheap counters every 1 s (`rate-api`). The console does not poll in a hidden tab.
- **One PHY hosts both radios**: `wifi reload` bounces 2.4 and 5 GHz together; 5 GHz cannot scan while its AP is up; transmit power is coupled. Half the console's odd-looking decisions trace to this.
- Push notifications via ntfy (`notifymon` from cron, `wifiwatch` in real time with per-device flap suppression). `pingmon` keeps a 5-minute probe ring.
- Delivery: `bump-assets.sh` stamps assets and pages as **one deploy unit**; `install.sh` copies the tree to the router (glob-driven, verified by manifest, the install block fed on stdin because dropbear caps the exec string); `drift.sh` runs first so a deploy never erases a change the bot or an SSH session made on the router. New shipped files need all three tracks: repo, install preserve list, `/etc/sysupgrade.conf`.
- Standing order since 2026-09-12: console changes go **straight to `main` and the router**; the owner reviews on the live router, not in a diff. A whole-world replacement is the exception where a branch and a day of living with it come first.
- Verification is by headless Chrome render (`shots.ps1`; ~500 px width floor on Windows, so 520 is the honest phone proxy), the bundled design detector, and esprima for JS syntax — never by browser-injected JavaScript.

## Capabilities and Constraints

**Today (five pages):** Overview (path, devices with signal, throughput/ping/jitter/loss, system vitals, traffic today), VPN (WireGuard tunnels from a pasted `.conf`, per-device routing via pbr, fail mode, WireGuard access for the owner's own devices), Wi-Fi uplink (scan/join/forget, source ranking by metric), USB uplink (iPhone/Android/HiLink/modem tethering, modem profiles), Settings (radios with valid channel/width combinations derived live, SSIDs incl. guest and IoT, LAN/DHCP, IPv6 mode, push notifications, saved ping targets, hostname/timezone, backup download, update check, **iPerf server**, live system log).

**Binding constraints:**
- Vanilla HTML/CSS/JS. No framework, no build step, no CDN, **no webfonts** (a download that fails in exactly the hotel where the page is needed). System font stack.
- Phone layout first; every page must work from 360 px to desktop, light and dark.
- No live SSID, hostname, subnet, MAC, device name, tunnel label or owner name in the public repository, placeholders included. `www/legacy/` is out of scope for new work.
- Router-side behaviour is a **frozen baseline** (2026-08-11): any change to services, firewall, wireless mechanics or the do-not-touch list (F2 reload paths, the odhcp6c orphan reaper, repeater lifecycle) needs its own explicit approval. Console UI changes do not.
- `wpad-basic-mbedtls`: `bss_transition`, `wnm_sleep_mode*`, `proxy_arp`, `na_mcast_to_ucast` take the radio down; 802.11v is unavailable. 802.11r is **off** since 2026-09-12 (iPhone Air flap storm). Wireless optimum is `country=ID`, 5 GHz ch 36 EHT160, 2.4 GHz ch 13 EHT20 — measured, restored 2026-09-15.
- IPv6 relay/passthrough is live and gives real public v6; uhttpd is IPv4-only by decision.

**Terminology (fixed):** Overview · Path (Internet → Uplink → VPN) · Devices · Uplink (the source carrying the default route; "carrying" / "standby" / "down") · Tunnel · Routed · Radios (2.4 GHz / 5 GHz) · Guest · IoT. State words are Sentence case.

**Explicitly undecided (2026-09-15, pending the owner's answer on the transformation plan):** merging Wi-Fi uplink and USB uplink into one Uplink surface; adding an Activity feed, a Guest Wi-Fi QR, an internet speed test, and a one-switch Travel mode; enabling home-screen (standalone) mode on iOS. None of these is committed.

## Brand Commitments

- **Identity:** the GL.iNet mark (the *i* with Wi-Fi arcs, lifted from the logotype) and the name **Beryl 7**, with "network console" beneath. Favicon is the mark in white on maroon. Confirmed binding 2026-09-15.
- **Material: liquid glass** — translucent, blurred panes with a 1 px specular inset edge; depth by translucency and stacking, never a drop shadow; a ground with colour under the panes so the glass reads as glass. This is the one thing a full transformation must keep; everything else about the current look is open.
- **One accent, maroon.** No accent picker. Semantic colours (green / amber / red) carry state only, tuned to ≥ 4.5:1 against the composited surface they sit on.
- **Language:** English UI copy (confirmed 2026-09-15). Direct, specific, no marketing register; a control names its action; an error names the problem and the recovery.
- **Voice in code:** every non-obvious decision carries its reason in a comment where it lives. The headers are the documentation.

## Evidence on Hand

- Live data from the router's CGIs (the only truth; the console has no mock mode). `.shots/` holds headless renders — gitignored because they show real device names and addresses.
- `README.md` (public), `BERYL7-HANDOFF.md` (the owner's master record, not in the repo), `audit-qa-result/` (test suite and findings register maintained by a separate auditor session), and the memory directory of measured facts.
- No testimonials, customers, benchmarks or pricing exist and none may be implied. Throughput, latency and signal figures shown anywhere must come from the router.

## Product Principles

1. **Verification over assertion.** Nothing is called working until it was run and seen; a measurement beats a recollection; a broken check is surfaced before its result.
2. **Reduction over hardening.** Four of six past regressions came from adding mechanism. Deleting a redundant surface is a valid result; declining a latent defect is a valid result.
3. **The reading is the interface.** Show the live fact where the eye lands; put the control on the fact; never make the user hold the description of a thing and its state as two different sentences.
4. **The hotel is the design constraint.** One bar, a phone, plain http, no laptop. If it does not work there, it does not work.
5. **The owner's direction is the direction.** Execute the approved look better; never replace it on a reviewer's confidence.

## Accessibility & Inclusion

Read on a phone outdoors: all text ≥ 4.5:1 against the surface it actually sits on (composited, not the raw page colour). Every keyboard target has a visible focus ring; every field has a programmatic label; sections have real headings; infinite animations are gated behind `prefers-reduced-motion`. iOS: fields ≥ 16 px so focus never zooms the page; 44 px hit areas on 30 px controls. Semantic colour is always paired with a word.
