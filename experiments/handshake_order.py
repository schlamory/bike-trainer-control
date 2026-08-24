"""Does Reset (0x01) revoke the control grant from Request Control (0x00)?"""
import asyncio, sys
from bleak import BleakClient, BleakScanner
from bike_trainer import ftms as F

async def run(client, label, steps):
    print(f"\n--- {label} ---")
    got = []
    def on_ctl(_c, data):
        r = F.parse_control_response(bytes(data))
        got.append(r)
        print(f"    <- {bytes(data).hex(' ')}  {r}")
    await client.start_notify(F.CONTROL_POINT, on_ctl)
    for name, payload in steps:
        print(f"  -> {name:26s} {payload.hex(' ')}")
        n = len(got)
        await client.write_gatt_char(F.CONTROL_POINT, payload, response=True)
        for _ in range(20):
            await asyncio.sleep(0.1)
            if len(got) > n: break
        else:
            print("    (silence)")
    await client.stop_notify(F.CONTROL_POINT)
    return got

async def main():
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: F.FTMS_SERVICE in [u.lower() for u in a.service_uuids], timeout=15)
    if not dev: sys.exit("no trainer")
    async with BleakClient(dev, timeout=30) as c:
        print(f"connected to {dev.name}")

        await run(c, "A: Request Control -> Start (no Reset)", [
            ("Request Control", F.request_control()),
            ("Start / Resume",  F.start_resume()),
        ])

        await run(c, "B: Reset, then Start without re-requesting", [
            ("Reset",           F.reset()),
            ("Start / Resume",  F.start_resume()),
        ])

        await run(c, "C: Reset -> Request Control -> Start", [
            ("Reset",           F.reset()),
            ("Request Control", F.request_control()),
            ("Start / Resume",  F.start_resume()),
        ])

        await run(c, "D: does a second Request Control while in control succeed?", [
            ("Request Control", F.request_control()),
        ])

asyncio.run(main())
