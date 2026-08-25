# bike-trainer-control

Structured ERG workouts on a Saris H3, over BLE FTMS.

**Live app: <https://schlamory.github.io/bike-trainer-control/>**

Chrome or Edge on the desktop, Bluefy on iOS. Safari has no Web Bluetooth and
never will — that is why Bluefy exists. Pushes to `main` that touch `web/`
redeploy automatically.

The app talks to the trainer directly from the browser: no daemon, no server in
the data path. The Python tools alongside it are a hardware lab, not a
dependency.

---

## Using it

Open the live app, press **Connect trainer**, pick the Hammer, press **Start
ride**. Or run it locally:

```sh
uv sync
uv run serve.py        # http://localhost:8756
```

Only one BLE connection to the trainer can exist at a time — quit Zwift, the
Saris app, and any Python tool from this repo before connecting.

### Workouts

A workout is an ordered list of **sets**, each `{intervals, repeat}`. A warm-up
is a one-interval set played once; a main block is a two-interval set played
seven times. Sets play in order, so warm-up / main / cool-down reads top to
bottom the way the ride happens.

Intervals are entered as watts and seconds. Edits **save themselves** — there is
no save gesture. Rename and delete are at the bottom of the workout panel.

Named workouts live at `/workout/<slug>`, so a ride can be bookmarked or wired
to an iOS Shortcut:

```
https://schlamory.github.io/bike-trainer-control/workout/sprints
https://schlamory.github.io/bike-trainer-control/workout/threshold-2x10
```

Four presets ship in `web/core/workouts.js` — `sprints`, `vo2-30-30`,
`threshold-2x10`, `recovery` — sized around a 250 W FTP. Editing a built-in
stores a copy at the same slug which shadows it, so **Delete becomes "Reset to
built-in"** and puts the original back.

Saved workouts live in `localStorage`, chosen over `sessionStorage` because that
is wiped when the tab closes. They are per-browser convenience, not durable
storage: clearing site data loses them, while presets are code and always
return.

FTP lives under Settings, not with the workout. It only colours intervals by
power zone and is never sent to the trainer.

### During and after a ride

The control loop ticks at 1 Hz, rewrites the current target every 10 s as a
keepalive, and confirms every target change two ways — the control-point
response *and* the `0x2ADA` status echo of the exact wattage — retrying up to
four times if either is missing. That is the workaround for the H3's
occasional refusal to change target.

If you leave the app mid-ride, the clock keeps **wall-clock** time rather than
pausing: it catches up in one step when you return, so a 30-second detour costs
30 seconds *of* the workout rather than adding 30 seconds *to* it. Intervals
spanned by the gap are skipped and never sent to the trainer, which holds its
last target until you come back. A gap over 3 seconds is reported in the
Activity log so this is visible rather than silent.

Chosen for predictability over completeness — see the decision log in
`FEEDBACK.md`.

When a ride ends, by finishing or by **End ride**, the trainer is set to the
lowest wattage the workout contained rather than left holding the last
interval. Finishing on a hard effort would otherwise leave full resistance on
for the spin-down. It stays in ERG at that easy target instead of stopping, so
resistance stays predictable while you keep pedalling.

---

## Architecture

Two seams, so the core knows about neither the browser nor the trainer:

```
  app.js            UI only: renders session events, turns clicks into intent
      │
  core/             ride loop and workout model — no DOM, no BLE, no FTMS
      │  ▲ TrainerController          equipment seam
  drivers/          speaks FTMS; knows nothing about the browser
      │  ▲ GattTransport              browser seam
  transport/        the only place navigator.bluetooth is touched
```

| Module | Responsibility |
| --- | --- |
| `core/contracts.js` | Both interfaces, as JSDoc types plus a runtime check |
| `core/workout.js` | Plan model: flattening sets, durations, power zones. Pure |
| `core/workouts.js` | Named workouts: presets, storage, slugs. Pure |
| `core/session.js` | The ride loop: clock, plan traversal, keepalives, settle |
| `drivers/ftms.js` | FTMS byte encode/decode. Pure |
| `drivers/ftms-ble.js` | FTMS over any transport: handshake, confirm-and-retry |
| `drivers/mock.js` | Simulated trainer at the controller seam |
| `transport/web-bluetooth.js` | `GattTransport` over Web Bluetooth |
| `transport/mock-gatt.js` | Simulated trainer at the byte level |

