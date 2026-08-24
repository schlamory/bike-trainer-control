/**
 * A simulated trainer implementing TrainerController.
 *
 * Two jobs. First, it lets the whole app be developed and driven with no
 * hardware, no BLE and no browser permissions — which is the real test of
 * whether the TrainerController seam is honest, since this file shares no code
 * with the FTMS driver.
 *
 * Second, it can misbehave on purpose. The ERG-stick bug never reproduced in
 * testing (26 target changes, zero sticks), which means the confirm-and-retry
 * logic in the real driver has never actually executed. `stickRate` makes it
 * execute: a stuck target reports no echo, exactly as the real failure does.
 *
 * Physics are deliberately shallow — enough to make the UI behave plausibly,
 * matching the measured asymmetry (~2 s to climb, ~3–4 s to bleed down).
 */

import { Emitter } from '../core/contracts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MockTrainer extends Emitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.stickRate]  0–1 chance a target write is ignored.
   * @param {number} [opts.name]
   * @param {boolean} [opts.pedalling] whether to produce non-zero power.
   */
  constructor({ stickRate = 0, name = 'Mock Trainer', pedalling = true } = {}) {
    super();
    this.connected = false;
    this.capabilities = { minWatts: 0, maxWatts: 3000, stepWatts: 1 };
    this.target = null;
    this.stickRate = stickRate;
    this.name = name;
    this.pedalling = pedalling;
    this._actual = 0;
    this._committed = 0;      // what the trainer is really holding
    this._timer = null;
    this._paused = false;
    this.stickCount = 0;
  }

  async connect() {
    this.log('Connecting to the simulator…');
    await sleep(200);
    this.connected = true;
    this.emit('connected', { name: this.name });
    this.log(`Connected to ${this.name}.`, 'good');
    this._timer = setInterval(() => this._tick(), 1000);  // 1 Hz, like the real thing
  }

  async disconnect() {
    clearInterval(this._timer);
    this._timer = null;
    this.connected = false;
    this.emit('disconnected');
  }

  _tick() {
    if (!this.pedalling || this._paused) {
      this._actual = 0;
    } else {
      // Asymmetric approach: resistance is added fast, momentum bleeds slowly.
      const gap = this._committed - this._actual;
      const rate = gap > 0 ? 0.55 : 0.32;
      this._actual += gap * rate;
      if (Math.abs(gap) < 2) this._actual = this._committed;
    }
    const jitter = this._actual > 0 ? (Math.random() - 0.5) * 8 : 0;
    this.emit('telemetry', {
      powerW: Math.max(0, Math.round(this._actual + jitter)),
      cadenceRpm: this.pedalling && !this._paused ? 78 + Math.round(Math.random() * 8) : 0,
      speedKph: this.pedalling && !this._paused ? 30 + Math.random() * 2 : 0,
      distanceM: null,
    });
  }

  async setPower(watts) {
    await sleep(60);
    this.target = watts;
    if (Math.random() < this.stickRate) {
      // Stuck: the command is silently ignored, no confirmation comes back.
      this.stickCount += 1;
      this.log(`Simulated ERG stick — ${watts} W ignored, still holding `
        + `${Math.round(this._committed)} W.`, 'warn');
      this.emit('target', { watts, confirmed: false });
      return false;
    }
    this._committed = watts;
    this.emit('target', { watts, confirmed: true });
    return true;
  }

  async pause() {
    this._paused = true;
    return 'simulated pause';
  }

  async resume(watts) {
    this._paused = false;
    await this.setPower(watts);
  }
}
