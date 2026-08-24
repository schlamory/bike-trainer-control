#!/usr/bin/env python3
"""Run a structured ERG workout on the trainer and log every second.

    # 10 minutes of 75 W / 60 s alternating with 230 W / 20 s
    uv run workout.py --steps "75w/60s, 230w/20s" --duration 10m

    uv run workout.py --steps "100w/5m, 250w/1m" --duration 30m --log ride.csv
    uv run workout.py --steps "75w/60s, 230w/20s" --once      # one pass, no repeat

Step syntax is "<watts>w/<duration>", comma separated. Duration accepts
s/m/h suffixes or bare seconds. The pattern repeats until --duration is
reached (final step truncated to fit) unless --once is given.

Writes a per-second CSV and prints a per-interval summary at the end.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import csv
import re
import statistics
import sys
import time
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner

from bike_trainer import ftms as F
from bike_trainer.control import Sample, TrainerControl


@dataclass
class Step:
    watts: int
    seconds: float

    def __str__(self) -> str:
        return f"{self.watts}W/{fmt_dur(self.seconds)}"


def parse_duration(text: str) -> float:
    text = text.strip().lower()
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?", text)
    if not m:
        raise argparse.ArgumentTypeError(f"bad duration: {text!r}")
    v, unit = float(m.group(1)), (m.group(2) or "s")
    return v * {"s": 1, "sec": 1, "secs": 1, "m": 60, "min": 60, "mins": 60,
                "h": 3600, "hr": 3600, "hrs": 3600}[unit]


def fmt_dur(sec: float) -> str:
    sec = int(round(sec))
    return f"{sec//60}m{sec%60:02d}s" if sec >= 60 else f"{sec}s"


def parse_steps(text: str) -> list[Step]:
    steps = []
    for chunk in text.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        m = re.fullmatch(r"(\d+)\s*w?\s*[/@x:]\s*(.+)", chunk, re.I)
        if not m:
            raise argparse.ArgumentTypeError(
                f"bad step {chunk!r} -- expected e.g. '75w/60s'")
        steps.append(Step(int(m.group(1)), parse_duration(m.group(2))))
    if not steps:
        raise argparse.ArgumentTypeError("no steps given")
    return steps


def build_plan(steps: list[Step], total: float | None, once: bool) -> list[Step]:
    """Repeat the pattern until `total` seconds, truncating the final step."""
    if once or total is None:
        return list(steps)
    plan, elapsed, i = [], 0.0, 0
    while elapsed < total - 1e-9:
        s = steps[i % len(steps)]
        dur = min(s.seconds, total - elapsed)
        plan.append(Step(s.watts, dur))
        elapsed += dur
        i += 1
    return plan


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=parse_steps, default="75w/60s, 230w/20s",
                    help='e.g. "75w/60s, 230w/20s"')
    ap.add_argument("--duration", type=parse_duration, default=None,
                    help="total workout length, e.g. 10m")
    ap.add_argument("--once", action="store_true", help="run the pattern once")
    ap.add_argument("--log", default=None, help="CSV path (default: auto-named)")
    ap.add_argument("--scan-timeout", type=float, default=15.0)
    args = ap.parse_args()

    if isinstance(args.steps, str):
        args.steps = parse_steps(args.steps)
    if args.duration is None and not args.once:
        args.duration = sum(s.seconds for s in args.steps)

    plan = build_plan(args.steps, args.duration, args.once)
    total = sum(s.seconds for s in plan)
    log_path = args.log or f"ride-{time.strftime('%Y%m%d-%H%M%S')}.csv"

    print("=" * 66)
    print("WORKOUT")
    print("=" * 66)
    print(f"  pattern  : {', '.join(str(s) for s in args.steps)}")
    print(f"  total    : {fmt_dur(total)} across {len(plan)} intervals")
    print(f"  log      : {log_path}")
    print(f"  work     : {sum(s.watts*s.seconds for s in plan)/1000:.1f} kJ nominal")
    print("=" * 66 + "\n", flush=True)

    print(f"Scanning ({args.scan_timeout:.0f}s)...", flush=True)
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: F.FTMS_SERVICE in [u.lower() for u in a.service_uuids],
        timeout=args.scan_timeout)
    if dev is None:
        print("No FTMS device found. Is the trainer powered and awake?")
        return 1
    print(f"Found {dev.name}\n", flush=True)

    disconnected = asyncio.Event()
    samples: list[tuple[int, Sample]] = []
    interval_meta: list[dict] = []

    async with BleakClient(dev, timeout=30,
                           disconnected_callback=lambda _c: disconnected.set()) as client:
        c = TrainerControl(client)
        await c.subscribe()
        print("Handshake...", flush=True)
        await c.handshake()
        print("In control. Start pedalling.\n", flush=True)

        fh = open(log_path, "w", newline="")
        w = csv.writer(fh)
        w.writerow(["elapsed_s", "interval", "target_w", "actual_w",
                    "cadence_rpm", "speed_kph", "distance_m"])

        try:
            for idx, step in enumerate(plan):
                confirmed = await c.set_power(step.watts)
                start = c.t()
                interval_meta.append({"idx": idx, "watts": step.watts,
                                      "seconds": step.seconds, "start": start,
                                      "confirmed": confirmed})
                print(f"--- {idx+1}/{len(plan)}  {step.watts} W for "
                      f"{fmt_dur(step.seconds)}  [{fmt_dur(start)} elapsed]"
                      f"{'' if confirmed else '  (UNCONFIRMED)'}", flush=True)

                end = time.monotonic() + step.seconds
                last_ka = time.monotonic()
                while time.monotonic() < end:
                    await asyncio.sleep(1.0)
                    if disconnected.is_set():
                        raise ConnectionError("trainer disconnected")
                    s = c.sample()
                    samples.append((idx, s))
                    w.writerow([f"{s.t:.1f}", idx, s.target_w,
                                s.power_w if s.power_w is not None else "",
                                s.cadence_rpm if s.cadence_rpm is not None else "",
                                s.speed_kph if s.speed_kph is not None else "",
                                s.distance_m if s.distance_m is not None else ""])
                    fh.flush()
                    print(f"    [{s.t:6.1f}s] target={s.target_w:4d}W  "
                          f"actual={s.power_w if s.power_w is not None else '--':>4}W  "
                          f"cad={s.cadence_rpm if s.cadence_rpm is not None else '--':>5}rpm",
                          flush=True)
                    # keepalive rewrite, mid-interval, for steps long enough to need it
                    if step.seconds >= 20 and time.monotonic() - last_ka >= 10:
                        last_ka = time.monotonic()
                        await c.command(F.set_target_power(step.watts),
                                        F.OpCode.SET_TARGET_POWER)
        except (KeyboardInterrupt, asyncio.CancelledError):
            print("\n[interrupted]", flush=True)
        except ConnectionError as e:
            print(f"\n[{e}]", flush=True)
        finally:
            fh.close()
            print("\nReleasing trainer...", flush=True)
            with contextlib.suppress(Exception):
                await c.release()

    # --- summary ---
    print("\n" + "=" * 66)
    print("SUMMARY")
    print("=" * 66)
    print(f"  log written            : {log_path}")
    print(f"  intervals run          : {len(interval_meta)}/{len(plan)}")
    print(f"  targets confirmed      : {sum(m['confirmed'] for m in interval_meta)}"
          f"/{len(interval_meta)}")
    print(f"  retry / stick events   : {len(c.retries)}")
    for m in c.retries:
        print(f"      {m}")

    loaded = [(i, s) for i, s in samples if s.power_w]
    if not loaded:
        print("\n  No non-zero power recorded -- nobody pedalled.")
        return 0

    print(f"\n  samples under load     : {len(loaded)}/{len(samples)}")
    by_target: dict[int, list[int]] = {}
    for _i, s in loaded:
        by_target.setdefault(s.target_w, []).append(s.power_w)
    print(f"\n  {'target':>8} {'n':>5} {'mean':>8} {'median':>8} {'min':>6} {'max':>6}")
    for t in sorted(by_target):
        v = by_target[t]
        print(f"  {t:>7}W {len(v):>5} {statistics.mean(v):>8.1f} "
              f"{statistics.median(v):>8.1f} {min(v):>6} {max(v):>6}")

    # steady-state: drop the first 5s of each interval to exclude the ramp
    print(f"\n  steady state only (first 5 s of each interval excluded):")
    steady: dict[int, list[int]] = {}
    for i, s in loaded:
        if s.t - interval_meta[i]["start"] >= 5:
            steady.setdefault(s.target_w, []).append(s.power_w)
    print(f"  {'target':>8} {'n':>5} {'mean':>8} {'median':>8} {'error':>8}")
    for t in sorted(steady):
        v = steady[t]
        print(f"  {t:>7}W {len(v):>5} {statistics.mean(v):>8.1f} "
              f"{statistics.median(v):>8.1f} {statistics.mean(v)-t:>+8.1f}")

    cad = [s.cadence_rpm for _i, s in loaded if s.cadence_rpm]
    if cad:
        print(f"\n  cadence: median {statistics.median(cad):.0f} rpm "
              f"(range {min(cad):.0f}-{max(cad):.0f})")
    kj = sum(s.power_w for _i, s in loaded) / 1000
    print(f"  work done: {kj:.1f} kJ actual")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
