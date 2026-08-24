#!/usr/bin/env python3
"""Measure what the trainer pushes, and how often.

    uv run telemetry.py                 # 30 s, both power streams
    uv run telemetry.py -d 60 --show    # longer, print every frame

Subscribes to Indoor Bike Data (FTMS) and Cycling Power Measurement (CPS),
timestamps every notification, and reports the inter-arrival distribution.
Neither characteristic is readable, so this is push-only -- there is nothing
to poll.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import statistics
import time

from bleak import BleakClient, BleakScanner

from bike_trainer import cps, ftms as F


def dist(name: str, stamps: list[float]) -> None:
    if len(stamps) < 3:
        print(f"  {name}: {len(stamps)} frames -- too few to characterise")
        return
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    mean = statistics.mean(gaps)
    print(f"  {name}")
    print(f"      frames      : {len(stamps)} over {stamps[-1]-stamps[0]:.1f}s")
    print(f"      rate        : {1/mean:.2f} Hz")
    print(f"      interval    : mean {mean*1000:.0f} ms | median {statistics.median(gaps)*1000:.0f} ms")
    print(f"      jitter      : stdev {statistics.pstdev(gaps)*1000:.0f} ms | "
          f"min {min(gaps)*1000:.0f} ms | max {max(gaps)*1000:.0f} ms")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-d", "--duration", type=float, default=30.0)
    ap.add_argument("--show", action="store_true", help="print every frame")
    args = ap.parse_args()

    print("Scanning...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: F.FTMS_SERVICE in [u.lower() for u in a.service_uuids], timeout=15)
    if dev is None:
        print("No FTMS device found.")
        return
    print(f"Found {dev.name}\n")

    ibd_t: list[float] = []
    cps_t: list[float] = []
    ibd_frames: list[F.BikeData] = []
    cps_frames: list[cps.PowerMeasurement] = []
    t0 = time.monotonic()

    def on_ibd(_c, data: bytearray) -> None:
        ibd_t.append(time.monotonic())
        d = F.parse_indoor_bike_data(bytes(data))
        ibd_frames.append(d)
        if args.show:
            print(f"  [{ibd_t[-1]-t0:6.2f}s] IBD  {bytes(data).hex(' ')}  "
                  f"power={d.power_w} cad={d.cadence_rpm} spd={d.speed_kph}")

    def on_cps(_c, data: bytearray) -> None:
        cps_t.append(time.monotonic())
        m = cps.parse_power_measurement(bytes(data))
        cps_frames.append(m)
        if args.show:
            print(f"  [{cps_t[-1]-t0:6.2f}s] CPS  {bytes(data).hex(' ')}  "
                  f"power={m.power_w} crank_revs={m.crank_revs}")

    async with BleakClient(dev, timeout=30) as client:
        # --- static capability reads ---
        print("=" * 62)
        print("CYCLING POWER SERVICE capability")
        print("=" * 62)
        try:
            raw = bytes(await client.read_gatt_char(cps.POWER_FEATURE))
            feat = int.from_bytes(raw[:4], "little")
            print(f"  feature raw : {raw.hex(' ')}  (0x{feat:08x})")
            for n in cps.decode_flags(feat, cps.FEATURE_FLAGS):
                print(f"      + {n}")
            loc = (await client.read_gatt_char(cps.SENSOR_LOCATION))[0]
            print(f"  sensor location: {cps.SENSOR_LOCATIONS.get(loc, loc)}")
        except Exception as e:
            print(f"  read failed: {e}")

        try:
            ts = bytes(await client.read_gatt_char(F.TRAINING_STATUS))
            print(f"\n  Training Status (0x2AD3) readable: {ts.hex(' ')}")
        except Exception as e:
            print(f"\n  Training Status read failed: {e}")

        # is Indoor Bike Data readable? (properties say no -- prove it)
        try:
            await client.read_gatt_char(F.INDOOR_BIKE_DATA)
            print("  Indoor Bike Data IS readable (unexpected)")
        except Exception as e:
            print(f"  Indoor Bike Data not readable, as expected: {type(e).__name__}")

        print(f"\n{'='*62}\nLISTENING {args.duration:.0f}s -- pedal for loaded numbers\n{'='*62}")
        await client.start_notify(F.INDOOR_BIKE_DATA, on_ibd)
        await client.start_notify(cps.POWER_MEASUREMENT, on_cps)
        await asyncio.sleep(args.duration)
        for u in (F.INDOOR_BIKE_DATA, cps.POWER_MEASUREMENT):
            with contextlib.suppress(Exception):
                await client.stop_notify(u)

    print("\n" + "=" * 62)
    print("NOTIFICATION RATES")
    print("=" * 62)
    dist("Indoor Bike Data (0x2AD2, FTMS)", ibd_t)
    print()
    dist("Cycling Power Measurement (0x2A63, CPS)", cps_t)

    if ibd_frames:
        f = ibd_frames[-1]
        flags = int.from_bytes(f.raw[:2], "little")
        print(f"\n  IBD flags 0x{flags:04x}, {len(f.raw)}-byte frame, fields present:")
        for label, val in [("speed", f.speed_kph), ("cadence", f.cadence_rpm),
                           ("distance", f.distance_m), ("resistance", f.resistance),
                           ("power", f.power_w), ("heart rate", f.heart_rate_bpm),
                           ("elapsed", f.elapsed_s)]:
            if val is not None:
                print(f"      {label:12s} = {val}")

    if cps_frames:
        m = cps_frames[-1]
        cflags = int.from_bytes(m.raw[:2], "little")
        print(f"\n  CPS flags 0x{cflags:04x}, {len(m.raw)}-byte frame:")
        for n in cps.decode_flags(cflags, cps.MEASUREMENT_FLAGS):
            print(f"      + {n}")
        rpms = [r for r in (cps.cadence_from_crank(a, b)
                            for a, b in zip(cps_frames, cps_frames[1:])) if r]
        if rpms:
            print(f"      cadence from crank counters: "
                  f"{statistics.median(rpms):.1f} rpm median over {len(rpms)} deltas")

    # do the two streams agree on power?
    if ibd_frames and cps_frames:
        ip = [f.power_w for f in ibd_frames if f.power_w is not None]
        cp = [m.power_w for m in cps_frames]
        if any(ip) or any(cp):
            print(f"\n  power agreement: IBD median {statistics.median(ip)} W | "
                  f"CPS median {statistics.median(cp)} W")


if __name__ == "__main__":
    asyncio.run(main())
