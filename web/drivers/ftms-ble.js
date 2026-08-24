/**
 * TrainerController for a Fitness Machine Service (0x1826) trainer, reached
 * over any GattTransport. Knows FTMS; knows nothing about the browser.
 *
 * Two behaviours here were established by testing a Saris H3 rather than by
 * reading the spec, and both matter (see FINDINGS.md):
 *
 *  1. Reset (0x01) REVOKES the control grant. The commonly documented
 *     handshake — Request Control, Reset, Start — fails with Control Not
 *     Permitted. We never send Reset. Request Control is idempotent, so
 *     re-issuing it before a retry is free insurance against a lost grant.
 *
 *  2. Every target write is confirmed twice: the control-point indication
 *     carrying Success, and a Target Power Changed event on Fitness Machine
 *     Status echoing the exact wattage. The trainer is known to occasionally
 *     ignore a target and hold the previous one.
 */

import { Emitter, assertTransport } from '../core/contracts.js';
import * as F from './ftms.js';

const CONFIRM_TIMEOUT = 1000;
const RETRIES = 4;
const RETRY_DELAY = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FtmsBleTrainer extends Emitter {
  constructor(transport) {
    super();
    this.transport = assertTransport(transport);
    this.device = null;
    this.connected = false;
    this.capabilities = null;
    this.target = null;
    this.live = { powerW: null, cadenceRpm: null, speedKph: null, distanceM: null };
    this._unsubscribes = [];
    this._pendingResponse = null;
    this._lastPowerEcho = null;
  }

  async connect() {
    this.log('Requesting device…');
    this.device = await this.transport.requestDevice({
      services: [F.FTMS_SERVICE],
      optionalServices: [F.CPS_SERVICE, F.DEVICE_INFO_SERVICE],
    });
    this.device.onDisconnect(() => this._onDisconnect());

    this.log(`Connecting to ${this.device.name}…`);
    await this.device.connect();

    // Subscribe to the control point before writing anything to it.
    this._unsubscribes.push(await this.device.subscribe(
      F.FTMS_SERVICE, F.CONTROL_POINT, (dv) => {
        const r = F.parseControlResponse(dv);
        if (r && this._pendingResponse) this._pendingResponse(r);
      }));

    this._unsubscribes.push(await this.device.subscribe(
      F.FTMS_SERVICE, F.MACHINE_STATUS, (dv) => {
        const st = F.parseMachineStatus(dv);
        if (st.opcode === F.STATUS_TARGET_POWER_CHANGED) this._lastPowerEcho = st.value;
        if (st.opcode === 0xff) this.log('Trainer revoked control permission.', 'warn');
      }));

    this._unsubscribes.push(await this.device.subscribe(
      F.FTMS_SERVICE, F.INDOOR_BIKE_DATA, (dv) => {
        const d = F.parseIndoorBikeData(dv);
        for (const k of ['powerW', 'cadenceRpm', 'speedKph', 'distanceM']) {
          if (d[k] !== undefined) this.live[k] = d[k];
        }
        this.emit('telemetry', { ...this.live });
      }));

    try {
      const r = F.parsePowerRange(await this.device.read(F.FTMS_SERVICE, F.POWER_RANGE));
      this.capabilities = { minWatts: r.min, maxWatts: r.max, stepWatts: r.step };
      this.log(`Power range ${r.min}–${r.max} W.`);
    } catch { /* optional */ }

    this.connected = true;
    this.emit('connected', { name: this.device.name });
    this.log(`Connected to ${this.device.name}.`, 'good');
    await this._takeControl();
  }

  _onDisconnect() {
    this.connected = false;
    this._unsubscribes = [];
    this.emit('disconnected');
    this.log('Trainer disconnected.', 'warn');
  }

  async disconnect() {
    try { await this._command(F.stop(), F.Op.STOP_PAUSE); } catch { /* best effort */ }
    for (const un of this._unsubscribes.splice(0)) {
      try { await un(); } catch { /* best effort */ }
    }
    this.device?.disconnect();
  }

  /** Write to the control point and wait for the matching indication. */
  async _command(payload, expectOpcode) {
    if (!this.device?.isConnected()) throw new Error('Not connected.');
    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => { this._pendingResponse = null; resolve(null); },
        CONFIRM_TIMEOUT);
      this._pendingResponse = (r) => {
        if (r.requestOpcode !== expectOpcode) return;
        clearTimeout(timer);
        this._pendingResponse = null;
        resolve(r);
      };
    });
    await this.device.write(F.FTMS_SERVICE, F.CONTROL_POINT, payload, { response: true });
    return wait;
  }

  async _takeControl() {
    const a = await this._command(F.requestControl(), F.Op.REQUEST_CONTROL);
    if (!a?.ok) throw new Error(`Trainer refused control: ${a?.text ?? 'no response'}`);
    const b = await this._command(F.startResume(), F.Op.START_RESUME);
    if (!b?.ok) throw new Error(`Trainer refused start: ${b?.text ?? 'no response'}`);
    this.log('In control.', 'good');
  }

  async setPower(watts) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      this._lastPowerEcho = null;
      const r = await this._command(F.setTargetPower(watts), F.Op.SET_TARGET_POWER);
      const deadline = Date.now() + CONFIRM_TIMEOUT;
      while (Date.now() < deadline && this._lastPowerEcho === null) await sleep(50);

      if (r?.ok && this._lastPowerEcho === watts) {
        this.target = watts;
        this.emit('target', { watts, confirmed: true });
        if (attempt > 1) this.log(`${watts} W confirmed on attempt ${attempt}.`, 'good');
        return true;
      }
      this.log(
        `${watts} W unconfirmed (response ${r ? r.text : 'timed out'}, `
        + `echo ${this._lastPowerEcho ?? 'silent'}) — retry ${attempt}/${RETRIES}.`, 'warn');
      await sleep(RETRY_DELAY);
      await this._command(F.requestControl(), F.Op.REQUEST_CONTROL);
    }
    this.target = watts;
    this.emit('target', { watts, confirmed: false });
    this.log(`Gave up setting ${watts} W after ${RETRIES} attempts.`, 'bad');
    return false;
  }

  /** FTMS pause, falling back to a 0 W hold if the trainer rejects the opcode. */
  async pause() {
    const r = await this._command(F.pause(), F.Op.STOP_PAUSE);
    if (r?.ok) return 'FTMS pause';
    this.log('Trainer rejected FTMS pause; holding 0 W instead.', 'warn');
    await this.setPower(0);
    return '0 W hold';
  }

  async resume(watts) {
    const r = await this._command(F.startResume(), F.Op.START_RESUME);
    if (!r?.ok) this.log(`Resume returned ${r?.text ?? 'no response'}.`, 'warn');
    await this.setPower(watts);
  }
}
