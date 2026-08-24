"""FTMS (Fitness Machine Service, 0x1826) protocol constants and decoders.

Byte layouts follow the Bluetooth SIG Fitness Machine Service spec v1.0.
Everything here is pure functions over bytes -- no I/O, so it is testable
without a trainer present.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field


def uuid16(short: int) -> str:
    """Expand a 16-bit assigned number into the full 128-bit BLE UUID string."""
    return f"0000{short:04x}-0000-1000-8000-00805f9b34fb"


# --- Service and characteristics -------------------------------------------

FTMS_SERVICE = uuid16(0x1826)

INDOOR_BIKE_DATA = uuid16(0x2AD2)          # notify  -- telemetry
CONTROL_POINT = uuid16(0x2AD9)             # write + indicate -- commands
MACHINE_FEATURE = uuid16(0x2ACC)           # read    -- capability bitfields
MACHINE_STATUS = uuid16(0x2ADA)            # notify  -- change confirmations
SUPPORTED_POWER_RANGE = uuid16(0x2AD8)     # read    -- min/max/increment watts
SUPPORTED_RESISTANCE_RANGE = uuid16(0x2AD6)  # read
TRAINING_STATUS = uuid16(0x2AD3)           # read + notify

# Legacy CycleOps/Saris proprietary service, in case the H3 still advertises it.
CYCLEOPS_SERVICE = "c0f4013a-a837-4165-bab9-654ef70747c6"

CHARACTERISTIC_NAMES = {
    uuid16(0x2ACC): "Fitness Machine Feature",
    uuid16(0x2AD2): "Indoor Bike Data",
    uuid16(0x2AD3): "Training Status",
    uuid16(0x2AD6): "Supported Resistance Level Range",
    uuid16(0x2AD8): "Supported Power Range",
    uuid16(0x2AD9): "Fitness Machine Control Point",
    uuid16(0x2ADA): "Fitness Machine Status",
    uuid16(0x2A5B): "CSC Measurement",
    uuid16(0x2A63): "Cycling Power Measurement",
    uuid16(0x2A65): "Cycling Power Feature",
    uuid16(0x2A29): "Manufacturer Name String",
    uuid16(0x2A24): "Model Number String",
    uuid16(0x2A25): "Serial Number String",
    uuid16(0x2A26): "Firmware Revision String",
    uuid16(0x2A27): "Hardware Revision String",
    uuid16(0x2A28): "Software Revision String",
}


# --- Control point ----------------------------------------------------------

class OpCode:
    REQUEST_CONTROL = 0x00
    RESET = 0x01
    SET_TARGET_SPEED = 0x02
    SET_TARGET_INCLINATION = 0x03
    SET_TARGET_RESISTANCE = 0x04
    SET_TARGET_POWER = 0x05
    SET_TARGET_HEART_RATE = 0x06
    START_RESUME = 0x07
    STOP_PAUSE = 0x08
    SET_SIMULATION = 0x11
    SET_WHEEL_CIRCUMFERENCE = 0x12
    SPIN_DOWN_CONTROL = 0x13
    SET_TARGETED_CADENCE = 0x14
    RESPONSE = 0x80


OPCODE_NAMES = {
    0x00: "Request Control",
    0x01: "Reset",
    0x02: "Set Target Speed",
    0x03: "Set Target Inclination",
    0x04: "Set Target Resistance Level",
    0x05: "Set Target Power",
    0x06: "Set Target Heart Rate",
    0x07: "Start or Resume",
    0x08: "Stop or Pause",
    0x11: "Set Indoor Bike Simulation Parameters",
    0x12: "Set Wheel Circumference",
    0x13: "Spin Down Control",
    0x14: "Set Targeted Cadence",
    0x80: "Response Code",
}

RESULT_NAMES = {
    0x01: "Success",
    0x02: "Op Code not supported",
    0x03: "Invalid Parameter",
    0x04: "Operation Failed",
    0x05: "Control Not Permitted",
}


def request_control() -> bytes:
    return bytes([OpCode.REQUEST_CONTROL])


def reset() -> bytes:
    return bytes([OpCode.RESET])


def start_resume() -> bytes:
    return bytes([OpCode.START_RESUME])


def stop() -> bytes:
    return bytes([OpCode.STOP_PAUSE, 0x01])


def pause() -> bytes:
    return bytes([OpCode.STOP_PAUSE, 0x02])


def set_target_power(watts: int) -> bytes:
    """Target power is a plain signed little-endian int16 in watts -- no scaling."""
    return bytes([OpCode.SET_TARGET_POWER]) + struct.pack("<h", int(watts))


def set_simulation(
    wind_speed_mps: float = 0.0,
    grade_pct: float = 0.0,
    crr: float = 0.004,
    cw: float = 0.51,
) -> bytes:
    """Opcode 0x11. Units: wind 0.001 m/s (sint16), grade 0.01 %% (sint16),
    rolling resistance 1e-4 (uint8), wind coefficient 0.01 kg/m (uint8)."""
    return bytes([OpCode.SET_SIMULATION]) + struct.pack(
        "<hhBB",
        round(wind_speed_mps * 1000),
        round(grade_pct * 100),
        round(crr / 0.0001),
        round(cw / 0.01),
    )


@dataclass
class ControlResponse:
    request_opcode: int
    result: int
    raw: bytes

    @property
    def ok(self) -> bool:
        return self.result == 0x01

    def __str__(self) -> str:
        req = OPCODE_NAMES.get(self.request_opcode, f"0x{self.request_opcode:02x}")
        res = RESULT_NAMES.get(self.result, f"0x{self.result:02x}")
        return f"{req} -> {res}"


def parse_control_response(data: bytes) -> ControlResponse | None:
    """Indications arrive as [0x80, <requested opcode>, <result>, ...]."""
    if len(data) < 3 or data[0] != OpCode.RESPONSE:
        return None
    return ControlResponse(request_opcode=data[1], result=data[2], raw=bytes(data))


# --- Fitness Machine Feature (0x2ACC) --------------------------------------

# Word 1, bit -> capability
MACHINE_FEATURE_BITS = {
    0: "Average Speed",
    1: "Cadence",
    2: "Total Distance",
    3: "Inclination",
    4: "Elevation Gain",
    5: "Pace",
    6: "Step Count",
    7: "Resistance Level",
    8: "Stride Count",
    9: "Expended Energy",
    10: "Heart Rate Measurement",
    11: "Metabolic Equivalent",
    12: "Elapsed Time",
    13: "Remaining Time",
    14: "Power Measurement",
    15: "Force on Belt and Power Output",
    16: "User Data Retention",
}

# Word 2, bit -> (capability, opcode that it enables)
TARGET_FEATURE_BITS = {
    0: ("Speed Target Setting", 0x02),
    1: ("Inclination Target Setting", 0x03),
    2: ("Resistance Target Setting", 0x04),
    3: ("Power Target Setting", 0x05),
    4: ("Heart Rate Target Setting", 0x06),
    5: ("Targeted Expended Energy Configuration", None),
    6: ("Targeted Step Number Configuration", None),
    7: ("Targeted Stride Number Configuration", None),
    8: ("Targeted Distance Configuration", None),
    9: ("Targeted Training Time Configuration", None),
    10: ("Targeted Time in Two Heart Rate Zones Configuration", None),
    11: ("Targeted Time in Three Heart Rate Zones Configuration", None),
    12: ("Targeted Time in Five Heart Rate Zones Configuration", None),
    13: ("Indoor Bike Simulation Parameters", 0x11),
    14: ("Wheel Circumference Configuration", 0x12),
    15: ("Spin Down Control", 0x13),
    16: ("Targeted Cadence Configuration", 0x14),
}


@dataclass
class MachineFeatures:
    machine_word: int
    target_word: int
    machine: list[str] = field(default_factory=list)
    targets: list[str] = field(default_factory=list)

    def supports_opcode(self, opcode: int) -> bool:
        for bit, (_name, op) in TARGET_FEATURE_BITS.items():
            if op == opcode:
                return bool(self.target_word & (1 << bit))
        return False


def parse_machine_feature(data: bytes) -> MachineFeatures:
    """Eight bytes: two little-endian uint32 bitfields."""
    if len(data) < 8:
        raise ValueError(f"expected 8 bytes, got {len(data)}: {data.hex(' ')}")
    machine_word, target_word = struct.unpack("<II", bytes(data[:8]))
    return MachineFeatures(
        machine_word=machine_word,
        target_word=target_word,
        machine=[n for b, n in MACHINE_FEATURE_BITS.items() if machine_word & (1 << b)],
        targets=[n for b, (n, _) in TARGET_FEATURE_BITS.items() if target_word & (1 << b)],
    )


def parse_power_range(data: bytes) -> dict[str, int]:
    """0x2AD8: min (sint16 W), max (sint16 W), increment (uint16 W)."""
    lo, hi, step = struct.unpack("<hhH", bytes(data[:6]))
    return {"min_watts": lo, "max_watts": hi, "increment_watts": step}


# --- Indoor Bike Data (0x2AD2) ---------------------------------------------

@dataclass
class BikeData:
    speed_kph: float | None = None
    avg_speed_kph: float | None = None
    cadence_rpm: float | None = None
    avg_cadence_rpm: float | None = None
    distance_m: int | None = None
    resistance: int | None = None
    power_w: int | None = None
    avg_power_w: int | None = None
    heart_rate_bpm: int | None = None
    elapsed_s: int | None = None
    remaining_s: int | None = None
    raw: bytes = b""


def parse_indoor_bike_data(data: bytes) -> BikeData:
    """Flags-driven variable layout. Note bit 0 is *More Data*: instantaneous
    speed is present when it is CLEAR, which is the opposite of every other bit."""
    data = bytes(data)
    flags = int.from_bytes(data[0:2], "little")
    out = BikeData(raw=data)
    i = 2

    def u16() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 2], "little")
        i += 2
        return v

    def s16() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 2], "little", signed=True)
        i += 2
        return v

    def u24() -> int:
        nonlocal i
        v = int.from_bytes(data[i:i + 3], "little")
        i += 3
        return v

    def u8() -> int:
        nonlocal i
        v = data[i]
        i += 1
        return v

    if not (flags & (1 << 0)):
        out.speed_kph = u16() * 0.01
    if flags & (1 << 1):
        out.avg_speed_kph = u16() * 0.01
    if flags & (1 << 2):
        out.cadence_rpm = u16() * 0.5
    if flags & (1 << 3):
        out.avg_cadence_rpm = u16() * 0.5
    if flags & (1 << 4):
        out.distance_m = u24()
    if flags & (1 << 5):
        out.resistance = s16()
    if flags & (1 << 6):
        out.power_w = s16()
    if flags & (1 << 7):
        out.avg_power_w = s16()
    if flags & (1 << 8):
        u16(); u16(); u8()   # total energy, energy/hour, energy/minute
    if flags & (1 << 9):
        out.heart_rate_bpm = u8()
    if flags & (1 << 10):
        u8()                 # metabolic equivalent
    if flags & (1 << 11):
        out.elapsed_s = u16()
    if flags & (1 << 12):
        out.remaining_s = u16()
    return out


# --- Fitness Machine Status (0x2ADA) ---------------------------------------

STATUS_NAMES = {
    0x01: "Reset",
    0x02: "Stopped or Paused by the User",
    0x03: "Stopped by Safety Key",
    0x04: "Started or Resumed by the User",
    0x05: "Target Speed Changed",
    0x06: "Target Incline Changed",
    0x07: "Target Resistance Level Changed",
    0x08: "Target Power Changed",
    0x09: "Target Heart Rate Changed",
    0x0A: "Targeted Expended Energy Changed",
    0x0B: "Targeted Number of Steps Changed",
    0x0C: "Targeted Number of Strides Changed",
    0x0D: "Targeted Distance Changed",
    0x0E: "Targeted Training Time Changed",
    0x12: "Indoor Bike Simulation Parameters Changed",
    0x13: "Wheel Circumference Changed",
    0x14: "Spin Down Status",
    0x15: "Targeted Cadence Changed",
    0xFF: "Control Permission Lost",
}

STATUS_TARGET_POWER_CHANGED = 0x08


@dataclass
class MachineStatus:
    opcode: int
    name: str
    value: int | None
    raw: bytes

    def __str__(self) -> str:
        return f"{self.name}" + (f" = {self.value}" if self.value is not None else "")


def parse_machine_status(data: bytes) -> MachineStatus:
    data = bytes(data)
    op = data[0]
    value = None
    if op == STATUS_TARGET_POWER_CHANGED and len(data) >= 3:
        value = int.from_bytes(data[1:3], "little", signed=True)
    return MachineStatus(
        opcode=op,
        name=STATUS_NAMES.get(op, f"Unknown 0x{op:02x}"),
        value=value,
        raw=data,
    )


# --- Handshake --------------------------------------------------------------

def handshake_sequence(include_reset: bool = False) -> list[tuple[str, bytes]]:
    """The control-point sequence that actually works on the Saris H3.

    Reset (0x01) REVOKES the control grant -- verified on firmware 31.065, see
    experiments/handshake_order.py. If you send Reset you must re-issue Request
    Control before anything else will be accepted, otherwise every subsequent
    command comes back 0x05 Control Not Permitted. Request Control is idempotent,
    so re-issuing it is always safe.
    """
    steps = [("Request Control", request_control())]
    if include_reset:
        steps += [("Reset", reset()), ("Request Control", request_control())]
    steps.append(("Start / Resume", start_resume()))
    return steps
