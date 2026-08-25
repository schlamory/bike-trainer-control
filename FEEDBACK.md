# Running notes — next steps and open questions

A working doc. Newest decisions at the top of each section; strike things out
rather than deleting them, so the reasoning stays visible.

Last updated: 25 August 2026

---

## Where this stands

Working end to end on the laptop:

- Mac-side Python tooling — scan, GATT probe, telemetry rates, scripted workouts
  with per-second CSV logging.
- A Web Bluetooth PWA (`web/`) that connects, runs a configured interval
  workout, and holds ERG accurately. Verified against the real trainer in
  Chrome 151 on macOS.
- Protocol facts measured rather than assumed — see `FINDINGS.md`.

Not started: FIT export, `.zwo` import, ramps, anything on the phone.

---

## iOS: the part that needs a decision before it needs code

### A true iOS PWA cannot do Bluetooth. This is not a bug to work around.

Worth being blunt because it changes what "getting it working as a PWA on iOS"
can mean:

- **Safari has no Web Bluetooth**, on desktop or iOS. WebKit declined to
  implement it ([standards-positions #570](https://github.com/WebKit/standards-positions/issues/570)).
  Confirmed first-hand — Safari on this Mac reports no `navigator.bluetooth` at all.
- On iOS, **only Safari can install a page to the home screen** as a standalone
  web app. A home-screen icon added from Safari opens in Safari, which cannot
  do BLE.
- Therefore the two properties — *installed as a PWA* and *can reach the
  trainer* — are mutually exclusive on iOS today. No manifest tweak fixes this.

What is actually achievable, in descending order of niceness:

| Approach | Feels like | Reality |
| --- | --- | --- |
| Bookmark inside Bluefy | Two taps: open Bluefy, tap bookmark | Works today, assuming Bluefy's shim is adequate **[Test it]** |
| iOS Shortcut on the home screen that opens the URL in Bluefy | One tap from the home screen, looks like an app | **Working.** This is the launch path in use |
| Native app wrapping WKWebView + CoreBluetooth | A real app | Rebuilds Bluefy. Only worth it if the shim fails |
| ~~Safari PWA + Web Bluetooth~~ | — | Impossible. Not a matter of effort |

So the goal should be restated as **"one-tap launch into a browser that can do
BLE"**, not "PWA on iOS". The manifest and service worker still earn their keep
for the desktop install and offline shell, so they stay.

### RESOLVED 24 Aug 2026: indications work in Bluefy

Tested on Bluefy 3.9.3 / iOS 18.7. Control-point indications arrive normally,
the feature read matches the Mac byte for byte, and the status echo confirms
targets. **Full FTMS control works on the phone; the app needs no protocol
changes.** Details in `FINDINGS.md`.

Two things the test caught:

- `requestDevice` rejects 16-bit numeric UUIDs — fixed, `web/ftms.js` now uses
  canonical 128-bit strings everywhere. The app would not have connected
  otherwise.
- Service workers are unavailable in Bluefy, so no offline shell or
  installability there. Already guarded; desktop keeps both.

The notify-only fallback below is therefore **not needed**. Keeping the
reasoning as insurance in case a future Bluefy release regresses.

### ~~The pivotal unknown~~, and a fallback nobody seems to have noticed

FTMS delivers control-point responses over **indications**, and it is
undocumented whether Bluefy's shim subscribes to the indicate path. If it
silently does notify-only, every control-point response vanishes.

**But the control point is not the only confirmation channel.** From
`FINDINGS.md`: Fitness Machine Status (`0x2ADA`) is a **notify** characteristic,
it fires within ~10 ms of every target change, and it *echoes the exact
wattage*. So if indications turn out to be unavailable:

- Target confirmation still works — arguably better, since the echo carries the
  value rather than a bare success code.
- Control acquisition becomes inferential: send Request Control and Start
  optimistically, then treat *"a Set Target Power produced a matching `0x2ADA`
  echo"* as proof that control was granted. If no echo arrives, we never had it.

That means the app can degrade to a notify-only path without losing the
ERG-stick protection, which is the thing that actually matters. Worth building
as an explicit fallback mode rather than discovering it in a panic.

### Hosted on GitHub Pages

**<https://schlamory.github.io/bike-trainer-control/>** — stable, HTTPS, and
redeployed by `.github/workflows/pages.yml` on any push to `main` touching
`web/`. The app is static, so the workflow uploads the directory with no build
step. Verified running from the hosted subpath: secure context, modules resolve,
service worker scoped correctly, a full ride completed.

This is the address to bookmark in Bluefy, and it is what makes the iOS
Shortcut idea possible — a home-screen shortcut needs a URL that does not move.

The tunnel below is now only for testing changes that have not been pushed.

### Serving during development: cloudflared

Web Bluetooth requires a **secure context** — HTTPS, or `localhost`. A phone
loading `http://192.168.x.x:8756` is neither, so the LAN path is a dead end
regardless of connectivity. (It also simply did not work: with the macOS
firewall off and the server correctly bound to all interfaces, the phone still
could not reach it. Not worth further debugging, since the secure-context wall
sits behind it anyway.)

A Cloudflare quick tunnel puts an unpushed working copy on the phone. This is
how Bluefy was first verified, before Pages existed.

```sh
uv run serve.py --lan --no-open        # terminal 1: static files on :8756
cloudflared tunnel --url http://localhost:8756   # terminal 2: prints the HTTPS URL
```

`cloudflared` is installed via Homebrew. No account or login is needed for
quick tunnels.

Two properties to keep in mind:

- **The URL changes every time the tunnel restarts.** Fine for testing, no good
  for a home-screen shortcut or a saved bookmark.
- **The page is publicly reachable while the tunnel is up.** It is a static app
  with no secrets and no server-side state, so the exposure is low, but it is
  real — stop the tunnel when you are done rather than leaving it running.

### Later: a permanent home

Superseded — GitHub Pages is the permanent home, and it costs nothing to keep.
Moving to a personal server is now optional rather than planned. If it happens,
the requirement stays trivial: static HTTPS hosting and a stable hostname.
`web/` is the whole deployable artifact — no build step, runtime, or backend.

### RESOLVED 24 Aug 2026: indications work in Bluefy

Tested on Bluefy 3.9.3 / iOS 18.7. Control-point indications arrive normally,
the feature read matches the Mac byte for byte, and the status echo confirms
targets. **Full FTMS control works on the phone; the app needs no protocol
changes.** Details in `FINDINGS.md`.

Two things the test caught:

- `requestDevice` rejects 16-bit numeric UUIDs — fixed, `web/ftms.js` now uses
  canonical 128-bit strings everywhere. The app would not have connected
  otherwise.
- Service workers are unavailable in Bluefy, so no offline shell or
  installability there. Already guarded; desktop keeps both.

The notify-only fallback below is therefore **not needed**. Keeping the
reasoning as insurance in case a future Bluefy release regresses.

### ~~The pivotal unknown~~, and a fallback nobody seems to have noticed

FTMS delivers control-point responses over **indications**, and it is
undocumented whether Bluefy's shim subscribes to the indicate path. If it
silently does notify-only, every control-point response vanishes.

**But the control point is not the only confirmation channel.** From
`FINDINGS.md`: Fitness Machine Status (`0x2ADA`) is a **notify** characteristic,
it fires within ~10 ms of every target change, and it *echoes the exact
wattage*. So if indications turn out to be unavailable:

- Target confirmation still works — arguably better, since the echo carries the
  value rather than a bare success code.
- Control acquisition becomes inferential: send Request Control and Start
  optimistically, then treat *"a Set Target Power produced a matching `0x2ADA`
  echo"* as proof that control was granted. If no echo arrives, we never had it.

That means the app can degrade to a notify-only path without losing the
ERG-stick protection, which is the thing that actually matters. Worth building
as an explicit fallback mode rather than discovering it in a panic.

### Hosted on GitHub Pages

**<https://schlamory.github.io/bike-trainer-control/>** — stable, HTTPS, and
redeployed by `.github/workflows/pages.yml` on any push to `main` touching
`web/`. The app is static, so the workflow uploads the directory with no build
step. Verified running from the hosted subpath: secure context, modules resolve,
service worker scoped correctly, a full ride completed.

This is the address to bookmark in Bluefy, and it is what makes the iOS
Shortcut idea possible — a home-screen shortcut needs a URL that does not move.

The tunnel below is now only for testing changes that have not been pushed.

### Serving during development: cloudflared

Web Bluetooth requires a **secure context** — HTTPS, or `localhost`. A phone
loading `http://192.168.x.x:8756` is neither, so the LAN path is a dead end
regardless of connectivity. (It also simply did not work: with the macOS
firewall off and the server correctly bound to all interfaces, the phone still
could not reach it. Not worth further debugging, since the secure-context wall
sits behind it anyway.)

A Cloudflare quick tunnel puts an unpushed working copy on the phone. This is
how Bluefy was first verified, before Pages existed.

```sh
uv run serve.py --lan --no-open        # terminal 1: static files on :8756
cloudflared tunnel --url http://localhost:8756   # terminal 2: prints the HTTPS URL
```

`cloudflared` is installed via Homebrew. No account or login is needed for
quick tunnels.

Two properties to keep in mind:

- **The URL changes every time the tunnel restarts.** Fine for testing, no good
  for a home-screen shortcut or a saved bookmark.
- **The page is publicly reachable while the tunnel is up.** It is a static app
  with no secrets and no server-side state, so the exposure is low, but it is
  real — stop the tunnel when you are done rather than leaving it running.

### Later: a permanent home

Once things stabilise this moves to a personal server. What it needs is
undemanding — the app is entirely static, does all its work in the browser, and
never talks to a backend:

- Static file hosting over HTTPS with a valid certificate. That is the whole
  requirement.
- A stable hostname, which is the thing the tunnel cannot give. It unlocks a
  saved Bluefy bookmark, and an iOS Shortcut for one-tap launch.
- No build step, no runtime, no database. `web/` is the deployable artifact;
  copying the directory is a complete deploy.

GitHub Pages remains a reasonable fallback if the server slips, but the
personal server is the plan of record.

### RESOLVED 24 Aug 2026: indications work in Bluefy

Tested on Bluefy 3.9.3 / iOS 18.7. Control-point indications arrive normally,
the feature read matches the Mac byte for byte, and the status echo confirms
targets. **Full FTMS control works on the phone; the app needs no protocol
changes.** Details in `FINDINGS.md`.

Two things the test caught:

- `requestDevice` rejects 16-bit numeric UUIDs — fixed, `web/ftms.js` now uses
  canonical 128-bit strings everywhere. The app would not have connected
  otherwise.
- Service workers are unavailable in Bluefy, so no offline shell or
  installability there. Already guarded; desktop keeps both.

The notify-only fallback below is therefore **not needed**. Keeping the
reasoning as insurance in case a future Bluefy release regresses.

### ~~The pivotal unknown~~, and a fallback nobody seems to have noticed

FTMS delivers control-point responses over **indications**, and it is
undocumented whether Bluefy's shim subscribes to the indicate path. If it
silently does notify-only, every control-point response vanishes.

**But the control point is not the only confirmation channel.** From
`FINDINGS.md`: Fitness Machine Status (`0x2ADA`) is a **notify** characteristic,
it fires within ~10 ms of every target change, and it *echoes the exact
wattage*. So if indications turn out to be unavailable:

- Target confirmation still works — arguably better, since the echo carries the
  value rather than a bare success code.
- Control acquisition becomes inferential: send Request Control and Start
  optimistically, then treat *"a Set Target Power produced a matching `0x2ADA`
  echo"* as proof that control was granted. If no echo arrives, we never had it.

That means the app can degrade to a notify-only path without losing the
ERG-stick protection, which is the thing that actually matters. Worth building
as an explicit fallback mode rather than discovering it in a panic.

### Getting the page onto the phone at all

Web Bluetooth requires a **secure context**: HTTPS, or `localhost`. A phone
loading `http://192.168.x.x:8756` is neither, so the origin may be rejected
before any Bluetooth call is made.

`uv run serve.py --lan` binds all interfaces and prints the address to try.
The diagnostics page reports `isSecureContext` as its second check, so it says
immediately whether this is a problem — worth 30 seconds before assuming it is.
Bluefy's shim may not enforce the requirement the way a standards-compliant
browser does.

If it does enforce it, in order of effort:

1. **GitHub Pages** — the repo is already a static site under `web/`. Free
   HTTPS, permanent URL, and the orientation doc's original suggestion.
2. **A tunnel** (`cloudflared tunnel --url http://localhost:8756`) — instant
   HTTPS for a one-off test, but it publishes the page publicly for the
   duration.
3. Self-signed cert served locally — needs the cert trusted in iOS Settings.
   Fiddliest of the three; only worth it to stay entirely offline.

### iOS work items

1. ~~Smoke-test Bluefy~~ **Done.** `web/diagnostics.html` reports the full
   picture and is worth re-running after any Bluefy update.
2. ~~UUID form.~~ **Done.** Bluefy rejected numeric UUIDs in `requestDevice`;
   `web/ftms.js` now uses 128-bit strings throughout.
3. ~~Add a notify-only fallback mode.~~ **Not needed** — indications work.
4. ~~Check the service worker.~~ **Answered: unavailable in Bluefy**
   (`'serviceWorker' in navigator` is false). The feature test already handles
   it. Offline shell and install are desktop-only.
5. **Screen-off survival.** Nobody has published this for any iOS Web BLE
   browser. Ride an hour with the screen locking and see whether GATT holds.
   The app calls both `navigator.wakeLock` and Bluefy's proprietary
   `setScreenDimEnabled`, so instrument which one actually fires.
6. ~~**Home-screen launch.**~~ **Done.** An iOS Shortcut pointing at a
   `/workout/<slug>` address gives a one-tap home-screen launch into Bluefy.

7. ~~**Full-screen on launch.**~~ **Not achievable; out of scope.** Bluefy
   3.9.3 / iOS 18.7 does not render a PWA-compliant page borderless: with a
   valid manifest, `"display": "standalone"` and PNG icons at 192/512 all
   served, it still reports `display-mode: browser` with ~210 px of chrome.
   There is no page-side lever either — iPhone WKWebView has no Fullscreen API.

   Mitigated rather than solved: **focus mode** hides the header and workout
   panels while a ride is running, so the instrument fills whatever viewport
   Bluefy leaves. The workaround in practice is to leave the tab selected in
   Bluefy so it opens straight into it.

   Worth re-testing after a Bluefy update — `diagnostics.html` now reports
   display-mode, chrome height, the Fullscreen API and vendor hooks, so it is
   a re-run rather than an investigation.

---

## Next steps, laptop side

### Correctness

- ~~**Fault-inject the retry path.**~~ **Done for the web driver.**
  `transport/mock-gatt.js` reproduces the stick deterministically — a write
  acknowledged on the control point with no status echo — and the retry engages
  and recovers (`unconfirmed … retry 1/4` → `confirmed on attempt 2`). Run
  `?mock=gatt&stick=0.4`. **`bike_trainer/control.py` is still untested**; it
  has the same logic and deserves the same treatment.
- **Reconnect on drop.** The PWA currently ends the ride when the trainer
  disconnects. A ride should survive a brief dropout and resume at the right
  point in the plan.

### Workout model

- **Ramps.** Only square steps exist today. `.zwo` is full of `Warmup` and
  `Ramp` elements, and the breakpoint-list model in the orientation doc handles
  them naturally by interpolating at 1 Hz.
- **%FTP authoring.** FTP is currently used only for zone colour. Letting steps
  be written as `88%/5m` and resolving against it is a small change and is what
  makes imported workouts portable.
- **`.zwo` import**, once ramps exist. Watch the gotchas listed in the
  orientation doc — `PowerLow` often exceeds `PowerHigh`, and `Repeat` counts
  on/off pairs.
- **Pre-emptive ramp-down.** Measured: dropping from 230 W takes 3–4 s against
  ~2 s to climb. For short recovery valleys the app could issue the drop a
  second or two early so the delivered profile matches the prescribed one. Worth
  measuring before deciding — it may be over-engineering.

### Ride data

- **FIT export** for upload to Strava/intervals.icu. Fiddliest part of the whole
  project; defer until the training side is settled.
- **Record from the PWA at all.** The Python path logs per-second CSV; the web
  app currently logs nothing to disk. At minimum it should offer the same CSV.
- **Save workouts.** Interval text is retyped every session. `localStorage` is
  enough.

---

## Open questions

| # | Question | Status |
| --- | --- | --- |
| 1 | ~~Does Bluefy deliver GATT indications?~~ | **Answered: yes**, Bluefy 3.9.3 / iOS 18.7 |
| 2 | Does the GATT link survive an hour with the screen off? | Open, unpublished by anyone |
| 3 | Can the ERG-stick bug be reproduced at all on firmware 31.065? | 26 changes, zero sticks. Unreproduced |
| 4 | Does the retry logic work when it fires? | **Web driver: yes**, proven against a simulated stick. Python driver: still untested |
| 5 | Does Bluefy expose a URL scheme for one-tap launch? | Open — now worth answering, the URL is stable |

---

## Decision log

- **2026-08-24** — Built the client as a Web Bluetooth PWA rather than a page
  driven by a Python daemon. The daemon approach would have needed the control
  loop written twice; this way the desktop and the eventual phone client are the
  same code, and the only variable is the browser's BLE shim.
- **2026-08-24** — Service worker is network-first, not cache-first. Cache-first
  stranded the browser on a stale build during development.
- **2026-08-25** — The ride clock is wall-clock, not tick-counted: a
  backgrounded page catches up in one step instead of the workout running long.
  Measured: a 30 s suspension advances elapsed by 31 s and skips the intervals
  it spanned, which never reach the trainer; away longer than the remaining
  workout and it completes the moment you return.

  Kept deliberately. Freezing the clock on hide would complete all the
  prescribed work, but a glance at a notification would drop resistance
  mid-effort, and the resulting behaviour is harder to predict. Predictable
  beats complete here. The one change made was to log any gap over 3 s, so the
  skip is visible rather than silent.
- **2026-08-25** — Full-screen on iOS abandoned after measurement, not
  assumption. The manifest work is kept anyway: it fixes the home-screen icon,
  since iOS ignores an SVG `apple-touch-icon` outright.
- **2026-08-24** — Hosted on GitHub Pages, deployed by Actions from `web/`.
  Chosen over a personal server because it is free, needs no maintenance, and
  the repo has nothing sensitive in it. Keeping `web/` where it is rather than
  renaming to `docs/` or maintaining a `gh-pages` branch.
- **2026-08-24** — Two seams, not one: `TrainerController` (equipment) and
  `GattTransport` (browser). The second exists mainly so the FTMS driver itself
  is testable — a mock at the controller seam replaces the driver and therefore
  can never exercise its retry logic, which was the one branch that mattered.
- **2026-08-24** — Cloudflare quick tunnels are the gateway for now. The LAN
  cannot work (plain http is not a secure context, and the phone could not
  reach the Mac anyway), and a tunnel needs no account and no DNS. Accepted
  costs: the URL rotates on restart, and the page is briefly public. Moving to
  a personal server once the app stabilises — a stable hostname is what buys a
  bookmark and a home-screen shortcut.
- **2026-08-24** — Web UUIDs are canonical 128-bit strings, never 16-bit
  numeric shorthand. Chrome accepts both; Bluefy's `requestDevice` rejects
  numbers. Strings are the only form that works in both.
- **2026-08-24** — Never send FTMS Reset (`0x01`). It revokes the control grant
  on this trainer, contradicting the orientation doc's prescribed handshake. See
  `FINDINGS.md`.
