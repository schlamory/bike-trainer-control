/**
 * UI layer. Renders session state and turns clicks into intent.
 *
 * Deliberately holds no ride logic: the clock, plan traversal and trainer
 * commands live in core/session.js. This file only listens and draws.
 *
 * Dev switches, via the query string:
 *   ?mock            simulated trainer at the controller seam — fastest for UI work
 *   ?mock=gatt       simulated trainer at the TRANSPORT seam, so the real FTMS
 *                    driver runs: handshake, response parsing, confirm-and-retry
 *   ?mock=gatt&stick=0.3   make 30% of target writes stick, exercising the retry
 */

import { WebBluetoothTransport } from './transport/web-bluetooth.js';
import { MockGattTransport } from './transport/mock-gatt.js';
import { FtmsBleTrainer } from './drivers/ftms-ble.js';
import { MockTrainer } from './drivers/mock.js';
import { RideSession } from './core/session.js';
import {
  repeatSet, planTotal, planWorkKj, formatClock, formatDuration, zoneFor,
} from './core/workout.js';
import * as Workouts from './core/workouts.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const el = {
  dot: $('dot'), deviceName: $('deviceName'), connectBtn: $('connectBtn'),
  wakeState: $('wakeState'),
  nowCard: $('nowCard'), zoneLabel: $('zoneLabel'), targetW: $('targetW'),
  countdown: $('countdown'), intervalFill: $('intervalFill'),
  actualW: $('actualW'), cadence: $('cadence'), elapsed: $('elapsed'),
  intervalCount: $('intervalCount'),
  nextCard: $('nextCard'), nextW: $('nextW'), nextDur: $('nextDur'), nextIn: $('nextIn'),
  profile: $('profile'), profileTotal: $('profileTotal'),
  startBtn: $('startBtn'), pauseBtn: $('pauseBtn'), stopBtn: $('stopBtn'),
  workoutPicker: $('workoutPicker'), workoutName: $('workoutName'),
  saveWorkout: $('saveWorkout'), deleteWorkout: $('deleteWorkout'),
  pickerNote: $('pickerNote'),
  intervals: $('intervals'), addInterval: $('addInterval'),
  repeatInput: $('repeatInput'), ftpInput: $('ftpInput'),
  planSummary: $('planSummary'), configError: $('configError'),
  configPanel: $('configPanel'), log: $('log'),
  notice: $('notice'), noticeTitle: $('noticeTitle'), noticeText: $('noticeText'),
  noticeHint: $('noticeHint'), noticeClose: $('noticeClose'),
};

// --- controller selection -------------------------------------------------
const mockMode = params.get('mock');           // null | '' | 'gatt'
const useMock = params.has('mock');
const stickRate = parseFloat(params.get('stick') || '0');

const trainer = mockMode === 'gatt'
  // Real driver over a fake radio: exercises FTMS parsing and the retry path.
  ? new FtmsBleTrainer(new MockGattTransport({ stickRate }))
  : useMock
    // Fake driver: no protocol at all, quickest way to work on the UI.
    ? new MockTrainer({ stickRate })
    : new FtmsBleTrainer(new WebBluetoothTransport());

let session = null;
const ui = {
  plan: [], ftp: 250, blocks: [], wakeLock: null,
  set: [], repeat: 7, slug: null, name: '',
};

// --- routing --------------------------------------------------------------
// Pretty paths on static hosting: /workout/<slug>. See 404.html and serve.py.
//
// The base is derived from this module's own URL rather than location.pathname,
// which is only the base once 404.html has bounced us there. This is correct
// however the page was reached.
const BASE = new URL('.', import.meta.url).pathname;

function routeSlug() {
  const rest = location.pathname.startsWith(BASE)
    ? location.pathname.slice(BASE.length)
    : '';
  const m = rest.replace(/^\//, '').match(/^workout\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function setRoute(slug, { replace = false } = {}) {
  const url = slug ? `${BASE}workout/${encodeURIComponent(slug)}` : BASE;
  const full = url + location.search + location.hash;
  if (location.pathname === url) return;
  history[replace ? 'replaceState' : 'pushState']({ slug }, '', full);
}

// --- persistence ----------------------------------------------------------
// Retyping intervals on a phone is miserable, so the set and the settings are
// remembered. localStorage is per-origin and works in Bluefy (verified).
const STORE = 'hammer.v1';

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(
      { set: ui.set, repeat: ui.repeat, ftp: ui.ftp, slug: ui.slug, name: ui.name }));
  } catch { /* private mode, or full — not worth surfacing */ }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (raw?.set?.length) {
      ui.set = raw.set.map((s) => ({ watts: +s.watts || 0, seconds: +s.seconds || 0 }));
      ui.repeat = +raw.repeat || 1;
      ui.ftp = +raw.ftp || 250;
      ui.slug = raw.slug ?? null;
      ui.name = raw.name ?? '';
      return true;
    }
  } catch { /* fall through to defaults */ }
  return false;
}

