/**
 * Named workouts: built-in presets plus whatever the rider saves.
 *
 * A workout is an ordered list of SETS. Each set is a list of intervals and a
 * repeat count, so a warm-up is a one-interval set played once, and a main
 * block is a two-interval set played seven times. Sets play in order.
 *
 * Storage is localStorage rather than sessionStorage — sessionStorage is wiped
 * when the tab closes, which would defeat the point of coming back to a
 * workout between rides. It is still per-browser and per-origin, so it is
 * convenience, not durable storage: a cleared cache loses saved workouts.
 * Built-ins are code, so they always survive.
 */

const STORE = 'hammer.workouts.v1';

const iv = (watts, seconds) => ({ watts, seconds });

/** Presets are absolute watts, sized around a 250 W FTP. */
export const PRESETS = [
  {
    slug: 'sprints',
    name: 'Sprints 75/230',
    sets: [{ intervals: [iv(75, 60), iv(230, 20)], repeat: 7 }],
  },
  {
    slug: 'vo2-30-30',
    name: 'VO2 30/30',
    sets: [
      { intervals: [iv(120, 300)], repeat: 1 },
      { intervals: [iv(300, 30), iv(100, 30)], repeat: 10 },
      { intervals: [iv(90, 300)], repeat: 1 },
    ],
  },
  {
    slug: 'threshold-2x10',
    name: 'Threshold 2×10',
    sets: [
      { intervals: [iv(130, 480)], repeat: 1 },
      { intervals: [iv(235, 600), iv(110, 300)], repeat: 2 },
      { intervals: [iv(95, 300)], repeat: 1 },
    ],
  },
  {
    slug: 'recovery',
    name: 'Recovery spin',
    sets: [{ intervals: [iv(100, 1200)], repeat: 1 }],
  },
];

export function slugify(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workout';
}

function readAll() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    localStorage.setItem(STORE, JSON.stringify(map));
    return true;
  } catch {
    return false;   // private mode or quota; the ride still works
  }
}

const cleanInterval = (s) => ({
  watts: Math.max(0, Math.min(3000, Math.round(+s.watts) || 0)),
  seconds: Math.max(0, Math.min(7200, Math.round(+s.seconds) || 0)),
});

const cleanSet = (s) => ({
  intervals: (s.intervals || []).map(cleanInterval),
  repeat: Math.max(1, Math.min(99, Math.round(+s.repeat) || 1)),
});

/** Accepts the pre-sets shape ({set, repeat}) so saved workouts survive. */
export function normalise(w) {
  const sets = Array.isArray(w.sets) && w.sets.length
    ? w.sets.map(cleanSet)
    : [cleanSet({ intervals: w.set || [], repeat: w.repeat })];
  return {
    slug: w.slug,
    name: w.name,
    sets: sets.filter((s) => s.intervals.length),
    saved: !!w.saved,
  };
}

export function list() {
  const saved = Object.values(readAll())
    .map((w) => normalise({ ...w, saved: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shadowed = new Set(saved.map((w) => w.slug));
  const presets = PRESETS.filter((p) => !shadowed.has(p.slug)).map((p) => normalise(p));
  return { saved, presets };
}

export function get(slug) {
  if (!slug) return null;
  const stored = readAll()[slug];
  if (stored) return normalise({ ...stored, saved: true });
  const preset = PRESETS.find((p) => p.slug === slug);
  return preset ? normalise(preset) : null;
}

export function save({ name, sets }) {
  const slug = slugify(name);
  const map = readAll();
  map[slug] = {
    slug,
    name: String(name).trim().slice(0, 60) || slug,
    sets: sets.map(cleanSet),
  };
  return writeAll(map) ? normalise({ ...map[slug], saved: true }) : null;
}

export function remove(slug) {
  const map = readAll();
  if (!(slug in map)) return false;
  delete map[slug];
  return writeAll(map);
}

/** Does a saved or preset workout still match what is on screen? */
export function matches(workout, sets) {
  if (!workout || workout.sets.length !== sets.length) return false;
  return workout.sets.every((s, i) => {
    const o = sets[i];
    if (!o || s.repeat !== o.repeat || s.intervals.length !== o.intervals.length) return false;
    return s.intervals.every((x, j) =>
      x.watts === o.intervals[j].watts && x.seconds === o.intervals[j].seconds);
  });
}
