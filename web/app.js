import { Trainer } from './trainer.js';
import { stop as ftmsStop, Op } from './ftms.js';
import {
  parseSteps, parseDuration, buildPlan, planTotal, planWorkKj,
  locate, formatClock, formatDuration, zoneFor,
} from './workout.js';

const $ = (id) => document.getElementById(id);

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

function showNotice(title, text, hint = null) {
  el.noticeTitle.textContent = title;
  el.noticeText.textContent = text;
  el.noticeHint.textContent = hint ?? '';
  el.noticeHint.hidden = !hint;
  el.notice.hidden = false;
}

function clearNotice() { el.notice.hidden = true; }

const trainer = new Trainer();

const state = {
  plan: [],
  ftp: 250,
  running: false,
  paused: false,
  elapsed: 0,        // seconds into the workout
  lastTickAt: null,
  currentIndex: -1,
  wakeLock: null,
  blocks: [],
};

// --- logging ---------------------------------------------------------------
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

// --- plan ------------------------------------------------------------------
function rebuildPlan() {
  try {
    const steps = parseSteps(el.stepsInput.value);
    const once = el.onceInput.checked;
    const total = once ? null : parseDuration(el.durationInput.value);
    state.plan = buildPlan(steps, total, { once });
    state.ftp = Math.max(50, parseInt(el.ftpInput.value, 10) || 250);
    el.configError.hidden = true;
    const secs = planTotal(state.plan);
    el.planSummary.textContent =
      `${state.plan.length} intervals · ${formatDuration(secs)} · ${planWorkKj(state.plan).toFixed(1)} kJ`;
    el.profileTotal.textContent = formatDuration(secs);
    renderProfile();
    if (!state.running) renderIdle();
    el.startBtn.disabled = !trainer.connected;
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
  state.blocks = [];
  const peak = Math.max(...state.plan.map((s) => s.watts), 1);
  for (const step of state.plan) {
    const b = document.createElement('div');
    b.className = 'profile-block';
    b.style.flexGrow = String(step.seconds);
    b.style.height = `${Math.max(6, (step.watts / peak) * 100)}%`;
    b.style.setProperty('--blk', `var(--${zoneFor(step.watts, state.ftp).key})`);
    el.profile.append(b);
    state.blocks.push(b);
  }
}

function renderIdle() {
  const first = state.plan[0];
  if (!first) return;
  applyZone(el.nowCard, first.watts);
  el.targetW.textContent = first.watts;
  el.countdown.textContent = formatClock(first.seconds);
  el.zoneLabel.textContent = zoneFor(first.watts, state.ftp).name;
  el.intervalFill.style.width = '0%';
  el.intervalCount.textContent = `—/${state.plan.length}`;
  showNext(1, null);
}

function applyZone(node, watts) {
  node.dataset.zone = zoneFor(watts, state.ftp).key;
}

function showNext(index, secondsUntil) {
  const step = state.plan[index];
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

// --- ride loop -------------------------------------------------------------
async function tick() {
  if (!state.running || state.paused) return;

  const now = performance.now();
  state.elapsed += (now - state.lastTickAt) / 1000;
  state.lastTickAt = now;

  const pos = locate(state.plan, state.elapsed);
  if (!pos) return finish();

  if (pos.index !== state.currentIndex) {
    state.currentIndex = pos.index;
    const step = state.plan[pos.index];
    applyZone(el.nowCard, step.watts);
    el.targetW.textContent = step.watts;
    el.zoneLabel.textContent = zoneFor(step.watts, state.ftp).name;
    el.intervalCount.textContent = `${pos.index + 1}/${state.plan.length}`;
    pulse();
    markProfile(pos.index);
    trainer.setPower(step.watts).catch((e) => log(e.message, 'bad'));
  }

  const step = state.plan[pos.index];
  el.countdown.textContent = formatClock(pos.remaining);
  el.intervalFill.style.width = `${(pos.into / step.seconds) * 100}%`;
  el.elapsed.textContent = formatClock(state.elapsed);
  showNext(pos.index + 1, pos.remaining);
}

function pulse() {
  el.nowCard.dataset.pulse = '1';
  setTimeout(() => { el.nowCard.dataset.pulse = '0'; }, 560);
}

function markProfile(index) {
  state.blocks.forEach((b, i) => {
    b.dataset.state = i < index ? 'done' : i === index ? 'current' : 'upcoming';
  });
}

async function start() {
  if (!rebuildPlan() || !trainer.connected) return;
  state.running = true;
  state.paused = false;
  state.elapsed = 0;
  state.currentIndex = -1;
  state.lastTickAt = performance.now();
  el.configPanel.open = false;
  setTransport();
  await requestWakeLock();
  log(`Ride started — ${state.plan.length} intervals, ${formatDuration(planTotal(state.plan))}.`, 'good');
}

async function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;
  setTransport();
  if (state.paused) {
    const how = await trainer.pause();
    log(`Paused (${how === 'ftms-pause' ? 'FTMS pause' : '0 W hold'}).`);
  } else {
    state.lastTickAt = performance.now();
    const step = state.plan[state.currentIndex];
    await trainer.resume(step ? step.watts : 0);
    log('Resumed.');
  }
}

async function finish() {
  await endRide('Workout complete.', 'good');
}

async function endRide(message = 'Ride ended.', level = 'info') {
  state.running = false;
  state.paused = false;
  setTransport();
  releaseWakeLock();
  markProfile(state.plan.length);
  try {
    if (trainer.connected) await trainer.command(ftmsStop(), Op.STOP_PAUSE);
  } catch { /* best effort */ }
  log(message, level);
  el.countdown.textContent = '0:00';
  el.intervalFill.style.width = '0%';
}

function setTransport() {
  el.startBtn.disabled = state.running || !trainer.connected;
  el.pauseBtn.disabled = !state.running;
  el.stopBtn.disabled = !state.running;
  el.pauseBtn.textContent = state.paused ? 'Resume' : 'Pause';
}

// --- wake lock -------------------------------------------------------------
async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
    if (state.wakeLock) {
      el.wakeState.hidden = false;
      state.wakeLock.addEventListener('release', () => { el.wakeState.hidden = true; });
    }
  } catch { /* not fatal */ }
  // Bluefy ships a proprietary one; harmless elsewhere.
  try { navigator.bluetooth?.setScreenDimEnabled?.(true); } catch { /* ignore */ }
}

