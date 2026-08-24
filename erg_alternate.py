#!/usr/bin/env python3
"""Alternate the ERG target between two wattages and verify every change.

    uv run erg_alternate.py                          # 50/100 W, 30 s, 6 intervals
    uv run erg_alternate.py --low 100 --high 300     # bigger jump
    uv run erg_alternate.py --period 30 --intervals 10

Each target change is confirmed two ways, per the ERG-stick workaround: the
control-point indication (0x2AD9) carrying Success, and a Target Power Changed
event on Fitness Machine Status (0x2ADA) echoing the exact watts. If either is
missing the write is retried, re-requesting control first.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import statistics
import time

from bleak import BleakClient, BleakScanner

from bike_trainer import ftms as F

RETRIES = 4
RETRY_DELAY = 0.5
CONFIRM_TIMEOUT = 1.0
KEEPALIVE = 10.0


class Session:
    def __init__(self, client: BleakClient) -> None:
        self.client = client
        self.t0 = time.monotonic()
        self.last_response: F.ControlResponse | None = None
        self.last_power_changed: int | None = None
        self.power_w: int | None = None
        self.cadence_rpm: float | None = None
        self.samples: list[tuple[float, int, int]] = []   # (t, target, actual)
        self.target: int | None = None
        self.stick_events: list[str] = []

    def t(self) -> float:
        return time.monotonic() - self.t0

    # --- notification handlers ---
    def on_control(self, _c, data: bytearray) -> None:
        resp = F.parse_control_response(bytes(data))
        if resp:
            self.last_response = resp

    def on_status(self, _c, data: bytearray) -> None:
        st = F.parse_machine_status(bytes(data))
        if st.opcode == F.STATUS_TARGET_POWER_CHANGED:
            self.last_power_changed = st.value

    def on_bike(self, _c, data: bytearray) -> None:
        d = F.parse_indoor_bike_data(bytes(data))
        if d.power_w is not None:
            self.power_w = d.power_w
        if d.cadence_rpm is not None:
            self.cadence_rpm = d.cadence_rpm
        if self.target is not None and d.power_w is not None:
            self.samples.append((self.t(), self.target, d.power_w))

    # --- control ---
    async def command(self, payload: bytes, expect_opcode: int) -> bool:
        self.last_response = None
        await self.client.write_gatt_char(F.CONTROL_POINT, payload, response=True)
        deadline = time.monotonic() + CONFIRM_TIMEOUT
        while time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            r = self.last_response
            if r and r.request_opcode == expect_opcode:
                return r.ok
        return False

    async def handshake(self) -> None:
        for name, payload in F.handshake_sequence():
            ok = await self.command(payload, payload[0])
            print(f"  {name:18s} {'OK' if ok else 'FAILED'}")
            if not ok:
                raise RuntimeError(f"handshake step failed: {name}")

    async def set_power(self, watts: int) -> bool:
        """Write a target and confirm it landed. Returns False if unconfirmed."""
        for attempt in range(1, RETRIES + 1):
            self.last_power_changed = None
            ok = await self.command(F.set_target_power(watts), F.OpCode.SET_TARGET_POWER)

            # wait a beat for the status echo, which lands ~10ms after the response
            deadline = time.monotonic() + CONFIRM_TIMEOUT
            while time.monotonic() < deadline and self.last_power_changed is None:
                await asyncio.sleep(0.05)

            echoed = self.last_power_changed
            if ok and echoed == watts:
                if attempt > 1:
                    print(f"  [{self.t():6.1f}s] confirmed on attempt {attempt}")
                self.target = watts
                return True

            why = (f"response={'ok' if ok else 'no/!ok'} "
                   f"status_echo={echoed if echoed is not None else 'silent'}")
            msg = f"[{self.t():6.1f}s] target {watts}W unconfirmed ({why}), retry {attempt}/{RETRIES}"
            print(f"  {msg}")
            self.stick_events.append(msg)
            await asyncio.sleep(RETRY_DELAY)
            # re-requesting control is idempotent and immunises against a lost grant
            await self.command(F.request_control(), F.OpCode.REQUEST_CONTROL)

        print(f"  [{self.t():6.1f}s] GAVE UP on {watts}W after {RETRIES} attempts")
        self.target = watts
        return False


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--low", type=int, default=50)
    ap.add_argument("--high", type=int, default=100)
    ap.add_argument("--period", type=float, default=30.0, help="seconds per interval")
    ap.add_argument("--intervals", type=int, default=6, help="how many to run")
    ap.add_argument("--timeout", type=float, default=15.0)
    args = ap.parse_args()

    total = args.period * args.intervals
    print(f"Alternating {args.low}W / {args.high}W every {args.period:.0f}s "
          f"for {args.intervals} intervals ({total/60:.1f} min).")
    print("Hop on and pedal -- ERG only bites under load.\n")

    print("Scanning...")
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: F.FTMS_SERVICE in [u.lower() for u in a.service_uuids],
        timeout=args.timeout)
    if dev is None:
        print("No FTMS device found. Is the trainer powered and awake?")
        return
    print(f"Found {dev.name}\n")

    async with BleakClient(dev, timeout=30) as client:
        s = Session(client)
        await client.start_notify(F.CONTROL_POINT, s.on_control)
        await client.start_notify(F.MACHINE_STATUS, s.on_status)
        await client.start_notify(F.INDOOR_BIKE_DATA, s.on_bike)

        print("Handshake:")
        await s.handshake()
        print()

        confirmed = 0
        try:
            for i in range(args.intervals):
                watts = args.low if i % 2 == 0 else args.high
                print(f"--- interval {i+1}/{args.intervals}: {watts} W ---")
                if await s.set_power(watts):
                    confirmed += 1

                # hold, ticking at 1 Hz with a periodic keepalive rewrite
                end = time.monotonic() + args.period
                last_ka = time.monotonic()
                while time.monotonic() < end:
                    await asyncio.sleep(1.0)
                    print(f"  [{s.t():6.1f}s] target={watts:4d} W   "
                          f"actual={s.power_w if s.power_w is not None else '--':>4} W   "
                          f"cadence={s.cadence_rpm if s.cadence_rpm is not None else '--':>5} rpm")
                    if time.monotonic() - last_ka >= KEEPALIVE:
                        last_ka = time.monotonic()
                        await s.command(F.set_target_power(watts),
                                        F.OpCode.SET_TARGET_POWER)
        except KeyboardInterrupt:
            print("\ninterrupted")
        finally:
            print("\nReleasing trainer...")
            with contextlib.suppress(Exception):
                await s.command(F.stop(), F.OpCode.STOP_PAUSE)
            for u in (F.CONTROL_POINT, F.MACHINE_STATUS, F.INDOOR_BIKE_DATA):
                with contextlib.suppress(Exception):
                    await client.stop_notify(u)

        # --- summary ---
        print("\n" + "=" * 60)
        print("SUMMARY")
        print("=" * 60)
        print(f"  target changes confirmed : {confirmed}/{args.intervals}")
        print(f"  retry / stick events     : {len(s.stick_events)}")
        for m in s.stick_events:
            print(f"      {m}")

        pedalled = [x for x in s.samples if x[2] > 0]
        if not pedalled:
            print("\n  No non-zero power was ever reported -- nobody pedalled, so this run\n"
                  "  proves the commands were accepted but says nothing about ERG holding.")
            return

        print(f"\n  power samples with load  : {len(pedalled)}/{len(s.samples)}")
        by_target: dict[int, list[int]] = {}
        for _t, tgt, act in pedalled:
            by_target.setdefault(tgt, []).append(act)
        print(f"\n  {'target':>8} {'n':>5} {'mean':>8} {'median':>8} {'min':>6} {'max':>6}")
        for tgt in sorted(by_target):
            v = by_target[tgt]
            print(f"  {tgt:>7}W {len(v):>5} {statistics.mean(v):>8.1f} "
                  f"{statistics.median(v):>8.1f} {min(v):>6} {max(v):>6}")


if __name__ == "__main__":
    asyncio.run(main())
