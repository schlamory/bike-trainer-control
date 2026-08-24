/**
 * A GattTransport that emulates an FTMS trainer at the byte level.
 *
 * The point of this, as distinct from drivers/mock.js: a controller-level mock
 * replaces the FTMS driver wholesale, so it can never test the driver. This one
 * sits under the driver, which means FtmsBleTrainer runs for real — its
 * handshake, its response parsing, and critically its confirm-and-retry path.
 *
 * That path had never executed against hardware: the ERG-stick bug did not
 * reproduce in 26 target changes. `stickRate` reproduces it deterministically —
 * a stuck write is acknowledged on the control point but produces no status
 * echo, which is exactly the failure the retry logic exists to catch.
 *
 * Byte layouts mirror a real Saris H3; see FINDINGS.md.
 */

import { assertDevice } from '../core/contracts.js';

const FTMS = '00001826-0000-1000-8000-00805f9b34fb';
const CONTROL = '00002ad9-0000-1000-8000-00805f9b34fb';
const STATUS = '00002ada-0000-1000-8000-00805f9b34fb';
const BIKE = '00002ad2-0000-1000-8000-00805f9b34fb';
const RANGE = '00002ad8-0000-1000-8000-00805f9b34fb';
const FEATURE = '00002acc-0000-1000-8000-00805f9b34fb';

const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);

class MockFtmsDevice {
  constructor({ stickRate = 0, name = 'Mock Hammer', pedalling = true }) {
    this.name = name;
    this.stickRate = stickRate;
    this.pedalling = pedalling;
    this._connected = false;
    this._subs = new Map();
    this._disconnectCb = null;
    this._timer = null;
    this._controlGranted = false;
    this._started = false;
    this.target = 0;
    this._committed = 0;
    this._actual = 0;
    this.stickCount = 0;
  }

  async connect() {
    this._connected = true;
    this._timer = setInterval(() => this._telemetry(), 1000);
  }

  disconnect() {
    this._connected = false;
    clearInterval(this._timer);
    this._timer = null;
    this._disconnectCb?.();
  }

  isConnected() { return this._connected; }
  onDisconnect(cb) { this._disconnectCb = cb; }

  async read(_service, characteristic) {
    if (characteristic === FEATURE) return dv([0x86, 0x40, 0, 0, 0x0c, 0xe0, 0, 0]);
    if (characteristic === RANGE) return dv([0, 0, 0xb8, 0x0b, 1, 0]);   // 0–3000 W, 1 W
    throw new Error(`Mock has no read for ${characteristic}`);
  }

  async subscribe(_service, characteristic, cb) {
    if (!this._subs.has(characteristic)) this._subs.set(characteristic, new Set());
    this._subs.get(characteristic).add(cb);
    return async () => { this._subs.get(characteristic)?.delete(cb); };
  }

  _notify(characteristic, bytes) {
    for (const cb of this._subs.get(characteristic) ?? []) cb(dv(bytes));
  }

  async write(_service, characteristic, data) {
    if (characteristic !== CONTROL) throw new Error(`Mock has no write for ${characteristic}`);
    const b = Array.from(data);
    const op = b[0];
    // Responses are asynchronous on real hardware; keep that shape.
    setTimeout(() => this._handle(op, b), 15);
  }

  _handle(op, b) {
    const respond = (result) => this._notify(CONTROL, [0x80, op, result]);

    if (op === 0x00) {                       // Request Control -- idempotent
      this._controlGranted = true;
      return respond(0x01);
    }
    if (op === 0x01) {                       // Reset REVOKES control, as on real hardware
      this._controlGranted = false;
      respond(0x01);
      return this._notify(STATUS, [0x01]);
    }
    if (!this._controlGranted) return respond(0x05);   // Control Not Permitted

    if (op === 0x07) {                       // Start / Resume
      this._started = true;
      respond(0x01);
      return this._notify(STATUS, [0x04]);
    }
    if (op === 0x08) {                       // Stop / Pause
      this._started = false;
      respond(0x01);
      return this._notify(STATUS, [b[1] === 0x02 ? 0x02 : 0x02]);
    }
    if (op === 0x05) {                       // Set Target Power
      const watts = new DataView(Uint8Array.from(b).buffer).getInt16(1, true);
      if (watts < 0 || watts > 3000) return respond(0x03);   // Invalid Parameter
      respond(0x01);
      if (Math.random() < this.stickRate) {
        // The stick: acknowledged, but the target never actually changes and
        // no status echo follows. Silent, which is what makes it nasty.
        this.stickCount += 1;
        return;
      }
      this.target = watts;
      this._committed = watts;
      const lo = watts & 0xff, hi = (watts >> 8) & 0xff;
      return this._notify(STATUS, [0x08, lo, hi]);
    }
    return respond(0x02);                    // Opcode not supported
  }

  _telemetry() {
    const live = this.pedalling && this._started;
    if (live) {
      const gap = this._committed - this._actual;
      this._actual += gap * (gap > 0 ? 0.55 : 0.32);   // measured asymmetry
      if (Math.abs(gap) < 2) this._actual = this._committed;
    } else {
      this._actual = 0;
    }
    const power = Math.max(0, Math.round(this._actual + (live ? (Math.random() - 0.5) * 8 : 0)));
    const cadence = live ? Math.round((78 + Math.random() * 8) * 2) : 0;
    const speed = live ? 3000 : 0;
    // flags 0x0074: speed, cadence, distance, resistance, power -- a real H3 frame
    this._notify(BIKE, [
      0x74, 0x00,
      speed & 0xff, speed >> 8,
      cadence & 0xff, cadence >> 8,
      0, 0, 0,
      0, 0,
      power & 0xff, (power >> 8) & 0xff,
    ]);
  }
}

export class MockGattTransport {
  constructor(opts = {}) { this.opts = opts; }
  isAvailable() { return true; }
  async requestDevice() { return assertDevice(new MockFtmsDevice(this.opts)); }
}
