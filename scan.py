#!/usr/bin/env python3
"""Scan for BLE devices and flag anything speaking FTMS.

    uv run scan.py            # 10s scan, show FTMS devices
    uv run scan.py --all      # show every advertiser
    uv run scan.py -t 30      # longer scan
"""

from __future__ import annotations

import argparse
import asyncio

from bleak import BleakScanner

from bike_trainer.ftms import CYCLEOPS_SERVICE, FTMS_SERVICE

KNOWN_SERVICES = {
    "00001826-0000-1000-8000-00805f9b34fb": "Fitness Machine (FTMS)",
    "00001818-0000-1000-8000-00805f9b34fb": "Cycling Power",
    "00001816-0000-1000-8000-00805f9b34fb": "Cycling Speed and Cadence",
    "0000180d-0000-1000-8000-00805f9b34fb": "Heart Rate",
    "0000180a-0000-1000-8000-00805f9b34fb": "Device Information",
    "0000180f-0000-1000-8000-00805f9b34fb": "Battery",
    CYCLEOPS_SERVICE: "CycleOps/Saris proprietary",
}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-t", "--timeout", type=float, default=10.0)
    ap.add_argument("--all", action="store_true", help="show non-FTMS devices too")
    args = ap.parse_args()

    print(f"Scanning {args.timeout:.0f}s ...  (make sure the trainer is awake -- "
          "give the cranks a turn)\n")
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)

    trainers, others = [], []
    for address, (device, adv) in found.items():
        uuids = [u.lower() for u in adv.service_uuids]
        (trainers if FTMS_SERVICE in uuids else others).append((address, device, adv))

    def show(address, device, adv) -> None:
        name = adv.local_name or device.name or "(no name)"
        print(f"  {name}")
        print(f"    address : {address}")
        print(f"    rssi    : {adv.rssi} dBm")
        for u in adv.service_uuids:
            label = KNOWN_SERVICES.get(u.lower(), "")
            print(f"    service : {u}" + (f"  <- {label}" if label else ""))
        for cid, val in adv.manufacturer_data.items():
            print(f"    mfr 0x{cid:04x}: {val.hex(' ')}")
        if adv.service_data:
            for u, val in adv.service_data.items():
                print(f"    svc data {u}: {val.hex(' ')}")
        print()

    print(f"=== FTMS devices ({len(trainers)}) ===\n")
    for t in trainers:
        show(*t)
    if not trainers:
        print("  none found\n")

    if args.all:
        print(f"=== other advertisers ({len(others)}) ===\n")
        for o in sorted(others, key=lambda x: -x[2].rssi):
            show(*o)
    else:
        print(f"({len(others)} other advertisers hidden; pass --all to see them)")


if __name__ == "__main__":
    asyncio.run(main())
