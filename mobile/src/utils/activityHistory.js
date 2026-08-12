import { api } from '../services/api';

/**
 * Shared data-fetching/grouping for the three Home summary-tile drill-downs
 * (HistoryScreen "Dealers visited", DistanceHistoryScreen "Distance
 * travelled", WorkingHoursScreen "Working hours") — all three group the same
 * two backend lists by business day, they just each emphasize a different
 * field of the same per-day section in their own UI.
 */

// Mirrors backend/src/utils/businessDay.js's default: the field-sales "day"
// rolls over at 5am IST, not calendar midnight, so a visit/attendance row
// logged between midnight and 5am IST still belongs to the PREVIOUS
// business day's session. Grouping by plain calendar date (as this used to)
// split that session's own visits off into a dateless, attendance-less
// section of their own — exactly the "visit with no matching attendance
// row" gap this mirrors businessDay.js to close. Computed in UTC math (not
// device-local time) so it's correct regardless of the device's own
// timezone setting.
const DAY_BOUNDARY_HOUR = 5;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// The business-day date for a timestamp, expressed as a UTC-midnight Date
// so callers can compare/format it without any further timezone shifting.
function businessDate(iso) {
  if (!iso) return null;
  const utcMs = new Date(iso).getTime();
  if (Number.isNaN(utcMs)) return null;
  const shifted = new Date(utcMs + IST_OFFSET_MS - DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function businessDateKey(iso) {
  const d = businessDate(iso);
  return d ? d.toISOString() : 'Unknown';
}

export function formatDateHeading(iso) {
  const d = businessDate(iso);
  if (!d) return 'Unknown';
  const today = businessDate(new Date().toISOString());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  if (d.getTime() === today.getTime()) return 'Today';
  if (d.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
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
 * Groups attendance days and dealer visits by business day (5am IST
 * rollover — see businessDate() above), newest first. Each section carries
 * the day's totals (dealersVisitedCount, distanceKm, durationMinutes) plus
 * the raw list of that day's visits, so callers can render whichever fields
 * matter for their screen.
 * @param {object[]} attendanceDays
 * @param {object[]} visits
 * @returns {Array<{heading: string, attendance: object|null, visits: object[],
 *   dealersVisitedCount: number, distanceKm: number, durationMinutes: number}>}
 */
export function groupActivityByDay(attendanceDays, visits) {
  const byDate = new Map();

  const getSection = (iso) => {
    const key = businessDateKey(iso);
    if (!byDate.has(key)) {
      byDate.set(key, { heading: formatDateHeading(iso), sortDate: businessDate(iso), attendance: null, visits: [] });
    }
    return byDate.get(key);
  };

  attendanceDays.forEach((a) => {
    getSection(a.login_time).attendance = a;
  });

  visits.forEach((v) => {
    getSection(v.login_time).visits.push(v);
  });

  return Array.from(byDate.values())
    .sort((a, b) => (b.sortDate?.getTime() ?? 0) - (a.sortDate?.getTime() ?? 0))
    .map(({ sortDate, ...section }) => {
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
