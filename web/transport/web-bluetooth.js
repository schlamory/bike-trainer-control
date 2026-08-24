/**
 * GattTransport over the Web Bluetooth API.
 *
 * This is the only file in the app that touches navigator.bluetooth. Everything
 * browser-specific — including the quirks — lives here, so a driver above it
 * never has to know which browser it is running in.
 *
 * Quirk worth keeping in one place: Bluefy's shim rejects 16-bit numeric UUIDs
 * in requestDevice filters (it fails with the bare message "2"), while Chrome
 * expands them. Callers pass canonical 128-bit strings; see drivers/ftms.js.
 */

import { assertDevice } from '../core/contracts.js';

class WebBluetoothDevice {
  constructor(device) {
    this.device = device;
    this.server = null;
    this.name = device.name || '(unnamed)';
    this._services = new Map();
    this._chars = new Map();
  }

  async connect() {
    this.server = await this.device.gatt.connect();
  }

  disconnect() {
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
  }

  isConnected() {
    return !!this.device.gatt?.connected;
  }

  onDisconnect(cb) {
    this.device.addEventListener('gattserverdisconnected', () => {
      this._services.clear();
      this._chars.clear();
      cb();
    });
  }

  async _characteristic(serviceUuid, charUuid) {
    const key = `${serviceUuid}/${charUuid}`;
    if (this._chars.has(key)) return this._chars.get(key);
    if (!this.server) throw new Error('Not connected.');
    let svc = this._services.get(serviceUuid);
    if (!svc) {
      svc = await this.server.getPrimaryService(serviceUuid);
      this._services.set(serviceUuid, svc);
    }
    const ch = await svc.getCharacteristic(charUuid);
    this._chars.set(key, ch);
    return ch;
  }

  async read(serviceUuid, charUuid) {
    return (await this._characteristic(serviceUuid, charUuid)).readValue();
  }

  async write(serviceUuid, charUuid, data, { response = true } = {}) {
    const ch = await this._characteristic(serviceUuid, charUuid);
    // Older shims only expose the deprecated writeValue().
    if (response && typeof ch.writeValueWithResponse === 'function') {
      return ch.writeValueWithResponse(data);
    }
    if (!response && typeof ch.writeValueWithoutResponse === 'function') {
      return ch.writeValueWithoutResponse(data);
    }
    return ch.writeValue(data);
  }

  /** Works for both notify and indicate; the browser picks the right CCCD bit. */
  async subscribe(serviceUuid, charUuid, cb) {
    const ch = await this._characteristic(serviceUuid, charUuid);
    const handler = (e) => cb(e.target.value);
    ch.addEventListener('characteristicvaluechanged', handler);
    await ch.startNotifications();
    return async () => {
      ch.removeEventListener('characteristicvaluechanged', handler);
      try { await ch.stopNotifications(); } catch { /* disconnected already */ }
    };
  }
}

export class WebBluetoothTransport {
  isAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async requestDevice({ services, optionalServices = [] }) {
    if (!this.isAvailable()) {
      const err = new Error(
        'This browser has no Web Bluetooth. Use Chrome or Edge on desktop, '
        + 'or Bluefy on iOS — Safari does not support it.');
      err.name = 'NotSupportedError';
      throw err;
    }
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services }],
      optionalServices,
    });
    return assertDevice(new WebBluetoothDevice(device));
  }
}
