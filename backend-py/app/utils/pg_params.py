"""
pg_params.py — inbound parameter coercion for asyncpg.

node-pg accepts a plain 'YYYY-MM-DD' string for any DATE-typed bind
parameter (with or without an explicit `::date` cast in the SQL text) and
casts it server-side. asyncpg does NOT: it resolves each parameter's
expected type from the prepared statement (including from an explicit
`::date` cast anywhere the parameter is used, even inside a `||` text
concatenation), and requires the Python value to already be the matching
native type — a `datetime.date` for `date`, not a `str`. Passing a string
raises `DataError("... 'str' object has no attribute 'toordinal'")` no
matter where in the query the parameter appears (WHERE clause, INSERT
VALUES, string concatenation — verified directly against asyncpg, not
assumed).

Every route in this codebase already validates a caller-supplied date
string as strict `YYYY-MM-DD` before using it (see each router's own
`_is_valid_date_string`/`isValidDateString` port) — `parse_date_string`
should only ever be called on an already-validated string, so
`date.fromisoformat` is safe here and intentionally does not re-validate.
"""
from datetime import date


def parse_date_string(value: str) -> date:
    return date.fromisoformat(value)