// --- named workouts -------------------------------------------------------
function renderPicker() {
  const { saved, presets } = Workouts.list();
  el.workoutPicker.replaceChildren();

  const opt = (w, label) => {
    const o = document.createElement('option');
    o.value = w.slug;
    o.textContent = label ?? w.name;
    return o;
  };

  if (saved.length) {
    const g = document.createElement('optgroup');
    g.label = 'Saved';
    saved.forEach((w) => g.append(opt(w)));
    el.workoutPicker.append(g);
  }
  if (presets.length) {
    const g = document.createElement('optgroup');
    g.label = 'Built in';
    presets.forEach((w) => g.append(opt(w)));
    el.workoutPicker.append(g);
  }

  const unsaved = document.createElement('option');
  unsaved.value = '';
  unsaved.textContent = ui.slug ? 'Unsaved changes' : 'Unsaved workout';
  el.workoutPicker.append(unsaved);

  const current = Workouts.get(ui.slug);
  const clean = Workouts.matches(current, ui.set, ui.repeat);
  el.workoutPicker.value = clean ? ui.slug : '';
  el.deleteWorkout.hidden = !(current?.saved && clean);

  if (ui.slug && !clean) {
    note(`Edited from “${current?.name ?? ui.slug}”. Save to keep the changes.`);
  } else if (current && !current.saved) {
    note('Built-in workout. Saving makes an editable copy.');
  } else {
    note('');
  }
}

function note(text, level = '') {
  el.pickerNote.textContent = text;
  el.pickerNote.dataset.level = level;
}

function applyWorkout(w, { push = true } = {}) {
  if (!w) return false;
  ui.set = w.set.map((s) => ({ ...s }));
  ui.repeat = w.repeat;
  ui.slug = w.slug;
  ui.name = w.name;
  el.repeatInput.value = String(ui.repeat);
  el.workoutName.value = ui.name;
  renderIntervals();
  rebuildPlan();
  setRoute(w.slug, { replace: !push });
  return true;
}

// --- notices and logging --------------------------------------------------
function showNotice(title, text, hint = null) {
  el.noticeTitle.textContent = title;
  el.noticeText.textContent = text;
  el.noticeHint.textContent = hint ?? '';
  el.noticeHint.hidden = !hint;
  el.notice.hidden = false;
}
const clearNotice = () => { el.notice.hidden = true; };

function log(message, level = 'info') {
  const row = document.createElement('div');
  row.className = 'log-row';
  row.dataset.level = level;
  const t = document.createElement('span');
  t.className = 'log-time';
  t.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const m = document.createElement('span');
  m.textContent = message;
  row.append(t, m);
  el.log.prepend(row);
  while (el.log.childElementCount > 200) el.log.lastElementChild.remove();
}

trainer.addEventListener('log', (e) => log(e.detail.message, e.detail.level));

// --- interval editor ------------------------------------------------------
function renderIntervals() {
  el.intervals.replaceChildren();
  ui.set.forEach((step, i) => {
    const row = document.createElement('div');
    row.className = 'interval-row';
    row.style.setProperty('--blk', `var(--${zoneFor(step.watts, ui.ftp).key})`);

    const idx = document.createElement('span');
    idx.className = 'interval-index';
    idx.textContent = String(i + 1);

    const mk = (cls, value, label, max) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.inputMode = 'numeric';
      inp.className = `num ${cls}`;
      inp.value = String(value);
      inp.min = '0';
      inp.max = String(max);
      inp.setAttribute('aria-label', `Interval ${i + 1} ${label}`);
      return inp;
    };

    const w = mk('num-w', step.watts, 'power in watts', 3000);
    w.step = '5';
    const s = mk('num-t', Math.round(step.seconds), 'duration in seconds', 7200);

    const unit = (t) => {
      const u = document.createElement('span');
      u.className = 'unit';
      u.textContent = t;
      return u;
    };

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-remove';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', `Remove interval ${i + 1}`);
    del.disabled = ui.set.length <= 1;
    del.addEventListener('click', () => {
      ui.set.splice(i, 1);
      renderIntervals();
      rebuildPlan();
    });

    const clamp = (v, hi) => Math.max(0, Math.min(hi, Math.round(+v) || 0));
    const commit = () => {
      ui.set[i] = { watts: clamp(w.value, 3000), seconds: clamp(s.value, 7200) };
      rebuildPlan();
      row.style.setProperty('--blk', `var(--${zoneFor(ui.set[i].watts, ui.ftp).key})`);
    };
    for (const inp of [w, s]) inp.addEventListener('input', commit);

    row.append(idx, w, unit('W'), s, unit('s'), del);
    el.intervals.append(row);
  });
}

