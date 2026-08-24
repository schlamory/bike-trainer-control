"""Cycling Power Service (0x1818) decoding.

The H3 exposes this alongside FTMS. It carries instantaneous power like
Indoor Bike Data does, but adds crank revolution counters, which give you a
cadence you compute yourself from event deltas rather than one the trainer
rounds to 0.5 rpm.
"""

from __future__ import annotations

from dataclasses import dataclass

CPS_SERVICE = "00001818-0000-1000-8000-00805f9b34fb"
POWER_MEASUREMENT = "00002a63-0000-1000-8000-00805f9b34fb"   # notify
POWER_FEATURE = "00002a65-0000-1000-8000-00805f9b34fb"       # read
SENSOR_LOCATION = "00002a5d-0000-1000-8000-00805f9b34fb"     # read

MEASUREMENT_FLAGS = {
    0: "Pedal Power Balance",
    1: "Pedal Power Balance Reference",
    2: "Accumulated Torque",
    3: "Accumulated Torque Source",
    4: "Wheel Revolution Data",
    5: "Crank Revolution Data",
    6: "Extreme Force Magnitudes",
    7: "Extreme Torque Magnitudes",
    8: "Extreme Angles",
    9: "Top Dead Spot Angle",
    10: "Bottom Dead Spot Angle",
    11: "Accumulated Energy",
    12: "Offset Compensation Indicator",
}

FEATURE_FLAGS = {
    0: "Pedal Power Balance Supported",
    1: "Accumulated Torque Supported",
    2: "Wheel Revolution Data Supported",
    3: "Crank Revolution Data Supported",
    4: "Extreme Magnitudes Supported",
    5: "Extreme Angles Supported",
    6: "Top/Bottom Dead Spot Angles Supported",
    7: "Accumulated Energy Supported",
    8: "Offset Compensation Indicator Supported",
    9: "Offset Compensation Supported",
    10: "Measurement Content Masking Supported",
    11: "Multiple Sensor Locations Supported",
    12: "Crank Length Adjustment Supported",
    13: "Chain Length Adjustment Supported",
    14: "Chain Weight Adjustment Supported",
    15: "Span Length Adjustment Supported",
    16: "Sensor Measurement Context",
    17: "Instantaneous Measurement Direction Supported",
    18: "Factory Calibration Date Supported",
    19: "Enhanced Offset Compensation Supported",
}

SENSOR_LOCATIONS = {
    0: "Other", 1: "Top of shoe", 2: "In shoe", 3: "Hip", 4: "Front wheel",
    5: "Left crank", 6: "Right crank", 7: "Left pedal", 8: "Right pedal",
    9: "Front hub", 10: "Rear dropout", 11: "Chainstay", 12: "Rear wheel",
    13: "Rear hub", 14: "Chest", 15: "Spider", 16: "Chain ring",
}


@dataclass
class PowerMeasurement:
    power_w: int
    balance_pct: float | None = None
    accumulated_torque_nm: float | None = None
    wheel_revs: int | None = None
    wheel_event_time_s: float | None = None
    crank_revs: int | None = None
    crank_event_time_s: float | None = None
    accumulated_energy_kj: int | None = None
    raw: bytes = b""


def parse_power_measurement(data: bytes) -> PowerMeasurement:
    data = bytes(data)
    flags = int.from_bytes(data[0:2], "little")
    i = 2

    def u8() -> int:
        nonlocal i
        v = data[i]; i += 1; return v

    def u16() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 2], "little"); i += 2; return v

    def s16() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 2], "little", signed=True); i += 2; return v

    def u32() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 4], "little"); i += 4; return v

    out = PowerMeasurement(power_w=s16(), raw=data)   # always present
    if flags & (1 << 0):
        out.balance_pct = u8() * 0.5
    if flags & (1 << 2):
        out.accumulated_torque_nm = u16() / 32.0
    if flags & (1 << 4):
        out.wheel_revs = u32()
        out.wheel_event_time_s = u16() / 2048.0
    if flags & (1 << 5):
        out.crank_revs = u16()
        out.crank_event_time_s = u16() / 1024.0
    if flags & (1 << 6):
        u16(); u16()
    if flags & (1 << 7):
        u16(); u16()
    if flags & (1 << 8):
        i += 3
    if flags & (1 << 9):
        u16()
    if flags & (1 << 10):
        u16()
    if flags & (1 << 11):
        out.accumulated_energy_kj = u16()
    return out


def decode_flags(flags: int, table: dict[int, str]) -> list[str]:
    return [n for b, n in table.items() if flags & (1 << b)]


def cadence_from_crank(prev: PowerMeasurement, cur: PowerMeasurement) -> float | None:
    """rpm from consecutive crank revolution counters, handling uint16 rollover."""
    if None in (prev.crank_revs, cur.crank_revs,
                prev.crank_event_time_s, cur.crank_event_time_s):
        return None
    d_rev = (cur.crank_revs - prev.crank_revs) % 65536
    d_t = (cur.crank_event_time_s - prev.crank_event_time_s) % 64.0
    if d_t <= 0 or d_rev == 0:
        return None
    return d_rev / d_t * 60.0
