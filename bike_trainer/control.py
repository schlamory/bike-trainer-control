"""Reusable ERG control loop with confirm-and-retry.

Every target write is confirmed two ways -- the control-point indication
carrying Success, and a Target Power Changed event on Fitness Machine Status
echoing the exact watts -- because the H1/H2/H3 are known to occasionally
ignore a target change and hold the previous wattage.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field

from bleak import BleakClient

from . import ftms as F

RETRIES = 4
RETRY_DELAY = 0.5
CONFIRM_TIMEOUT = 1.0


@dataclass
class Sample:
    t: float
    target_w: int
    power_w: int | None
    cadence_rpm: float | None
    speed_kph: float | None
    distance_m: int | None


@dataclass
class TrainerControl:
    client: BleakClient
    t0: float = field(default_factory=time.monotonic)
    last_response: F.ControlResponse | None = None
    last_power_changed: int | None = None
    power_w: int | None = None
    cadence_rpm: float | None = None
    speed_kph: float | None = None
    distance_m: int | None = None
    target: int | None = None
    retries: list[str] = field(default_factory=list)

    def t(self) -> float:
        return time.monotonic() - self.t0

    # --- notification handlers ---
    def on_control(self, _c, data: bytearray) -> None:
        r = F.parse_control_response(bytes(data))
        if r:
            self.last_response = r

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
        if d.speed_kph is not None:
            self.speed_kph = d.speed_kph
        if d.distance_m is not None:
            self.distance_m = d.distance_m

    def sample(self) -> Sample:
        return Sample(self.t(), self.target or 0, self.power_w,
                      self.cadence_rpm, self.speed_kph, self.distance_m)

    # --- control ---
    async def subscribe(self) -> None:
        await self.client.start_notify(F.CONTROL_POINT, self.on_control)
        await self.client.start_notify(F.MACHINE_STATUS, self.on_status)
        await self.client.start_notify(F.INDOOR_BIKE_DATA, self.on_bike)

    async def unsubscribe(self) -> None:
        for u in (F.CONTROL_POINT, F.MACHINE_STATUS, F.INDOOR_BIKE_DATA):
            try:
                await self.client.stop_notify(u)
            except Exception:
                pass

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
            if not await self.command(payload, payload[0]):
                raise RuntimeError(f"handshake step failed: {name}")

    async def set_power(self, watts: int, *, quiet: bool = False) -> bool:
        """Write a target and confirm it landed; retry if not."""
        for attempt in range(1, RETRIES + 1):
            self.last_power_changed = None
            ok = await self.command(F.set_target_power(watts), F.OpCode.SET_TARGET_POWER)
            deadline = time.monotonic() + CONFIRM_TIMEOUT
            while time.monotonic() < deadline and self.last_power_changed is None:
                await asyncio.sleep(0.05)
            if ok and self.last_power_changed == watts:
                self.target = watts
                return True
            msg = (f"[{self.t():7.1f}s] {watts}W unconfirmed "
                   f"(response={'ok' if ok else 'no'}, "
                   f"echo={self.last_power_changed if self.last_power_changed is not None else 'silent'}) "
                   f"retry {attempt}/{RETRIES}")
            self.retries.append(msg)
            if not quiet:
                print("  ! " + msg, flush=True)
            await asyncio.sleep(RETRY_DELAY)
            # idempotent, and immunises against a silently lost control grant
            await self.command(F.request_control(), F.OpCode.REQUEST_CONTROL)
        self.target = watts
        return False

    async def release(self) -> None:
        try:
            await self.command(F.stop(), F.OpCode.STOP_PAUSE)
        except Exception:
            pass
        await self.unsubscribe()
