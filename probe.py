#!/usr/bin/env python3
"""Connect to the trainer, dump its GATT tree, and test the FTMS handshake.

    uv run probe.py                 # read-only dump + handshake (no resistance change)
    uv run probe.py --no-handshake  # pure read-only, sends nothing
    uv run probe.py --watts 150     # also set an ERG target (CHANGES RESISTANCE)

Writes a JSON report to probe-report.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

from bleak import BleakClient, BleakScanner

from bike_trainer import ftms as F

DEVICE_INFO = {
    F.uuid16(0x2A29): "manufacturer",
    F.uuid16(0x2A24): "model",
    F.uuid16(0x2A25): "serial",
    F.uuid16(0x2A26): "firmware",
    F.uuid16(0x2A27): "hardware",
    F.uuid16(0x2A28): "software",
}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-t", "--timeout", type=float, default=15.0)
    ap.add_argument("--no-handshake", action="store_true")
    ap.add_argument("--watts", type=int, help="set an ERG target after the handshake")
    ap.add_argument("--listen", type=float, default=8.0, help="seconds of telemetry")
    args = ap.parse_args()

    report: dict = {"scanned_at": time.strftime("%Y-%m-%d %H:%M:%S")}

    print(f"Scanning for an FTMS device ({args.timeout:.0f}s)...")
    device = await BleakScanner.find_device_by_filter(
        lambda d, adv: F.FTMS_SERVICE in [u.lower() for u in adv.service_uuids],
        timeout=args.timeout,
    )
    if device is None:
        print("No FTMS device found. Is the trainer powered and awake?")
        return

    print(f"Found {device.name} ({device.address})\nConnecting...\n")
    report["device"] = {"name": device.name, "address": device.address}

    control_responses: list[F.ControlResponse] = []
    status_events: list[F.MachineStatus] = []
    telemetry: list[F.BikeData] = []

    def on_control(_c, data: bytearray) -> None:
        raw = bytes(data)
        resp = F.parse_control_response(raw)
        if resp:
            control_responses.append(resp)
            print(f"    <- INDICATION  {raw.hex(' ')}   {resp}")
        else:
            print(f"    <- INDICATION  {raw.hex(' ')}   (unparsed)")

    def on_status(_c, data: bytearray) -> None:
        st = F.parse_machine_status(bytes(data))
        status_events.append(st)
        print(f"    <- STATUS      {bytes(data).hex(' ')}   {st}")

    def on_bike(_c, data: bytearray) -> None:
        telemetry.append(F.parse_indoor_bike_data(bytes(data)))

    async with BleakClient(device, timeout=30) as client:
        print(f"Connected: {client.is_connected}\n")

        # --- 1. GATT tree ---------------------------------------------------
        print("=" * 68)
        print("GATT SERVICES AND CHARACTERISTICS")
        print("=" * 68)
        services = []
        for svc in client.services:
            print(f"\nService {svc.uuid}  {svc.description}")
            chars = []
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                label = F.CHARACTERISTIC_NAMES.get(ch.uuid.lower(), ch.description)
                print(f"  {ch.uuid}  [{props}]")
                print(f"      {label}")
                chars.append({"uuid": ch.uuid, "properties": list(ch.properties),
                              "description": label})
                for d in ch.descriptors:
                    print(f"        descriptor {d.uuid} (handle {d.handle})")
            services.append({"uuid": svc.uuid, "description": svc.description,
                             "characteristics": chars})
        report["services"] = services

        # --- 2. Device information -----------------------------------------
        print("\n" + "=" * 68)
        print("DEVICE INFORMATION")
        print("=" * 68)
        info = {}
        for uuid, key in DEVICE_INFO.items():
            try:
                val = (await client.read_gatt_char(uuid)).decode("utf-8", "replace").strip("\x00")
                info[key] = val
                print(f"  {key:14s}: {val}")
            except Exception:
                pass
        report["device_info"] = info

        # --- 3. Capabilities ------------------------------------------------
        print("\n" + "=" * 68)
        print("FITNESS MACHINE FEATURE (0x2ACC)")
        print("=" * 68)
        try:
            raw = bytes(await client.read_gatt_char(F.MACHINE_FEATURE))
            print(f"  raw: {raw.hex(' ')}")
            feat = F.parse_machine_feature(raw)
            print(f"  machine word: 0x{feat.machine_word:08x}")
            for n in feat.machine:
                print(f"      + {n}")
            print(f"  target  word: 0x{feat.target_word:08x}")
            for n in feat.targets:
                print(f"      + {n}")
            print("\n  Opcode support:")
            for op, name in [(0x04, "Set Target Resistance"), (0x05, "Set Target Power"),
                             (0x11, "Indoor Bike Simulation"), (0x13, "Spin Down Control")]:
                mark = "YES" if feat.supports_opcode(op) else "no "
                print(f"      0x{op:02x} {name:26s} {mark}")
            report["feature"] = {"raw": raw.hex(" "), "machine_word": feat.machine_word,
                                 "target_word": feat.target_word,
                                 "machine": feat.machine, "targets": feat.targets}
        except Exception as e:
            print(f"  read failed: {e}")

        for uuid, label, parser in [
            (F.SUPPORTED_POWER_RANGE, "SUPPORTED POWER RANGE (0x2AD8)", F.parse_power_range),
        ]:
            print("\n" + "=" * 68)
            print(label)
            print("=" * 68)
            try:
                raw = bytes(await client.read_gatt_char(uuid))
                parsed = parser(raw)
                print(f"  raw: {raw.hex(' ')}")
                print(f"  {parsed}")
                report["power_range"] = parsed
            except Exception as e:
                print(f"  read failed: {e}")

        # --- 4. Subscriptions -----------------------------------------------
        print("\n" + "=" * 68)
        print("SUBSCRIBING")
        print("=" * 68)
        indicate_ok = False
        try:
            await client.start_notify(F.CONTROL_POINT, on_control)
            print("  control point 0x2AD9 subscribed (indicate)")
            indicate_ok = True
        except Exception as e:
            print(f"  control point subscribe FAILED: {e}")
        for uuid, name in [(F.MACHINE_STATUS, "machine status 0x2ADA"),
                           (F.INDOOR_BIKE_DATA, "indoor bike data 0x2AD2")]:
            try:
                await client.start_notify(uuid, on_status if uuid == F.MACHINE_STATUS else on_bike)
                print(f"  {name} subscribed")
            except Exception as e:
                print(f"  {name} subscribe FAILED: {e}")
        report["control_point_subscribed"] = indicate_ok

        # --- 5. Handshake ----------------------------------------------------
        if not args.no_handshake:
            print("\n" + "=" * 68)
            print("FTMS HANDSHAKE")
            print("=" * 68)
            steps = [("Request Control", F.request_control()),
                     ("Reset", F.reset()),
                     ("Start / Resume", F.start_resume())]
            if args.watts:
                steps.append((f"Set Target Power {args.watts} W",
                              F.set_target_power(args.watts)))
            for name, payload in steps:
                print(f"\n  -> {name:28s} {payload.hex(' ')}")
                before = len(control_responses)
                try:
                    await client.write_gatt_char(F.CONTROL_POINT, payload, response=True)
                except Exception as e:
                    print(f"    write FAILED: {e}")
                    continue
                for _ in range(20):          # wait up to 2s for the indication
                    await asyncio.sleep(0.1)
                    if len(control_responses) > before:
                        break
                else:
                    print("    (no indication within 2s)")

            report["handshake"] = [
                {"request_opcode": r.request_opcode, "result": r.result,
                 "text": str(r), "raw": r.raw.hex(" ")} for r in control_responses]

        # --- 6. Telemetry ----------------------------------------------------
        print("\n" + "=" * 68)
        print(f"TELEMETRY -- listening {args.listen:.0f}s (pedal to see numbers)")
        print("=" * 68)
        seen = 0
        deadline = time.time() + args.listen
        while time.time() < deadline:
            await asyncio.sleep(0.5)
            if len(telemetry) > seen:
                d = telemetry[-1]
                seen = len(telemetry)
                print(f"  power={d.power_w!s:>5} W  cadence={d.cadence_rpm!s:>5} rpm  "
                      f"speed={d.speed_kph!s:>6} kph  raw={d.raw.hex(' ')}")
        if not telemetry:
            print("  no telemetry frames received")
        report["telemetry_frames"] = len(telemetry)
        if telemetry:
            report["telemetry_sample"] = telemetry[-1].raw.hex(" ")
            report["telemetry_flags"] = int.from_bytes(telemetry[-1].raw[:2], "little")

        report["status_events"] = [{"text": str(s), "raw": s.raw.hex(" ")}
                                   for s in status_events]

        for uuid in (F.CONTROL_POINT, F.MACHINE_STATUS, F.INDOOR_BIKE_DATA):
            try:
                await client.stop_notify(uuid)
            except Exception:
                pass

    with open("probe-report.json", "w") as fh:
        json.dump(report, fh, indent=2)
    print("\nWrote probe-report.json")


if __name__ == "__main__":
    asyncio.run(main())
