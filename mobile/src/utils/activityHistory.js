import { api } from '../services/api';

/**
 * Shared data-fetching/grouping for the three Home summary-tile drill-downs
 * (HistoryScreen "Dealers visited", DistanceHistoryScreen "Distance
 * travelled", WorkingHoursScreen "Working hours") — all three group the same
 * two backend lists by calendar day, they just each emphasize a different
 * field of the same per-day section in their own UI.
 */

export function formatDateHeading(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

export function formatDuration(minutes) {
  if (!minutes || minutes < 1) return '0h 0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/**
 * @returns {Promise<{attendanceDays: object[], visits: object[]}>}
 */
export async function fetchActivityData() {
  const [attendanceRes, visitsRes] = await Promise.all([
    api.get('/attendance'),
    api.get('/visits'),
  ]);
  return {
    attendanceDays: attendanceRes.data.attendance || [],
    visits: visitsRes.data.visits || [],
  };
}

/**
 * Groups attendance days and dealer visits by calendar date, newest first.
 * Each section carries the day's totals (dealersVisitedCount, distanceKm,
 * durationMinutes) plus the raw list of that day's visits, so callers can
 * render whichever fields matter for their screen.
 * @param {object[]} attendanceDays
 * @param {object[]} visits
 * @returns {Array<{heading: string, attendance: object|null, visits: object[],
 *   dealersVisitedCount: number, distanceKm: number, durationMinutes: number}>}
 */
export function groupActivityByDay(attendanceDays, visits) {
  const dayKey = (iso) => (iso ? new Date(iso).toDateString() : 'Unknown');
  const byDate = new Map();

  attendanceDays.forEach((a) => {
    const key = dayKey(a.login_time);
    byDate.set(key, { heading: formatDateHeading(a.login_time), attendance: a, visits: [] });
  });

  visits.forEach((v) => {
    const key = dayKey(v.login_time);
    if (!byDate.has(key)) {
      byDate.set(key, { heading: formatDateHeading(v.login_time), attendance: null, visits: [] });
    }
    byDate.get(key).visits.push(v);
  });

  return Array.from(byDate.entries())
    .sort(([a], [b]) => new Date(b) - new Date(a))
    .map(([, section]) => {
      const dealersVisitedCount = new Set(section.visits.map((v) => v.dealer_id)).size;
      // Falls back to summing visit-to-visit distance when there's no
      // attendance row for the day (shouldn't normally happen, but a visit
      // record without a matching attendance row is still worth showing).
      const distanceKm = section.attendance
        ? parseFloat(section.attendance.total_distance_km || 0)
        : section.visits.reduce((sum, v) => sum + parseFloat(v.distance_from_previous_km || 0), 0);
      const durationMinutes = section.attendance?.total_duration_minutes || 0;

      return { ...section, dealersVisitedCount, distanceKm, durationMinutes };
    });
}