function addInterval() {
  const last = ui.set[ui.set.length - 1];
  ui.set.push(last ? { ...last } : { watts: 150, seconds: 60 });
  renderIntervals();
  rebuildPlan();
  el.intervals.lastElementChild?.querySelector('.num-w')?.focus();
}

// --- plan and profile ------------------------------------------------------
function rebuildPlan() {
  try {
    ui.repeat = Math.max(1, Math.min(99, parseInt(el.repeatInput.value, 10) || 1));
    ui.ftp = Math.max(50, parseInt(el.ftpInput.value, 10) || 250);

    const usable = ui.set.filter((s) => s.seconds > 0);
    if (!usable.length) throw new Error('Give at least one interval a duration.');

    ui.plan = repeatSet(usable, ui.repeat);
    el.configError.hidden = true;
    const secs = planTotal(ui.plan);
    const n = ui.plan.length;
    el.planSummary.textContent =
      `${n} interval${n === 1 ? '' : 's'} · ${formatDuration(secs)} · ${planWorkKj(ui.plan).toFixed(1)} kJ`;
    el.profileTotal.textContent = formatDuration(secs);
    renderProfile();
    if (!session?.running) renderIdle();
    setTransport();
    save();
    renderPicker();
    return true;
  } catch (err) {
    el.configError.textContent = err.message;
    el.configError.hidden = false;
    el.startBtn.disabled = true;
    return false;
  }
}

function renderProfile() {
  el.profile.replaceChildren();
  ui.blocks = [];
  const peak = Math.max(...ui.plan.map((s) => s.watts), 1);
  for (const step of ui.plan) {
    const b = document.createElement('div');
    b.className = 'profile-block';
    b.style.flexGrow = String(step.seconds);
    b.style.height = `${Math.max(6, (step.watts / peak) * 100)}%`;
    b.style.setProperty('--blk', `var(--${zoneFor(step.watts, ui.ftp).key})`);
    el.profile.append(b);
    ui.blocks.push(b);
  }
}

function markProfile(index) {
  ui.blocks.forEach((b, i) => {
    b.dataset.state = i < index ? 'done' : i === index ? 'current' : 'upcoming';
  });
}

const applyZone = (node, watts) => { node.dataset.zone = zoneFor(watts, ui.ftp).key; };

function renderIdle() {
  const first = ui.plan[0];
  if (!first) return;
  applyZone(el.nowCard, first.watts);
  el.targetW.textContent = first.watts;
  el.countdown.textContent = formatClock(first.seconds);
  el.zoneLabel.textContent = zoneFor(first.watts, ui.ftp).name;
  el.intervalFill.style.width = '0%';
  el.intervalCount.textContent = `—/${ui.plan.length}`;
  el.elapsed.textContent = '0:00';
  showNext(ui.plan[1] ?? null, null);
}

function showNext(step, secondsUntil) {
  if (!step) {
    el.nextW.textContent = '—';
    el.nextDur.textContent = 'finish';
    el.nextIn.textContent = 'last interval';
    el.nextCard.dataset.zone = el.nowCard.dataset.zone;
    return;
  }
  applyZone(el.nextCard, step.watts);
  el.nextW.textContent = step.watts;
  el.nextDur.textContent = formatDuration(step.seconds);
  el.nextIn.textContent = secondsUntil === null ? '' : `in ${formatClock(secondsUntil)}`;
}

