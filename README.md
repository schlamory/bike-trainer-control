# bike-trainer-control

Tools for driving a Saris H3 over BLE FTMS.

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

- `web/ftms.js` — the protocol, ported from `bike_trainer/ftms.py`.
- `web/workout.js` — step parsing, plan building, power zones.
- `web/trainer.js` — connection and the confirm-and-retry ERG loop.
- `web/app.js` — UI and the 1 Hz ride loop.

`window.hammer` is exposed in the console for poking at state:
`hammer.simulate(65)` jumps the clock to 65 s in without a trainer attached.

Web Bluetooth needs a secure context, which `localhost` satisfies — no TLS
setup required. Only one BLE connection to the trainer can exist at a time, so
quit the Python tools before connecting the browser.

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
