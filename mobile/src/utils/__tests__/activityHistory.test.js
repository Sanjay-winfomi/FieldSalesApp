import { groupActivityByDay, formatDuration } from '../activityHistory';

describe('groupActivityByDay', () => {
  test('groups visits under the matching attendance day and computes totals', () => {
    const attendanceDays = [
      { login_time: '2026-08-10T04:30:00Z', total_distance_km: 12.4, total_duration_minutes: 320 },
    ];
    const visits = [
      { id: 1, dealer_id: 10, login_time: '2026-08-10T05:00:00Z', distance_from_previous_km: 2 },
      { id: 2, dealer_id: 11, login_time: '2026-08-10T06:00:00Z', distance_from_previous_km: 1.5 },
    ];

    const sections = groupActivityByDay(attendanceDays, visits);

    expect(sections).toHaveLength(1);
    expect(sections[0].dealersVisitedCount).toBe(2);
    expect(sections[0].distanceKm).toBe(12.4); // from attendance, not summed visit distances
    expect(sections[0].durationMinutes).toBe(320);
    expect(sections[0].visits).toHaveLength(2);
  });

  test('counts the same dealer visited twice in one day as one dealer', () => {
    const visits = [
      { id: 1, dealer_id: 10, login_time: '2026-08-10T05:00:00Z' },
      { id: 2, dealer_id: 10, login_time: '2026-08-10T09:00:00Z' },
    ];
    const sections = groupActivityByDay([], visits);
    expect(sections[0].dealersVisitedCount).toBe(1);
  });

  test('falls back to summing visit distances when there is no attendance row for the day', () => {
    const visits = [
      { id: 1, dealer_id: 10, login_time: '2026-08-10T05:00:00Z', distance_from_previous_km: 3 },
      { id: 2, dealer_id: 11, login_time: '2026-08-10T06:00:00Z', distance_from_previous_km: '2.5' },
    ];
    const sections = groupActivityByDay([], visits);
    expect(sections[0].distanceKm).toBeCloseTo(5.5);
    expect(sections[0].durationMinutes).toBe(0);
  });

  test('sorts sections newest day first', () => {
    const attendanceDays = [
      { login_time: '2026-08-08T04:00:00Z', total_distance_km: 1, total_duration_minutes: 10 },
      { login_time: '2026-08-10T04:00:00Z', total_distance_km: 2, total_duration_minutes: 20 },
      { login_time: '2026-08-09T04:00:00Z', total_distance_km: 3, total_duration_minutes: 30 },
    ];
    const sections = groupActivityByDay(attendanceDays, []);
    expect(sections.map((s) => s.distanceKm)).toEqual([2, 3, 1]);
  });

  test('a day with no attendance row still appears if it has visits', () => {
    const visits = [{ id: 1, dealer_id: 10, login_time: '2026-08-10T05:00:00Z' }];
    const sections = groupActivityByDay([], visits);
    expect(sections).toHaveLength(1);
    expect(sections[0].attendance).toBeNull();
  });
});

describe('formatDuration', () => {
  test('formats minutes into hours and minutes', () => {
    expect(formatDuration(320)).toBe('5h 20m');
    expect(formatDuration(45)).toBe('0h 45m');
  });

  test('treats missing/zero/negative as 0h 0m', () => {
    expect(formatDuration(0)).toBe('0h 0m');
    expect(formatDuration(null)).toBe('0h 0m');
    expect(formatDuration(undefined)).toBe('0h 0m');
  });
});
