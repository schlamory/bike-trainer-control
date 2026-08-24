/* Bluetooth capability diagnostics.
 *
 * Deliberately a classic script with no imports and no ES module syntax: its
 * whole job is to run in a browser whose Bluetooth shim may be incomplete, so
 * it must not depend on anything that could itself fail to load.
 *
 * The question this exists to answer: FTMS returns control-point responses as
 * INDICATIONS, not notifications. If a shim silently subscribes notify-only,
 * every response vanishes and the trainer looks like it is ignoring commands.
 */
(function () {
  'use strict';

  var U = function (n) {
    return '0000' + n.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
  };
  var FTMS = 0x1826, CPS = 0x1818, DEVINFO = 0x180a;
  var FEATURE = 0x2acc, BIKE = 0x2ad2, RANGE = 0x2ad8, CONTROL = 0x2ad9, STATUS = 0x2ada;

  var el = function (id) { return document.getElementById(id); };
  var results = el('results');
  var lines = [];
  var groups = {};
  var facts = {};

  function group(title) {
    if (groups[title]) return groups[title];
    var g = document.createElement('div');
    g.className = 'group';
    var h = document.createElement('div');
    h.className = 'group-title';
    h.textContent = title;
    g.appendChild(h);
    results.appendChild(g);
    groups[title] = g;
    lines.push('', '## ' + title);
    return g;
  }

  // result: pass | fail | warn | info | run
  function check(groupTitle, label, result, detail) {
    var g = group(groupTitle);
    var row = document.createElement('div');
    row.className = 'check-row';
    row.dataset.r = result;
    var m = document.createElement('span');
    m.className = 'check-mark';
    m.textContent = result === 'pass' ? 'pass' : result === 'fail' ? 'FAIL'
      : result === 'warn' ? 'warn' : result === 'run' ? '…' : 'info';
    var l = document.createElement('span');
    l.className = 'check-label';
    l.textContent = label;
    if (detail) {
      var d = document.createElement('span');
      d.className = 'check-detail';
      d.textContent = detail;
      l.appendChild(d);
    }
    row.appendChild(m);
    row.appendChild(l);
    g.appendChild(row);
    lines.push('[' + (result === 'pass' ? 'PASS' : result === 'fail' ? 'FAIL'
      : result === 'warn' ? 'WARN' : 'info') + '] ' + label + (detail ? '\n        ' + detail : ''));
    syncReport();
    return row;
  }

  function syncReport() { el('reportText').value = lines.join('\n'); }

  function hex(dv) {
    var out = [];
    for (var i = 0; i < dv.byteLength; i++) out.push(dv.getUint8(i).toString(16).padStart(2, '0'));
    return out.join(' ');
  }

  function errText(e) { return (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e)); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---- environment -------------------------------------------------------
  function runEnvironment() {
    lines.push('HAMMER BLUETOOTH DIAGNOSTICS', new Date().toISOString());

    check('Browser', 'User agent', 'info', navigator.userAgent);
    check('Browser', 'Secure context', window.isSecureContext ? 'pass' : 'fail',
      'isSecureContext = ' + window.isSecureContext + '   origin ' + location.origin);

    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || navigator.standalone === true;
    check('Browser', 'Running as an installed app', 'info', 'standalone = ' + standalone);

    var bt = navigator.bluetooth;
    facts.hasBluetooth = !!bt;
    check('Web Bluetooth', 'navigator.bluetooth exists', bt ? 'pass' : 'fail',
      'typeof = ' + typeof bt);

    if (bt) {
      var methods = ['requestDevice', 'getAvailability', 'getDevices', 'requestLEScan',
        'addEventListener', 'setScreenDimEnabled'];
      var present = [], missing = [];
      methods.forEach(function (m) { (typeof bt[m] === 'function' ? present : missing).push(m); });
      check('Web Bluetooth', 'Methods present', 'info', present.join(', ') || 'none');
      check('Web Bluetooth', 'Methods missing', missing.length ? 'warn' : 'pass',
        missing.join(', ') || 'none missing');
      facts.hasScreenDim = typeof bt.setScreenDimEnabled === 'function';

      // Proprietary Bluefy extras are worth knowing about.
      var extras = [];
      for (var k in bt) { if (methods.indexOf(k) === -1) extras.push(k); }
      if (extras.length) check('Web Bluetooth', 'Non-standard properties', 'info', extras.join(', '));

      if (typeof bt.getAvailability === 'function') {
        bt.getAvailability().then(function (a) {
          check('Web Bluetooth', 'getAvailability()', a ? 'pass' : 'warn', String(a));
        }).catch(function (e) {
          check('Web Bluetooth', 'getAvailability()', 'warn', errText(e));
        });
      }
    }

    check('Platform APIs', 'Wake Lock API', navigator.wakeLock ? 'pass' : 'warn',
      'navigator.wakeLock = ' + typeof navigator.wakeLock);
    check('Platform APIs', 'Service worker support',
      'serviceWorker' in navigator ? 'pass' : 'warn',
      'serviceWorker in navigator = ' + ('serviceWorker' in navigator));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(function () {
        check('Platform APIs', 'Service worker registers', 'pass', 'registration succeeded');
      }).catch(function (e) {
        check('Platform APIs', 'Service worker registers', 'warn', errText(e));
      });
    }

    var ls = 'unavailable';
    try { localStorage.setItem('__d', '1'); localStorage.removeItem('__d'); ls = 'works'; }
    catch (e) { ls = errText(e); }
    check('Platform APIs', 'localStorage', ls === 'works' ? 'pass' : 'warn', ls);

    check('Platform APIs', 'ES modules', 'info',
      'this page is a classic script by design; the main app uses modules');
  }

  // ---- bluetooth ---------------------------------------------------------
  var device = null, server = null;

  async function runBluetooth() {
    var indicationSeen = false, statusEchoSeen = false, telemetrySeen = false;
    facts.controlPointSubscribed = false;

    if (!navigator.bluetooth) {
      check('Connection', 'Cannot run Bluetooth tests', 'fail',
        'This browser has no Web Bluetooth. On iOS use Bluefy or BLE Link; Safari will never work.');
      return verdict();
    }

    // 1. requestDevice -- try numeric shorthand first, then a 128-bit string.
    var usedForm = null;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [FTMS] }],
        optionalServices: [CPS, DEVINFO],
      });
      usedForm = 'numeric (0x1826)';
      check('Connection', 'requestDevice with numeric UUID', 'pass', 'accepted 0x1826');
    } catch (e1) {
      check('Connection', 'requestDevice with numeric UUID', 'warn', errText(e1));
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [U(FTMS)] }],
          optionalServices: [U(CPS), U(DEVINFO)],
        });
        usedForm = '128-bit string';
        check('Connection', 'requestDevice with 128-bit UUID string', 'pass', U(FTMS));
      } catch (e2) {
        check('Connection', 'requestDevice with 128-bit UUID string', 'fail', errText(e2));
        return verdict();
      }
    }
    facts.uuidForm = usedForm;
    check('Connection', 'Device selected', 'pass',
      'name = ' + (device.name || '(none)') + '   id = ' + (device.id || '(none)'));

    // 2. connect
    try {
      server = await device.gatt.connect();
      check('Connection', 'GATT connect', 'pass', 'connected = ' + server.connected);
    } catch (e) {
      check('Connection', 'GATT connect', 'fail', errText(e));
      return verdict();
    }

    // 3. service + characteristic discovery
    var svc = null;
    try {
      svc = await server.getPrimaryService(FTMS);
      check('Discovery', 'getPrimaryService(0x1826)', 'pass', 'numeric form accepted');
    } catch (e) {
      try {
        svc = await server.getPrimaryService(U(FTMS));
        check('Discovery', 'getPrimaryService', 'warn',
          'numeric rejected, 128-bit string worked — ' + errText(e));
      } catch (e2) {
        check('Discovery', 'getPrimaryService(0x1826)', 'fail', errText(e2));
        return verdict();
      }
    }

    var chars = {};
    var wanted = [
      [FEATURE, 'Fitness Machine Feature', 'read'],
      [BIKE, 'Indoor Bike Data', 'notify'],
      [RANGE, 'Supported Power Range', 'read'],
      [CONTROL, 'Control Point', 'write + indicate'],
      [STATUS, 'Fitness Machine Status', 'notify'],
    ];
    for (var i = 0; i < wanted.length; i++) {
      var id = wanted[i][0], name = wanted[i][1], props = wanted[i][2];
      try {
        chars[id] = await svc.getCharacteristic(id);
        var p = chars[id].properties || {};
        var flags = Object.keys(p).filter(function (k) { return p[k]; });
        check('Discovery', name + ' (0x' + id.toString(16) + ')', 'pass',
          'expected ' + props + ' · reported ' + (flags.join(', ') || 'properties object empty'));
      } catch (e) {
        check('Discovery', name + ' (0x' + id.toString(16) + ')', 'fail', errText(e));
      }
    }

    // 4. read path
    if (chars[FEATURE]) {
      try {
        var v = await chars[FEATURE].readValue();
        check('Reads', 'Read Fitness Machine Feature', 'pass', hex(v) + '   (expect 86 40 00 00 0c e0 00 00)');
      } catch (e) {
        check('Reads', 'Read Fitness Machine Feature', 'fail', errText(e));
      }
    }

    // 5. THE test: subscribe to an indicate-only characteristic
    if (!chars[CONTROL]) {
      check('Indications', 'Control point unavailable', 'fail', 'cannot test indications');
      return verdict();
    }
    try {
      await chars[CONTROL].startNotifications();
      facts.controlPointSubscribed = true;
      check('Indications', 'startNotifications() on indicate-only 0x2AD9', 'pass',
        'the shim accepted the subscription — CCCD should be 0x0002');
    } catch (e) {
      check('Indications', 'startNotifications() on indicate-only 0x2AD9', 'fail', errText(e));
    }

    var indications = [];
    chars[CONTROL].addEventListener('characteristicvaluechanged', function (ev) {
      indicationSeen = true;
      indications.push(hex(ev.target.value));
    });

    // status + telemetry, both plain notifications
    var echoes = [];
    if (chars[STATUS]) {
      try {
        await chars[STATUS].startNotifications();
        chars[STATUS].addEventListener('characteristicvaluechanged', function (ev) {
          var dv = ev.target.value;
          if (dv.getUint8(0) === 0x08 && dv.byteLength >= 3) {
            statusEchoSeen = true;
            echoes.push(dv.getInt16(1, true));
          }
        });
        check('Notifications', 'Subscribe to Fitness Machine Status (0x2ADA)', 'pass', 'notify path');
      } catch (e) {
        check('Notifications', 'Subscribe to Fitness Machine Status (0x2ADA)', 'fail', errText(e));
      }
    }
    if (chars[BIKE]) {
      try {
        await chars[BIKE].startNotifications();
        chars[BIKE].addEventListener('characteristicvaluechanged', function () { telemetrySeen = true; });
        check('Notifications', 'Subscribe to Indoor Bike Data (0x2AD2)', 'pass', 'notify path');
      } catch (e) {
        check('Notifications', 'Subscribe to Indoor Bike Data (0x2AD2)', 'fail', errText(e));
      }
    }

    // 6. write path -- does writeValueWithResponse exist?
    var writer = null;
    if (typeof chars[CONTROL].writeValueWithResponse === 'function') {
      writer = function (d) { return chars[CONTROL].writeValueWithResponse(d); };
      check('Writes', 'writeValueWithResponse available', 'pass', 'preferred for the control point');
    } else if (typeof chars[CONTROL].writeValue === 'function') {
      writer = function (d) { return chars[CONTROL].writeValue(d); };
      check('Writes', 'writeValueWithResponse available', 'warn',
        'falling back to the deprecated writeValue()');
    } else {
      check('Writes', 'No write method on the control point', 'fail', 'cannot send commands');
      return verdict({ indicationSeen: indicationSeen, statusEchoSeen: statusEchoSeen, telemetrySeen: telemetrySeen });
    }

    async function send(label, bytes, waitMs) {
      var before = indications.length;
      try {
        await writer(new Uint8Array(bytes));
      } catch (e) {
        check('Writes', label, 'fail', errText(e));
        return null;
      }
      var deadline = Date.now() + (waitMs || 2000);
      while (Date.now() < deadline && indications.length === before) await sleep(50);
      if (indications.length > before) {
        var raw = indications[indications.length - 1];
        check('Writes', label, 'pass', 'wrote ' + bytes.map(function (b) {
          return b.toString(16).padStart(2, '0'); }).join(' ') + '   →  indication ' + raw);
        return raw;
      }
      check('Writes', label, 'warn', 'wrote ' + bytes.map(function (b) {
        return b.toString(16).padStart(2, '0'); }).join(' ') + '   →  no indication within 2 s');
      return null;
    }

    // Request Control. Reset is deliberately never sent: it revokes the grant.
    await send('Request Control [0x00] → expect 80 00 01', [0x00]);
    await send('Start / Resume [0x07] → expect 80 07 01', [0x07]);

    // 7. a real target, low enough to be harmless
    var before = echoes.length;
    await send('Set Target Power 50 W [0x05 32 00] → expect 80 05 01', [0x05, 0x32, 0x00]);
    var deadline = Date.now() + 2000;
    while (Date.now() < deadline && echoes.length === before) await sleep(50);
    if (echoes.length > before) {
      check('Confirmation', 'Status echo of the target (0x2ADA)', 'pass',
        'echoed ' + echoes[echoes.length - 1] + ' W — this is the notify-only fallback channel');
    } else {
      check('Confirmation', 'Status echo of the target (0x2ADA)', 'fail',
        'no Target Power Changed event within 2 s');
    }

    await sleep(2500);
    check('Telemetry', 'Indoor Bike Data frames arriving', telemetrySeen ? 'pass' : 'warn',
      telemetrySeen ? 'notifications flowing' : 'none seen in ~2.5 s (pedal to be sure)');

    // 8. hand the trainer back
    try {
      await writer(new Uint8Array([0x08, 0x01]));
      check('Cleanup', 'Stop sent, trainer released', 'pass', '[0x08 0x01]');
    } catch (e) {
      check('Cleanup', 'Stop sent, trainer released', 'warn', errText(e));
    }
    try { if (device.gatt.connected) device.gatt.disconnect(); } catch (e) { /* best effort */ }

    return verdict({ indicationSeen: indicationSeen, statusEchoSeen: statusEchoSeen, telemetrySeen: telemetrySeen });
  }

  // ---- verdict -----------------------------------------------------------
  function verdict(r) {
    r = r || {};
    var v = el('verdict'), title = el('verdictTitle'), body = el('verdictBody');
    v.hidden = false;
    var level, t, b;

    if (r.indicationSeen) {
      level = 'pass';
      t = 'Full FTMS control works';
      b = 'Indications arrive on the control point, so the app can run here unchanged. '
        + 'This is the answer the whole iOS plan was waiting on.';
    } else if (r.statusEchoSeen) {
      level = 'partial';
      t = 'Notify-only — the fallback path is viable';
      b = 'No indications on the control point, but Fitness Machine Status echoed the '
        + 'target wattage. Commands are landing; only the acknowledgements are invisible. '
        + 'The app needs its notify-only mode: confirm targets from the 0x2ADA echo and '
        + 'infer that control was granted from the echo arriving at all.';
    } else if (facts.hasBluetooth === false) {
      level = 'fail';
      t = 'No Web Bluetooth in this browser';
      b = 'Nothing to test. On iOS this means Safari — use Bluefy or BLE Link instead.';
    } else {
      level = 'fail';
      t = 'No confirmation of any kind';
      b = 'Neither control-point indications nor status echoes arrived. Either the writes '
        + 'are not reaching the trainer, or something else holds its single BLE connection.';
    }

    v.dataset.level = level;
    title.textContent = t;
    body.textContent = b;
    lines.push('', '## VERDICT', t, b);
    syncReport();
    el('copyBtn').disabled = false;
    el('runNote').textContent = 'Done. Copy the report and send it over.';
  }

  // ---- wiring ------------------------------------------------------------
  el('runBtn').addEventListener('click', async function () {
    el('runBtn').disabled = true;
    el('runNote').textContent = 'Running…';
    try {
      await runBluetooth();
    } catch (e) {
      check('Connection', 'Unexpected failure', 'fail', errText(e));
      verdict();
    }
    el('runBtn').disabled = false;
    el('runBtn').textContent = 'Run again';
  });

  el('copyBtn').addEventListener('click', async function () {
    var text = el('reportText').value;
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      var ta = el('reportText');
      el('reportPanel').open = true;
      ta.focus();
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
    }
    el('copyBtn').textContent = ok ? 'Copied' : 'Select the text below and copy';
    setTimeout(function () { el('copyBtn').textContent = 'Copy report'; }, 2500);
  });

  window.addEventListener('error', function (e) {
    check('Errors', 'Uncaught error', 'fail', e.message + ' @ ' + e.filename + ':' + e.lineno);
  });
  window.addEventListener('unhandledrejection', function (e) {
    check('Errors', 'Unhandled rejection', 'fail', errText(e.reason));
  });

  runEnvironment();
})();
