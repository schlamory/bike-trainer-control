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
  parseSteps, parseDuration, buildPlan, planTotal, planWorkKj,
  formatClock, formatDuration, zoneFor,
} from './core/workout.js';

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
  stepsInput: $('stepsInput'), durationInput: $('durationInput'), ftpInput: $('ftpInput'),
  onceInput: $('onceInput'), planSummary: $('planSummary'), configError: $('configError'),
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
const ui = { plan: [], ftp: 250, blocks: [], wakeLock: null };

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

// --- plan and profile -----------------------------------------------------
function rebuildPlan() {
  try {
    const steps = parseSteps(el.stepsInput.value);
    const once = el.onceInput.checked;
    const total = once ? null : parseDuration(el.durationInput.value);
    ui.plan = buildPlan(steps, total, { once });
    ui.ftp = Math.max(50, parseInt(el.ftpInput.value, 10) || 250);
    el.configError.hidden = true;
    const secs = planTotal(ui.plan);
    el.planSummary.textContent =
      `${ui.plan.length} intervals · ${formatDuration(secs)} · ${planWorkKj(ui.plan).toFixed(1)} kJ`;
    el.profileTotal.textContent = formatDuration(secs);
    renderProfile();
    if (!session?.running) renderIdle();
    setTransport();
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

for (const input of [el.stepsInput, el.durationInput, el.ftpInput]) {
  input.addEventListener('input', () => { if (!session?.running) rebuildPlan(); });
}
el.onceInput.addEventListener('change', () => { if (!session?.running) rebuildPlan(); });

window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled: ${e.reason?.message ?? e.reason}`, 'bad');
});

// --- boot -----------------------------------------------------------------
rebuildPlan();
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
  navigator.serviceWorker.register('sw.js').catch(() => { /* absent in Bluefy */ });
}

// Handy from the console.
window.hammer = { trainer, get session() { return session; }, ui, rebuildPlan };