function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch { /* ignore */ }
  state.wakeLock = null;
  el.wakeState.hidden = true;
}

// Standard wake locks release whenever the page hides — re-acquire on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && !state.paused) requestWakeLock();
});

// --- wiring ----------------------------------------------------------------
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

// Turn the browser's terse Bluetooth errors into something actionable.
function diagnose(err) {
  const name = err.name || '';
  if (name === 'NotFoundError' && /cancell?ed/i.test(err.message)) {
    showNotice('No trainer chosen', 'The device chooser was dismissed before a trainer was picked.');
  } else if (name === 'NotFoundError') {
    showNotice(
      'No trainer in the chooser',
      'Nothing advertising the Fitness Machine service turned up.',
      'Spin the cranks to wake the H3, and make sure nothing else holds it — ' +
      'Zwift, the Saris app, or a Python script from this repo. It accepts one ' +
      'BLE connection at a time.');
  } else if (name === 'SecurityError') {
    showNotice('Blocked by the browser', err.message,
      'Web Bluetooth needs a secure context. Open the app over localhost, not a file:// path.');
  } else if (name === 'NetworkError') {
    showNotice('Connection dropped during setup', err.message,
      'Usually the trainer is already connected elsewhere. Disconnect it there and retry.');
  } else if (name === 'NotSupportedError' || !navigator.bluetooth) {
    showNotice('No Web Bluetooth here', 'This browser cannot talk to Bluetooth devices.',
      'Use Chrome or Edge on the desktop.');
  } else {
    showNotice("Couldn't connect", `${name}: ${err.message}`);
  }
  el.log.closest('details').open = true;
}

trainer.addEventListener('connected', (e) => {
  clearNotice();
  el.dot.dataset.state = 'on';
  el.deviceName.textContent = e.detail.name;
  el.connectBtn.textContent = 'Disconnect';
  setTransport();
  rebuildPlan();
});

trainer.addEventListener('disconnected', () => {
  el.dot.dataset.state = 'off';
  el.deviceName.textContent = 'No trainer';
  el.connectBtn.textContent = 'Connect trainer';
  if (state.running) {
    state.running = false;
    releaseWakeLock();
    log('Ride stopped — the trainer dropped its connection.', 'bad');
  }
  setTransport();
});

trainer.addEventListener('telemetry', (e) => {
  const d = e.detail;
  el.actualW.textContent = d.powerW ?? '—';
  el.cadence.textContent = d.cadenceRpm != null ? Math.round(d.cadenceRpm) : '—';
});

el.noticeClose.addEventListener('click', clearNotice);

window.addEventListener('unhandledrejection', (e) => {
  log(`Unhandled: ${e.reason?.message ?? e.reason}`, 'bad');
});

el.startBtn.addEventListener('click', start);
el.pauseBtn.addEventListener('click', togglePause);
el.stopBtn.addEventListener('click', () => endRide());

for (const input of [el.stepsInput, el.durationInput, el.ftpInput]) {
  input.addEventListener('input', () => { if (!state.running) rebuildPlan(); });
}
el.onceInput.addEventListener('change', () => { if (!state.running) rebuildPlan(); });

// Handy from the console: hammer.state, hammer.trainer, hammer.simulate(60)
window.hammer = { state, trainer, rebuildPlan, tick,
  simulate(t) { state.running = true; state.elapsed = t; state.lastTickAt = performance.now(); tick(); } };

setInterval(tick, 100);
rebuildPlan();
setTransport();

if (!navigator.bluetooth) {
  showNotice('No Web Bluetooth here', 'This browser cannot talk to Bluetooth devices.',
    'Use Chrome or Edge on the desktop.');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
}
