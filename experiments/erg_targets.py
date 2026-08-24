"""Do ERG targets get accepted, and does 0x2ADA confirm them?"""
import asyncio, sys, time
from bleak import BleakClient, BleakScanner
from bike_trainer import ftms as F

async def main():
    dev = await BleakScanner.find_device_by_filter(
        lambda d, a: F.FTMS_SERVICE in [u.lower() for u in a.service_uuids], timeout=15)
    if not dev: sys.exit("no trainer")
    async with BleakClient(dev, timeout=30) as c:
        print(f"connected to {dev.name}\n")
        t0 = time.time()
        def stamp(): return f"[{time.time()-t0:6.2f}s]"

        def on_ctl(_c, d):
            print(f"  {stamp()} <- CTRL   {bytes(d).hex(' ')}  {F.parse_control_response(bytes(d))}")
        def on_st(_c, d):
            print(f"  {stamp()} <- STATUS {bytes(d).hex(' ')}  {F.parse_machine_status(bytes(d))}")

        await c.start_notify(F.CONTROL_POINT, on_ctl)
        await c.start_notify(F.MACHINE_STATUS, on_st)

        async def send(name, payload):
            print(f"  {stamp()} -> {name:24s} {payload.hex(' ')}")
            await c.write_gatt_char(F.CONTROL_POINT, payload, response=True)
            await asyncio.sleep(1.2)

        print("--- handshake (corrected order) ---")
        await send("Request Control", F.request_control())
        await send("Start / Resume", F.start_resume())

        print("\n--- ERG targets, including a big jump ---")
        for w in (100, 150, 300, 100, 300):
            await send(f"Set Target Power {w}W", F.set_target_power(w))

        print("\n--- edge cases ---")
        await send("Set Target Power 0W", F.set_target_power(0))
        await send("Set Target Power 4000W", F.set_target_power(4000))   # above the 3000 max
        await send("Set Target Resistance 5", bytes([0x04, 0x05]))
        await send("Simulation grade 3.0%", F.set_simulation(grade_pct=3.0))

        print("\n--- release ---")
        await send("Stop", F.stop())
        await asyncio.sleep(1)

asyncio.run(main())
