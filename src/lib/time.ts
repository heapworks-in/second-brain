export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The local calendar day an instant falls on, as `YYYY-MM-DD`. It lives here, with no imports
 * of its own, because both sides need it: the domain reads stored UTC instants as local days,
 * and client components label those same instants. A `slice(0, 10)` gives the UTC day instead,
 * which east of UTC is a different day for anything in the small hours.
 */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * The instant local midnight began, as a UTC ISO string -- what a stored `nowIso()` timestamp
 * has to be compared against to mean "today".
 *
 * `${localDay(x)}T00:00:00.000Z` is the mistake this exists to prevent: it labels a local
 * midnight as a UTC one, so east of UTC everything decided between local midnight and UTC
 * midnight reads as yesterday. That was 5.5 hours of every day here, and it was found at 00:02.
 */
export function startOfLocalDay(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}
