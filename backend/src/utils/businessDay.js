/**
 * businessDay.js — the field-sales "day" rolls over at a configurable hour
 * (default 5am IST), not at calendar midnight. A rep who logged in at
 * 11pm is still "in yesterday's session" at 2am, but by 5am every rep's
 * day login/logout and dealer login/logout must be available fresh again.
 *
 * DAY_BOUNDARY_HOUR is read once at startup — restart the server to pick
 * up a changed value.
 */
const rawHour = parseInt(process.env.DAY_BOUNDARY_HOUR, 10);
const DAY_BOUNDARY_HOUR = Number.isInteger(rawHour) && rawHour >= 0 && rawHour <= 23 ? rawHour : 5;

/**
 * SQL fragment returning the "business date" for a timestamp expression —
 * the calendar date after shifting back by DAY_BOUNDARY_HOUR, so anything
 * before that hour still counts as the previous business day.
 * @param {string} timestampExpr - a SQL expression evaluating to a timestamptz
 *   (e.g. 'login_time', 'a.login_time', 'NOW()')
 */
function businessDateExpr(timestampExpr) {
  return `DATE((${timestampExpr}) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '${DAY_BOUNDARY_HOUR} hours')`;
}

/**
 * SQL condition: is `timestampExpr` within the current business day?
 */
function isCurrentBusinessDay(timestampExpr) {
  return `${businessDateExpr(timestampExpr)} = ${businessDateExpr('NOW()')}`;
}

/**
 * JS-side equivalent of businessDateExpr('NOW()') — today's business date as
 * a 'YYYY-MM-DD' string, for routes that validate a caller-supplied date
 * against "today" without a DB round trip (e.g. rejecting a past date).
 * Using the plain UTC calendar date instead (e.g.
 * `new Date().toISOString().slice(0, 10)`) drifts from the real business
 * date for up to DAY_BOUNDARY_HOUR's worth of minutes once per day — right
 * after the boundary rolls over in IST but before the UTC calendar date has
 * also rolled over (the backend's server clock runs in UTC, e.g. on Render).
 * @param {Date} [now]
 */
function getBusinessDateString(now = new Date()) {
  const shifted = new Date(now.getTime() - DAY_BOUNDARY_HOUR * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(shifted);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

module.exports = { DAY_BOUNDARY_HOUR, businessDateExpr, isCurrentBusinessDay, getBusinessDateString };
