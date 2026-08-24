# bike-trainer-control

Tools for driving a Saris H3 over BLE FTMS.

**Live app: https://schlamory.github.io/bike-trainer-control/**

Open it in Chrome or Edge on the desktop, or Bluefy on iOS. Safari has no Web
Bluetooth and never will. Deploys automatically on any push to `main` that
touches `web/`.

- `saris-h3-workout-runner.md` — the original build orientation doc.
- `FEEDBACK.md` — running notes: next steps, open questions, decision log.
  Start here for what to do next.
- `FINDINGS.md` — what the hardware actually does, measured. **Read this second;
  it corrects the handshake order and the feature-bit table in the doc above.**
- `bike_trainer/ftms.py` — FTMS protocol constants and decoders. Pure functions
  over bytes, no I/O.
- `bike_trainer/cps.py` — Cycling Power Service decoder (torque, wheel/crank
  revolutions, accumulated energy).
- `bike_trainer/control.py` — the ERG control loop: handshake, confirm-and-retry
  on every target, keepalive rewrites, disconnect detection.
- `workout.py` — run a structured interval workout, log per-second CSV.
- `scan.py` — find FTMS advertisers.
- `probe.py` — connect, dump the GATT tree, read capabilities, test the handshake.
- `telemetry.py` — measure what the trainer pushes and how fast.
- `experiments/` — the scripts backing each claim in FINDINGS.md.

## Web app

A PWA that drives the trainer directly over Web Bluetooth — no daemon, no
server in the data path. Runs in Chrome or Edge on the desktop today; the same
code is what would run on an iPhone under Bluefy, once the indication question
in FINDINGS.md is answered.

```sh
uv run serve.py            # http://localhost:8756, opens a browser
```

Press **Connect trainer**, pick the Hammer, then **Start ride**. Workout syntax
matches `workout.py`: `75w/60s, 230w/20s` with a total time, and the pattern
repeats to fill it.

### Architecture

Two seams, so the core knows about neither the browser nor the trainer:

```
  app.js            UI only: renders session events, turns clicks into intent
      │
  core/             the ride loop and workout model — no DOM, no BLE, no FTMS
      │  ▲ TrainerController          equipment seam
  drivers/          speaks FTMS; knows nothing about the browser
      │  ▲ GattTransport              browser seam
  transport/        the only place navigator.bluetooth is touched
```

| Module | Responsibility |
| --- | --- |
| `core/contracts.js` | Both interfaces, as JSDoc types plus a runtime check |
| `core/workout.js` | Step parsing, plan building, power zones. Pure |
| `core/session.js` | The ride loop: clock, plan traversal, keepalives. Pure |
| `drivers/ftms.js` | FTMS byte encode/decode. Pure |
| `drivers/ftms-ble.js` | FTMS over any transport: handshake, confirm-and-retry |
| `drivers/mock.js` | Simulated trainer at the controller seam |
| `transport/web-bluetooth.js` | `GattTransport` over Web Bluetooth |
| `transport/mock-gatt.js` | Simulated trainer at the byte level |

Swapping either seam is why an ANT+ FE-C bridge or a non-browser host could be
added without touching the workout logic.

### Running without hardware

```
http://localhost:8756/?mock                  simulated trainer, quickest for UI work
http://localhost:8756/?mock=gatt             real FTMS driver over a fake radio
http://localhost:8756/?mock=gatt&stick=0.4   40% of targets stick, exercising retry
```

`?mock=gatt` is the useful one for correctness: it runs the actual driver —
handshake, response parsing, confirm-and-retry — against a byte-level emulation
of the H3, including its quirk that Reset revokes control. It is how the retry
path was first proven to work, since the real ERG-stick bug never reproduced.

`window.hammer` exposes `trainer`, `session` and `ui` in the console.

Web Bluetooth needs a secure context, which `localhost` satisfies — no TLS
setup required. Only one BLE connection to the trainer can exist at a time, so
quit the Python tools before connecting the browser.

### On the phone

Just open <https://schlamory.github.io/bike-trainer-control/> in Bluefy and
bookmark it. iOS needs Bluefy or BLE Link — Safari has no Web Bluetooth.

`web/diagnostics.html` reports what a given browser can actually do, and is
worth re-running after any Bluefy update:
<https://schlamory.github.io/bike-trainer-control/diagnostics.html>

To test an unpushed change on the phone, tunnel the local server instead:

```sh
uv run serve.py --no-open                          # terminal 1
cloudflared tunnel --url http://localhost:8756     # terminal 2, prints an HTTPS URL
```

The tunnel URL rotates on restart and the page is public while it runs, so it
is for testing only — Pages is the address to bookmark.

## Usage

```sh
uv sync
uv run scan.py                 # find the trainer
uv run probe.py                # full capability dump -> probe-report.json
uv run probe.py --no-handshake # read-only, sends nothing

# structured workouts -- pattern repeats until --duration, last step truncated
uv run workout.py --steps "75w/60s, 230w/20s" --duration 10m
uv run workout.py --steps "100w/5m, 250w/1m" --duration 30m --log ride.csv
uv run workout.py --steps "75w/60s, 230w/20s" --once

uv run telemetry.py -d 30      # notification rates for both power streams

uv run experiments/decoder_selftest.py   # no hardware needed
uv run experiments/handshake_order.py    # why Reset breaks the handshake
uv run experiments/erg_targets.py        # ERG acceptance + status confirmations
```

The trainer accepts exactly one BLE connection — quit Zwift, the Saris app and
anything else holding it before running these.
