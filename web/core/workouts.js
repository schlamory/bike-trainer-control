/**
 * Named workouts: built-in presets plus whatever the rider saves.
 *
 * Storage is localStorage rather than sessionStorage — sessionStorage is wiped
 * when the tab closes, which would defeat the point of coming back to a
 * workout between rides. It is still per-browser and per-origin, so it is
 * convenience, not durable storage: a cleared cache loses saved workouts.
 * Built-ins are code, so they always survive.
 */

const STORE = 'hammer.workouts.v1';

/** Presets are absolute watts, sized around a 250 W FTP. */
export const PRESETS = [
  {
    slug: 'sprints',
    name: 'Sprints 75/230',
    set: [{ watts: 75, seconds: 60 }, { watts: 230, seconds: 20 }],
    repeat: 7,
  },
  {
    slug: 'vo2-30-30',
    name: 'VO2 30/30',
    set: [{ watts: 300, seconds: 30 }, { watts: 100, seconds: 30 }],
    repeat: 10,
  },
  {
    slug: 'threshold-2x10',
    name: 'Threshold 2×10',
    set: [{ watts: 235, seconds: 600 }, { watts: 110, seconds: 300 }],
    repeat: 2,
  },
  {
    slug: 'recovery',
    name: 'Recovery spin',
    set: [{ watts: 100, seconds: 1200 }],
    repeat: 1,
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

const clean = (w) => ({
  slug: w.slug,
  name: w.name,
  set: (w.set || []).map((s) => ({ watts: +s.watts || 0, seconds: +s.seconds || 0 })),
  repeat: Math.max(1, Math.min(99, +w.repeat || 1)),
  saved: !!w.saved,
});

/** Saved workouts first, then any preset the rider has not shadowed. */
export function list() {
  const saved = Object.values(readAll())
    .map((w) => clean({ ...w, saved: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const shadowed = new Set(saved.map((w) => w.slug));
  const presets = PRESETS.filter((p) => !shadowed.has(p.slug)).map((p) => clean(p));
  return { saved, presets };
}

export function get(slug) {
  if (!slug) return null;
  const stored = readAll()[slug];
  if (stored) return clean({ ...stored, saved: true });
  const preset = PRESETS.find((p) => p.slug === slug);
  return preset ? clean(preset) : null;
}

export function save({ name, set, repeat }) {
  const slug = slugify(name);
  const map = readAll();
  map[slug] = { slug, name: String(name).trim().slice(0, 60) || slug, set, repeat };
  const ok = writeAll(map);
  return ok ? clean({ ...map[slug], saved: true }) : null;
}

export function remove(slug) {
  const map = readAll();
  if (!(slug in map)) return false;
  delete map[slug];
  return writeAll(map);
}

/** Does a saved or preset workout differ from what is currently on screen? */
export function matches(workout, set, repeat) {
  if (!workout) return false;
  if (workout.repeat !== repeat) return false;
  if (workout.set.length !== set.length) return false;
  return workout.set.every((s, i) => s.watts === set[i].watts && s.seconds === set[i].seconds);
}
