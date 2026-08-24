/**
 * The two seams this app is built around.
 *
 * Everything in core/ depends only on these contracts, never on a browser API
 * or a particular trainer protocol. That is what lets the ride loop be tested
 * against a simulated trainer, and what would let an ANT+ FE-C bridge or a
 * non-Web-Bluetooth host drop in without touching the workout logic.
 *
 *   core/           ← knows about neither browsers nor FTMS
 *     ↕ TrainerController        (equipment seam)
 *   drivers/        ← knows FTMS, not the browser
 *     ↕ GattTransport            (browser seam)
 *   transport/      ← knows the browser
 *
 * JavaScript has no interfaces, so these are JSDoc typedefs plus a runtime
 * check. The check is what keeps the contracts honest rather than aspirational.
 */

/**
 * A minimal GATT surface. Deliberately smaller than Web Bluetooth's: only what
 * a fitness-machine driver needs, expressed without any browser type.
 *
 * @typedef {Object} GattTransport
 * @property {(filters: {services: string[], optionalServices?: string[]}) => Promise<GattDevice>} requestDevice
 * @property {() => boolean} isAvailable
 *
 * @typedef {Object} GattDevice
 * @property {string} name
 * @property {() => Promise<void>} connect
 * @property {() => void} disconnect
 * @property {() => boolean} isConnected
 * @property {(cb: () => void) => void} onDisconnect
 * @property {(service: string, characteristic: string) => Promise<DataView>} read
 * @property {(service: string, characteristic: string, data: Uint8Array, opts?: {response?: boolean}) => Promise<void>} write
 * @property {(service: string, characteristic: string, cb: (v: DataView) => void) => Promise<() => Promise<void>>} subscribe
 *   Resolves to an unsubscribe function.
 */

/**
 * What the ride loop needs from a trainer, whatever it is and however it is
 * reached. An implementation is an EventTarget emitting:
 *
 *   'connected'    detail {name}
 *   'disconnected' detail {}
 *   'telemetry'    detail {powerW, cadenceRpm, speedKph, distanceM}
 *   'target'       detail {watts, confirmed}
 *   'log'          detail {message, level}   level: info | good | warn | bad
 *
 * @typedef {Object} TrainerController
 * @property {boolean} connected
 * @property {?{minWatts: number, maxWatts: number}} capabilities
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} disconnect
 * @property {(watts: number) => Promise<boolean>} setPower  Resolves false if unconfirmed.
 * @property {() => Promise<string>} pause   Resolves a description of how it paused.
 * @property {(watts: number) => Promise<void>} resume
 */

const CONTROLLER_METHODS = ['connect', 'disconnect', 'setPower', 'pause', 'resume'];
const TRANSPORT_METHODS = ['requestDevice', 'isAvailable'];
const DEVICE_METHODS = ['connect', 'disconnect', 'isConnected', 'onDisconnect',
  'read', 'write', 'subscribe'];

function assertImplements(what, obj, methods) {
  const missing = methods.filter((m) => typeof obj?.[m] !== 'function');
  if (missing.length) {
    throw new TypeError(`${what} is missing: ${missing.join(', ')}`);
  }
  return obj;
}

export const assertController = (o) =>
  assertImplements('TrainerController', o, CONTROLLER_METHODS);
export const assertTransport = (o) =>
  assertImplements('GattTransport', o, TRANSPORT_METHODS);
export const assertDevice = (o) =>
  assertImplements('GattDevice', o, DEVICE_METHODS);

/** Shared event plumbing, so implementations do not each reinvent it. */
export class Emitter extends EventTarget {
  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(message, level = 'info') {
    this.emit('log', { message, level });
  }

  /** Subscribe; returns a function that removes the listener. */
  on(type, handler) {
    this.addEventListener(type, handler);
    return () => this.removeEventListener(type, handler);
  }
}
