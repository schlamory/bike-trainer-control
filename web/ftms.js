// FTMS (Fitness Machine Service, 0x1826) protocol.
// Byte layouts verified against a Saris H3 on firmware 31.065 -- see FINDINGS.md.

export const FTMS_SERVICE = 0x1826;
export const CPS_SERVICE = 0x1818;
export const DEVICE_INFO_SERVICE = 0x180a;

export const INDOOR_BIKE_DATA = 0x2ad2;   // notify
export const CONTROL_POINT = 0x2ad9;      // write + indicate
export const MACHINE_FEATURE = 0x2acc;    // read
export const MACHINE_STATUS = 0x2ada;     // notify
export const POWER_RANGE = 0x2ad8;        // read

export const Op = {
  REQUEST_CONTROL: 0x00,
  RESET: 0x01,
  SET_TARGET_POWER: 0x05,
  START_RESUME: 0x07,
  STOP_PAUSE: 0x08,
  RESPONSE: 0x80,
};

export const RESULT = {
  0x01: 'Success',
  0x02: 'Opcode not supported',
  0x03: 'Invalid parameter',
  0x04: 'Operation failed',
  0x05: 'Control not permitted',
};

export const STATUS_TARGET_POWER_CHANGED = 0x08;

const STATUS_NAMES = {
  0x01: 'Reset',
  0x02: 'Stopped or paused',
  0x03: 'Stopped by safety key',
  0x04: 'Started or resumed',
  0x07: 'Target resistance changed',
  0x08: 'Target power changed',
  0x12: 'Simulation parameters changed',
  0x14: 'Spin down status',
  0xff: 'Control permission lost',
};

// --- encoders ---
export const requestControl = () => Uint8Array.of(Op.REQUEST_CONTROL);
export const startResume = () => Uint8Array.of(Op.START_RESUME);
export const stop = () => Uint8Array.of(Op.STOP_PAUSE, 0x01);
export const pause = () => Uint8Array.of(Op.STOP_PAUSE, 0x02);

export function setTargetPower(watts) {
  const b = new ArrayBuffer(3);
  const v = new DataView(b);
  v.setUint8(0, Op.SET_TARGET_POWER);
  v.setInt16(1, Math.round(watts), true); // little-endian, plain watts, no scaling
  return new Uint8Array(b);
}

// --- parsers ---
export function parseControlResponse(dv) {
  if (dv.byteLength < 3 || dv.getUint8(0) !== Op.RESPONSE) return null;
  const result = dv.getUint8(2);
  return {
    requestOpcode: dv.getUint8(1),
    result,
    ok: result === 0x01,
    text: RESULT[result] ?? `0x${result.toString(16)}`,
  };
}

export function parseMachineStatus(dv) {
  const opcode = dv.getUint8(0);
  let value = null;
  if (opcode === STATUS_TARGET_POWER_CHANGED && dv.byteLength >= 3) {
    value = dv.getInt16(1, true);
  }
  return { opcode, value, name: STATUS_NAMES[opcode] ?? `Unknown 0x${opcode.toString(16)}` };
}

// Flags-driven variable layout. Bit 0 is *More Data* and is INVERTED:
// instantaneous speed is present when it is clear.
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true);
  let i = 2;
  const out = {};
  const u16 = () => { const v = dv.getUint16(i, true); i += 2; return v; };
  const s16 = () => { const v = dv.getInt16(i, true); i += 2; return v; };
  const u8 = () => dv.getUint8(i++);
  const u24 = () => {
    const v = dv.getUint8(i) | (dv.getUint8(i + 1) << 8) | (dv.getUint8(i + 2) << 16);
    i += 3; return v;
  };

  if (!(flags & (1 << 0))) out.speedKph = u16() * 0.01;
  if (flags & (1 << 1)) out.avgSpeedKph = u16() * 0.01;
  if (flags & (1 << 2)) out.cadenceRpm = u16() * 0.5;
  if (flags & (1 << 3)) out.avgCadenceRpm = u16() * 0.5;
  if (flags & (1 << 4)) out.distanceM = u24();
  if (flags & (1 << 5)) out.resistance = s16();
  if (flags & (1 << 6)) out.powerW = s16();
  if (flags & (1 << 7)) out.avgPowerW = s16();
  if (flags & (1 << 8)) { u16(); u16(); u8(); }
  if (flags & (1 << 9)) out.heartRateBpm = u8();
  if (flags & (1 << 10)) u8();
  if (flags & (1 << 11)) out.elapsedS = u16();
  if (flags & (1 << 12)) out.remainingS = u16();
  return out;
}

export function parsePowerRange(dv) {
  return {
    min: dv.getInt16(0, true),
    max: dv.getInt16(2, true),
    step: dv.getUint16(4, true),
  };
}