// --- session wiring -------------------------------------------------------
function buildSession() {
  session = new RideSession(trainer, { plan: ui.plan });

  session.addEventListener('log', (e) => log(e.detail.message, e.detail.level));

  session.addEventListener('interval', (e) => {
    const { index, step } = e.detail;
    applyZone(el.nowCard, step.watts);
    el.targetW.textContent = step.watts;
    el.zoneLabel.textContent = zoneFor(step.watts, ui.ftp).name;
    el.intervalCount.textContent = `${index + 1}/${ui.plan.length}`;
    markProfile(index);
    el.nowCard.dataset.pulse = '1';
    setTimeout(() => { el.nowCard.dataset.pulse = '0'; }, 560);
  });

  session.addEventListener('tick', (e) => {
    const t = e.detail;
    el.countdown.textContent = formatClock(t.remaining);
    el.intervalFill.style.width = `${t.progress * 100}%`;
    el.elapsed.textContent = formatClock(t.elapsed);
    showNext(t.next, t.nextIn);
  });

  session.addEventListener('state', setTransport);

  session.addEventListener('finished', () => {
    releaseWakeLock();
    markProfile(ui.plan.length);
    el.countdown.textContent = '0:00';
    el.intervalFill.style.width = '0%';
    // The trainer stays connected so another ride can start without re-pairing.
  });

  return session;
}

function setTransport() {
  const running = !!session?.running;
  const paused = !!session?.paused;
  el.startBtn.disabled = running || !trainer.connected || !ui.plan.length;
  el.pauseBtn.disabled = !running;
  el.stopBtn.disabled = !running;
  el.pauseBtn.textContent = paused ? 'Resume' : 'Pause';
}

// --- wake lock ------------------------------------------------------------
async function requestWakeLock() {
  try {
    ui.wakeLock = await navigator.wakeLock?.request('screen');
    if (ui.wakeLock) {
      el.wakeState.hidden = false;
      ui.wakeLock.addEventListener('release', () => { el.wakeState.hidden = true; });
    }
  } catch { /* not fatal */ }
  try { navigator.bluetooth?.setScreenDimEnabled?.(true); } catch { /* Bluefy only */ }
}

function releaseWakeLock() {
  try { ui.wakeLock?.release(); } catch { /* ignore */ }
  ui.wakeLock = null;
  el.wakeState.hidden = true;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session?.running && !session.paused) {
    requestWakeLock();
  }
});

// --- diagnosis ------------------------------------------------------------
function diagnose(err) {
  const name = err.name || '';
  if (name === 'NotFoundError' && /cancell?ed/i.test(err.message)) {
    showNotice('No trainer chosen', 'The device chooser was dismissed before a trainer was picked.');
  } else if (name === 'NotFoundError') {
    showNotice('No trainer in the chooser',
      'Nothing advertising the Fitness Machine service turned up.',
      'Spin the cranks to wake the trainer, and make sure nothing else holds it — '
      + 'it accepts one BLE connection at a time.');
  } else if (name === 'SecurityError') {
    showNotice('Blocked by the browser', err.message,
      'Web Bluetooth needs a secure context: HTTPS, or localhost.');
  } else if (name === 'NetworkError') {
    showNotice('Connection dropped during setup', err.message,
      'Usually the trainer is already connected elsewhere. Disconnect it there and retry.');
  } else if (name === 'NotSupportedError') {
    showNotice('No Web Bluetooth here', err.message, 'Use Chrome or Edge on desktop, or Bluefy on iOS.');
  } else {
    showNotice("Couldn't connect", `${name}: ${err.message}`);
  }
  el.log.closest('details').open = true;
}

// --- events ---------------------------------------------------------------
el.connectBtn.addEventListener('click', async () => {
  if (trainer.connected) { await trainer.disconnect(); return; }
  el.dot.dataset.state = 'busy';
  try {
    await trainer.connect();
  } catch (err) {
    el.dot.dataset.state = 'err';
    log(`${err.name || 'Error'}: ${err.message}`, 'bad');
    diagnose(err);
  }
});

trainer.addEventListener('connected', (e) => {
  clearNotice();
  el.dot.dataset.state = 'on';
  el.deviceName.textContent = e.detail.name;
  el.connectBtn.textContent = 'Disconnect';
  setTransport();
});

trainer.addEventListener('disconnected', () => {
  el.dot.dataset.state = 'off';
  el.deviceName.textContent = 'No trainer';
  el.connectBtn.textContent = 'Connect trainer';
  if (session?.running) session.stop('Ride stopped — the trainer dropped its connection.', 'bad');
  setTransport();
});

trainer.addEventListener('telemetry', (e) => {
  el.actualW.textContent = e.detail.powerW ?? '—';
  el.cadence.textContent = e.detail.cadenceRpm != null ? Math.round(e.detail.cadenceRpm) : '—';
});

