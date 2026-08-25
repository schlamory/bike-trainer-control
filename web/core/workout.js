// Workout authoring: a power/time series in, a plan of intervals out.
// Syntax matches workout.py so a plan can move between the CLI and the PWA.

export function parseDuration(text) {
  const m = String(text).trim().toLowerCase()
    .match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/);
  if (!m) throw new Error(`bad duration: "${text}"`);
  const mult = { s: 1, sec: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600, hr: 3600, hrs: 3600 };
  return parseFloat(m[1]) * mult[m[2] || 's'];
}

export function parseSteps(text) {
  const steps = [];
  for (const chunk of String(text).split(',')) {
    const c = chunk.trim();
    if (!c) continue;
    const m = c.match(/^(\d+)\s*w?\s*[/@x:]\s*(.+)$/i);
    if (!m) throw new Error(`bad step "${c}" — expected e.g. 75w/60s`);
    steps.push({ watts: parseInt(m[1], 10), seconds: parseDuration(m[2]) });
  }
  if (!steps.length) throw new Error('no intervals given');
  return steps;
}

// Repeat the pattern until `total` seconds, truncating the final step to fit.
export function buildPlan(steps, total, { once = false } = {}) {
  if (once || !total) return steps.map((s) => ({ ...s }));
  const plan = [];
  let elapsed = 0;
  let i = 0;
  while (elapsed < total - 1e-9 && plan.length < 10000) {
    const s = steps[i % steps.length];
    const seconds = Math.min(s.seconds, total - elapsed);
    plan.push({ watts: s.watts, seconds });
    elapsed += seconds;
    i += 1;
  }
  return plan;
}

/** Play a set of intervals through N times. */
export function repeatSet(steps, times) {
  const out = [];
  const n = Math.max(1, Math.floor(times) || 1);
  for (let i = 0; i < n; i++) out.push(...steps.map((s) => ({ ...s })));
  return out;
}

/**
 * Flatten a workout's sets into the flat interval list the ride loop walks.
 * Each set contributes its intervals repeated, and sets play in order — so a
 * warm-up set, a repeated main set and a cool-down set become one sequence.
 */
export function buildFromSets(sets) {
  const plan = [];
  for (const s of sets) {
    const usable = (s.intervals || []).filter((i) => i.seconds > 0);
    if (usable.length) plan.push(...repeatSet(usable, s.repeat));
  }
  return plan;
}

/** Seconds a single set contributes, repeats included. */
export function setDuration(s) {
  const per = (s.intervals || []).reduce((a, i) => a + (i.seconds > 0 ? i.seconds : 0), 0);
  return per * Math.max(1, Math.floor(s.repeat) || 1);
}

export function planTotal(plan) {
  return plan.reduce((a, s) => a + s.seconds, 0);
}

export function planWorkKj(plan) {
  return plan.reduce((a, s) => a + s.watts * s.seconds, 0) / 1000;
}

// Where are we at `t` seconds in? Returns the interval index and time within it.
export function locate(plan, t) {
  let acc = 0;
  for (let i = 0; i < plan.length; i++) {
    if (t < acc + plan[i].seconds) {
      return { index: i, into: t - acc, remaining: acc + plan[i].seconds - t, start: acc };
    }
    acc += plan[i].seconds;
  }
  return null; // past the end
}

export function formatClock(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDuration(sec) {
  sec = Math.round(sec);
  return sec >= 60 ? `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
}

// --- power zones -----------------------------------------------------------
// Coggan zones, used here to drive colour so intensity is readable peripherally.
export const ZONES = [
  { key: 'z1', name: 'Recovery',  max: 0.55 },
  { key: 'z2', name: 'Endurance', max: 0.75 },
  { key: 'z3', name: 'Tempo',     max: 0.90 },
  { key: 'z4', name: 'Threshold', max: 1.05 },
  { key: 'z5', name: 'VO2 max',   max: Infinity },
];

export function zoneFor(watts, ftp) {
  const frac = watts / (ftp || 250);
  return ZONES.find((z) => frac <= z.max) ?? ZONES[ZONES.length - 1];
}
