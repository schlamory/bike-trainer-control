/**
 * The ride loop: owns the clock, walks the plan, and drives a TrainerController.
 *
 * Depends on nothing but the plan model and the controller contract — no DOM,
 * no browser API, no FTMS. A UI renders the events it emits; it never reaches
 * back into the UI.
 *
 * Events:
 *   'tick'      {elapsed, index, step, into, remaining, progress, next, nextIn}
 *   'interval'  {index, step, confirmed}   on each boundary
 *   'state'     {running, paused}
 *   'finished'  {elapsed}
 *   'log'       {message, level}
 */

import { Emitter, assertController } from './contracts.js';
import { locate, planTotal } from './workout.js';

const TICK_MS = 100;          // UI smoothness; control decisions are 1 Hz
const KEEPALIVE_MS = 10_000;  // rewrite an unchanged target periodically
const KEEPALIVE_MIN_STEP_S = 20;

// A tick gap longer than this means the page was suspended rather than merely
// busy -- worth telling the rider about, since the clock will have caught up.
const GAP_NOTICE_S = 3;

export class RideSession extends Emitter {
  /**
   * @param {import('./contracts.js').TrainerController} controller
   * @param {{plan: Array<{watts:number, seconds:number}>}} opts
   */
  constructor(controller, { plan }) {
    super();
    this.controller = assertController(controller);
    this.plan = plan;
    this.running = false;
    this.paused = false;
    this.elapsed = 0;
    this.currentIndex = -1;
    this._timer = null;
    this._lastTickAt = null;
    this._lastKeepaliveAt = 0;
  }

  get total() {
    return planTotal(this.plan);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.elapsed = 0;
    this.currentIndex = -1;
    this._lastTickAt = performance.now();
    this._timer = setInterval(() => this._tick(), TICK_MS);
    this.emit('state', { running: true, paused: false });
  }

  async pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emit('state', { running: true, paused: true });
    const how = await this.controller.pause();
    this.log(`Paused (${how}).`);
  }

  async resume() {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this._lastTickAt = performance.now();
    this.emit('state', { running: true, paused: false });
    const step = this.plan[this.currentIndex];
    await this.controller.resume(step ? step.watts : 0);
    this.log('Resumed.');
  }

  /** The easiest wattage the workout asked for -- where the ride settles. */
  get floorWatts() {
    return this.plan.length ? Math.min(...this.plan.map((s) => s.watts)) : null;
  }

  /** Ends the ride. `reason` appears in the log; 'finished' fires either way. */
  stop(reason = 'Ride ended.', level = 'info') {
    if (!this.running) return;
    clearInterval(this._timer);
    this._timer = null;
    this.running = false;
    this.paused = false;
    this.emit('state', { running: false, paused: false });
    this.log(reason, level);
    this.emit('finished', { elapsed: this.elapsed });
    this._settle();
  }

  /**
   * Drop to the workout's easiest wattage rather than leaving the trainer
   * holding whatever the last interval asked for -- finishing on a hard effort
   * would otherwise leave full resistance on for the spin-down.
   *
   * Deliberately not an FTMS Stop: staying in ERG at a low target keeps the
   * resistance predictable while you keep pedalling.
   */
  async _settle() {
    const floor = this.floorWatts;
    if (floor === null || !this.controller.connected) return;
    try {
      await this.controller.setPower(floor);
      this.log(`Trainer left at ${floor} W.`);
    } catch (err) {
      this.log(`Could not set the trainer down to ${floor} W: ${err.message}`, 'warn');
    }
  }

  _tick() {
    if (!this.running || this.paused) return;

    const now = performance.now();
    const delta = (now - this._lastTickAt) / 1000;
    this.elapsed += delta;
    this._lastTickAt = now;

    // The clock is wall-clock, not tick-counted: a backgrounded page catches
    // up in one step rather than the workout running long. That is the
    // intended behaviour -- it just needs to be visible, because the intervals
    // spanned by the gap are skipped without ever being sent to the trainer.
    if (delta > GAP_NOTICE_S) {
      this.log(`Skipped ${Math.round(delta)}s — the app was in the background. `
        + 'The workout stays on its original schedule.', 'warn');
    }

    const pos = locate(this.plan, this.elapsed);
    if (!pos) {
      this.stop('Workout complete.', 'good');
      return;
    }

    if (pos.index !== this.currentIndex) {
      this.currentIndex = pos.index;
      this._lastKeepaliveAt = now;
      const step = this.plan[pos.index];
      this.emit('interval', { index: pos.index, step });
      this.controller.setPower(step.watts)
        .then((ok) => this.emit('interval', { index: pos.index, step, confirmed: ok }))
        .catch((e) => this.log(e.message, 'bad'));
    }

    const step = this.plan[pos.index];
    if (step.seconds >= KEEPALIVE_MIN_STEP_S && now - this._lastKeepaliveAt >= KEEPALIVE_MS) {
      this._lastKeepaliveAt = now;
      this.controller.setPower(step.watts).catch(() => { /* the retry path logs */ });
    }

    this.emit('tick', {
      elapsed: this.elapsed,
      index: pos.index,
      step,
      into: pos.into,
      remaining: pos.remaining,
      progress: pos.into / step.seconds,
      next: this.plan[pos.index + 1] ?? null,
      nextIn: pos.remaining,
      count: this.plan.length,
    });
  }
}
