# Running notes — next steps and open questions

A working doc. Newest decisions at the top of each section; strike things out
rather than deleting them, so the reasoning stays visible.

Last updated: 24 August 2026

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
| iOS Shortcut on the home screen that opens the URL in Bluefy | One tap from the home screen, looks like an app | Needs Bluefy's URL scheme to exist and accept a target URL **[Test it]** |
| Native app wrapping WKWebView + CoreBluetooth | A real app | Rebuilds Bluefy. Only worth it if the shim fails |
| ~~Safari PWA + Web Bluetooth~~ | — | Impossible. Not a matter of effort |

So the goal should be restated as **"one-tap launch into a browser that can do
BLE"**, not "PWA on iOS". The manifest and service worker still earn their keep
for the desktop install and offline shell, so they stay.

### The pivotal unknown, and a fallback nobody seems to have noticed

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

1. **Smoke-test Bluefy** with `web/diagnostics.html` — a standalone page that
   runs the whole FTMS sequence and reports which parts work, ending in a plain
   verdict (full control / notify-only fallback / nothing). It is a classic
   script with no imports, so a shim that breaks ES modules still lets the
   diagnostics run. Copy the report off the phone with the button.
2. **UUID form.** `web/ftms.js` passes numeric shorthand (`0x1826`); Chrome
   expands it, a shim may not. The diagnostics page now tries numeric first and
   falls back to the canonical 128-bit string, and reports which one worked —
   so measure before changing the app.
3. **Add a notify-only fallback mode** per the section above, behind a flag that
   the app can set automatically when no indication arrives during handshake.
4. **Check the service worker** — Bluefy's WKWebView may not support SW
   registration. The app must work with registration failing; it currently
   catches that, but it is untested.
5. **Screen-off survival.** Nobody has published this for any iOS Web BLE
   browser. Ride an hour with the screen locking and see whether GATT holds.
   The app calls both `navigator.wakeLock` and Bluefy's proprietary
   `setScreenDimEnabled`, so instrument which one actually fires.
6. **Home-screen launch.** Find out whether Bluefy registers a URL scheme; if it
   does, an iOS Shortcut gives a one-tap icon.

---

## Next steps, laptop side

### Correctness

- **Fault-inject the retry path.** `bike_trainer/control.py` and
  `web/trainer.js` both implement confirm-and-retry, and neither has ever
  executed its retry branch — 26 clean target changes so far. Force a failure
  (drop the confirmation wait, or write a deliberately bogus target) and verify
  the retry actually engages. Until then the ERG-stick protection is
  theoretical.
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
| 1 | Does Bluefy deliver GATT indications? | Open — gates the whole iOS path |
| 2 | Does the GATT link survive an hour with the screen off? | Open, unpublished by anyone |
| 3 | Can the ERG-stick bug be reproduced at all on firmware 31.065? | 26 changes, zero sticks. Unreproduced |
| 4 | Does the retry logic work when it fires? | Never executed. Needs fault injection |
| 5 | Does Bluefy expose a URL scheme for one-tap launch? | Open |

---

## Decision log

- **2026-08-24** — Built the client as a Web Bluetooth PWA rather than a page
  driven by a Python daemon. The daemon approach would have needed the control
  loop written twice; this way the desktop and the eventual phone client are the
  same code, and the only variable is the browser's BLE shim.
- **2026-08-24** — Service worker is network-first, not cache-first. Cache-first
  stranded the browser on a stale build during development.
- **2026-08-24** — Never send FTMS Reset (`0x01`). It revokes the control grant
  on this trainer, contradicting the orientation doc's prescribed handshake. See
  `FINDINGS.md`.
