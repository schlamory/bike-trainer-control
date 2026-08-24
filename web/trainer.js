// BLE connection and the ERG control loop.
//
// The handshake order matters and is not the one commonly documented: Reset
// (0x01) REVOKES the control grant on this trainer, so we never send it. See
// FINDINGS.md. Request Control is idempotent, so re-issuing it before a retry
// is free insurance against a silently lost grant.

import * as F from './ftms.js';

const CONFIRM_TIMEOUT = 1000;
const RETRIES = 4;
const RETRY_DELAY = 500;

export class Trainer extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.controlChar = null;
    this.connected = false;
    this.target = null;
    this.live = { powerW: null, cadenceRpm: null, speedKph: null, distanceM: null };
    this.powerRange = null;
    this._pendingResponse = null;
    this._lastPowerEcho = null;
  }

  log(message, level = 'info') {
    this.dispatchEvent(new CustomEvent('log', { detail: { message, level } }));
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge on desktop.');
    }
    this.log('Requesting device…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [F.FTMS_SERVICE] }],
      optionalServices: [F.CPS_SERVICE, F.DEVICE_INFO_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    this.log(`Connecting to ${this.device.name}…`);
    this.server = await this.device.gatt.connect();
    const svc = await this.server.getPrimaryService(F.FTMS_SERVICE);

    // Subscribe to the control point BEFORE writing anything to it.
    this.controlChar = await svc.getCharacteristic(F.CONTROL_POINT);
    await this.controlChar.startNotifications();
    this.controlChar.addEventListener('characteristicvaluechanged', (e) => {
      const r = F.parseControlResponse(e.target.value);
      if (r && this._pendingResponse) this._pendingResponse(r);
    });

    const status = await svc.getCharacteristic(F.MACHINE_STATUS);
    await status.startNotifications();
    status.addEventListener('characteristicvaluechanged', (e) => {
      const st = F.parseMachineStatus(e.target.value);
      if (st.opcode === F.STATUS_TARGET_POWER_CHANGED) this._lastPowerEcho = st.value;
      if (st.opcode === 0xff) this.log('Trainer revoked control permission.', 'warn');
    });

    const bike = await svc.getCharacteristic(F.INDOOR_BIKE_DATA);
    await bike.startNotifications();
    bike.addEventListener('characteristicvaluechanged', (e) => {
      const d = F.parseIndoorBikeData(e.target.value);
      if (d.powerW !== undefined) this.live.powerW = d.powerW;
      if (d.cadenceRpm !== undefined) this.live.cadenceRpm = d.cadenceRpm;
      if (d.speedKph !== undefined) this.live.speedKph = d.speedKph;
      if (d.distanceM !== undefined) this.live.distanceM = d.distanceM;
      this.emit('telemetry', { ...this.live });
    });

    try {
      const pr = await svc.getCharacteristic(F.POWER_RANGE);
      this.powerRange = F.parsePowerRange(await pr.readValue());
      this.log(`Power range ${this.powerRange.min}–${this.powerRange.max} W.`);
    } catch { /* optional */ }

    this.connected = true;
    this.emit('connected', { name: this.device.name });
    this.log(`Connected to ${this.device.name}.`, 'good');
    await this.takeControl();
  }

  _onDisconnect() {
    this.connected = false;
    this.controlChar = null;
    this.emit('disconnected');
    this.log('Trainer disconnected.', 'warn');
  }

  async disconnect() {
    try { await this.command(F.stop(), F.Op.STOP_PAUSE); } catch { /* best effort */ }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  // Write to the control point and wait for the matching indication.
  async command(payload, expectOpcode) {
    if (!this.controlChar) throw new Error('Not connected.');
    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => { this._pendingResponse = null; resolve(null); }, CONFIRM_TIMEOUT);
      this._pendingResponse = (r) => {
        if (r.requestOpcode !== expectOpcode) return;
        clearTimeout(timer);
        this._pendingResponse = null;
        resolve(r);
      };
    });
    await this.controlChar.writeValueWithResponse(payload);
    return wait;
  }

  async takeControl() {
    const a = await this.command(F.requestControl(), F.Op.REQUEST_CONTROL);
    if (!a?.ok) throw new Error(`Trainer refused control: ${a?.text ?? 'no response'}`);
    const b = await this.command(F.startResume(), F.Op.START_RESUME);
    if (!b?.ok) throw new Error(`Trainer refused start: ${b?.text ?? 'no response'}`);
    this.log('In control.', 'good');
  }

  // Confirm two ways: the control-point Success, and the 0x2ADA echo of the
  // exact watts. Either missing means the target may not have landed.
  async setPower(watts) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      this._lastPowerEcho = null;
      const r = await this.command(F.setTargetPower(watts), F.Op.SET_TARGET_POWER);
      const deadline = Date.now() + CONFIRM_TIMEOUT;
      while (Date.now() < deadline && this._lastPowerEcho === null) {
        await new Promise((s) => setTimeout(s, 50));
      }
      if (r?.ok && this._lastPowerEcho === watts) {
        this.target = watts;
        this.emit('target', { watts, confirmed: true });
        if (attempt > 1) this.log(`${watts} W confirmed on attempt ${attempt}.`, 'good');
        return true;
      }
      this.log(
        `${watts} W unconfirmed (response ${r ? r.text : 'timed out'}, ` +
        `echo ${this._lastPowerEcho ?? 'silent'}) — retry ${attempt}/${RETRIES}.`, 'warn');
      await new Promise((s) => setTimeout(s, RETRY_DELAY));
      await this.command(F.requestControl(), F.Op.REQUEST_CONTROL);
    }
    this.target = watts;
    this.emit('target', { watts, confirmed: false });
    this.log(`Gave up setting ${watts} W after ${RETRIES} attempts.`, 'bad');
    return false;
  }

  // FTMS pause. Falls back to a 0 W target if the trainer rejects the opcode.
  async pause() {
    const r = await this.command(F.pause(), F.Op.STOP_PAUSE);
    if (r?.ok) return 'ftms-pause';
    this.log('Trainer rejected FTMS pause; holding 0 W instead.', 'warn');
    await this.setPower(0);
    return 'zero-watt';
  }

  async resume(watts) {
    const r = await this.command(F.startResume(), F.Op.START_RESUME);
    if (!r?.ok) this.log(`Resume returned ${r?.text ?? 'no response'}.`, 'warn');
    await this.setPower(watts);
  }
}