Swapping either seam is how an ANT+ FE-C bridge or a non-browser host would be
added without touching the workout logic.

`/workout/<slug>` needs no server: `404.html` bounces the request to the app,
which restores the pretty URL. `serve.py` does the same locally rather than
serving `index.html` in place — that shortcut breaks every relative asset,
since they would resolve against `/workout/`.

### Running without hardware

```
http://localhost:8756/?mock                  simulated trainer, quickest for UI work
http://localhost:8756/?mock=gatt             real FTMS driver over a fake radio
http://localhost:8756/?mock=gatt&stick=0.4   40% of targets stick, exercising retry
```

`?mock=gatt` is the one that matters for correctness: it runs the actual driver
— handshake, response parsing, confirm-and-retry — against a byte-level
emulation of the H3, quirks included. It is how the retry path was first proven
to work, since the real ERG-stick bug never reproduced on hardware.

`window.hammer` exposes `trainer`, `session` and `ui` in the console.

### On the phone

Open the live URL in Bluefy and bookmark it, or point an iOS Shortcut at a
`/workout/<slug>` address.

`diagnostics.html` reports what a given browser can actually do, and is worth
re-running after any Bluefy update:
<https://schlamory.github.io/bike-trainer-control/diagnostics.html>

Its **Display** section reports which `display-mode` matches, how much height
browser chrome is taking, and whether the manifest loaded with raster icons.

**Bluefy does not go borderless.** Measured on 3.9.3 / iOS 18.7 with a valid
manifest, `"display": "standalone"`, and PNG icons at 192/512 served: it still
reports `display-mode: browser` with ~210px of chrome. There is no page-side
lever either — iPhone WKWebView has no Fullscreen API. The manifest is worth
keeping correct for desktop install and for the home-screen icon, but full
screen on the phone is not currently achievable.

Instead the app runs **focus mode**: while a ride is in progress the header and
the workout panels are hidden, so the instrument fills whatever viewport Bluefy
leaves. The ☰ button in the corner brings them back without ending the ride.

To get an *unpushed* change onto the phone, tunnel the local server:

```sh
uv run serve.py --no-open                          # terminal 1
cloudflared tunnel --url http://localhost:8756     # terminal 2, prints an HTTPS URL
```

The tunnel URL rotates on restart and the page is public while it runs, so it
is for testing only. Pages is the address to bookmark.

---

## Hardware toolkit

Python tools for interrogating the trainer directly, independent of the app.

| Script | What it does |
| --- | --- |
| `scan.py` | Find FTMS advertisers |
| `probe.py` | Dump the GATT tree, read capabilities, test the handshake |
| `telemetry.py` | Measure what the trainer pushes, and how fast |
| `workout.py` | Run a structured workout, logging per-second CSV |
| `experiments/` | The scripts backing each claim in `FINDINGS.md` |

```sh
uv run scan.py                           # find the trainer
uv run probe.py                          # capability dump -> probe-report.json
uv run probe.py --no-handshake           # read-only, sends nothing
uv run telemetry.py -d 30                # notification rates for both power streams

uv run workout.py --steps "75w/60s, 230w/20s" --duration 10m
uv run workout.py --steps "100w/5m, 250w/1m" --duration 30m --log ride.csv

uv run experiments/decoder_selftest.py   # no hardware needed
uv run experiments/handshake_order.py    # why Reset breaks the handshake
uv run experiments/erg_targets.py        # ERG acceptance + status confirmations
```

`bike_trainer/` holds the protocol behind these: `ftms.py` and `cps.py` are pure
decoders over bytes, `control.py` is the ERG loop.

---

## Documents

- **`FINDINGS.md`** — what the hardware actually does, measured. Corrects the
  handshake order and the feature-bit table in the orientation doc, and records
  what Bluefy can do.
- **`FEEDBACK.md`** — running notes: next steps, open questions, decision log.
  Start here for what to do next.
- `saris-h3-workout-runner.md` — the original build orientation doc, kept as
  written. Read `FINDINGS.md` alongside it.
- `data/` — the ride log backing the ERG accuracy numbers in `FINDINGS.md`.