el.startBtn.addEventListener('click', async () => {
  if (!rebuildPlan() || !trainer.connected) return;
  el.configPanel.open = false;
  buildSession().start();
  await requestWakeLock();
  log(`Ride started — ${ui.plan.length} intervals, ${formatDuration(planTotal(ui.plan))}.`, 'good');
});

el.pauseBtn.addEventListener('click', () => {
  if (!session) return;
  (session.paused ? session.resume() : session.pause()).catch((e) => log(e.message, 'bad'));
});

el.stopBtn.addEventListener('click', () => session?.stop());
el.noticeClose.addEventListener('click', clearNotice);

el.workoutPicker.addEventListener('change', () => {
  if (session?.running) return;
  const slug = el.workoutPicker.value;
  if (!slug) { renderPicker(); return; }      // "unsaved" is a label, not a destination
  applyWorkout(Workouts.get(slug));
});

el.saveWorkout.addEventListener('click', () => {
  const name = el.workoutName.value.trim();
  if (!name) {
    note('Give the workout a name first.', '');
    el.workoutName.focus();
    return;
  }
  const saved = Workouts.save({ name, set: ui.set, repeat: ui.repeat });
  if (!saved) { note('Could not save — browser storage is unavailable.'); return; }
  ui.slug = saved.slug;
  ui.name = saved.name;
  setRoute(saved.slug);
  save();
  renderPicker();
  note(`Saved “${saved.name}”.`, 'good');
});

el.deleteWorkout.addEventListener('click', () => {
  if (!ui.slug) return;
  const gone = ui.name;
  Workouts.remove(ui.slug);
  ui.slug = null;
  setRoute(null);
  save();
  renderPicker();
  note(`Deleted “${gone}”. The intervals are still loaded.`);
});

el.workoutName.addEventListener('input', () => { ui.name = el.workoutName.value; save(); });

window.addEventListener('popstate', () => {
  if (session?.running) return;
  const slug = routeSlug();
  const w = slug ? Workouts.get(slug) : null;
  if (w) applyWorkout(w, { push: false });
});

el.addInterval.addEventListener('click', () => { if (!session?.running) addInterval(); });

el.repeatInput.addEventListener('input', () => { if (!session?.running) rebuildPlan(); });

el.ftpInput.addEventListener('input', () => {
  if (session?.running) return;
  rebuildPlan();
  renderIntervals();   // zone stripes follow FTP
});

window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled: ${e.reason?.message ?? e.reason}`, 'bad');
});

// --- boot -----------------------------------------------------------------
const restored = load();
const routed = routeSlug() ? Workouts.get(routeSlug()) : null;

if (routed) {
  // A /workout/<slug> URL is an explicit request; it beats the last-used state.
  ui.set = routed.set.map((s) => ({ ...s }));
  ui.repeat = routed.repeat;
  ui.slug = routed.slug;
  ui.name = routed.name;
} else if (!restored) {
  const first = Workouts.PRESETS[0];
  ui.set = first.set.map((s) => ({ ...s }));
  ui.repeat = first.repeat;
  ui.slug = first.slug;
  ui.name = first.name;
  ui.ftp = 250;
}

// Held until after the first render, which rebuilds the picker and its note.
const bootNote = (!routed && routeSlug())
  ? `No workout called “${routeSlug()}”. Showing the last one you used.`
  : null;
if (bootNote) setRoute(ui.slug, { replace: true });

el.repeatInput.value = String(ui.repeat);
el.ftpInput.value = String(ui.ftp);
el.workoutName.value = ui.name;
renderIntervals();
rebuildPlan();
if (ui.slug && !routed && !bootNote) setRoute(ui.slug, { replace: true });
if (bootNote) note(bootNote);
setTransport();

if (useMock) {
  log(`Simulator mode (${mockMode === 'gatt' ? 'byte-level, real FTMS driver' : 'controller-level'})`
    + ` — no hardware. stickRate=${stickRate}`, 'warn');
  el.deviceName.textContent = 'Simulator (not connected)';
}

if (!useMock && !new WebBluetoothTransport().isAvailable()) {
  showNotice('No Web Bluetooth here', 'This browser cannot talk to Bluetooth devices.',
    'Use Chrome or Edge on desktop, or Bluefy on iOS. Safari does not support it.');
}

if ('serviceWorker' in navigator) {
  // Explicit base: the page may be at /workout/<slug>, where 'sw.js' would miss.
  navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
    .catch(() => { /* absent in Bluefy */ });
}

// Handy from the console.
window.hammer = {
  trainer, get session() { return session; }, ui, rebuildPlan, Workouts, applyWorkout,
};
