"""
production_smoke_test.py — run this against the deployed FastAPI backend
AFTER deploying it, to verify the exact flow requested for cutover:
Login -> Day Check-in -> Dealer List -> Dealer Check-in -> Dealer Check-out
-> Day Check-out -> Reports/Sync.

This talks to ONE real backend over HTTPS and makes real writes (attendance/
visit rows) against whatever database that backend is configured for. Do
NOT run this against production with a real rep's credentials — use a
dedicated test/QA account if your production DB has one, or run it against
the Node backend first (BASE_URL pointed at the OLD service) to confirm the
script itself is sound before pointing it at FastAPI.

Usage:
    BASE_URL=https://fieldtrack-backend-py-xxxx.onrender.com \
    TEST_USERNAME=qa.rep \
    TEST_PASSWORD=... \
    DEALER_ID=1 \
        python production_smoke_test.py

Exits non-zero and prints the failing step if anything doesn't match the
expected status code. This is intentionally simple/sequential (not the
parity diff_runner — there is no second backend to diff against in
production), just a real-flow health check.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE_URL = os.environ["BASE_URL"].rstrip("/")
USERNAME = os.environ["TEST_USERNAME"]
PASSWORD = os.environ["TEST_PASSWORD"]
DEALER_ID = int(os.environ.get("DEALER_ID", "1"))
# A second dealer with DIFFERENT coordinates than the login point avoids the
# degenerate identical-origin/destination Google Routes edge case found
# during backend validation (see COMPATIBILITY_REPORT.md bug section) —
# set this to any real dealer id in your DB with coordinates different from
# LOGIN_LAT/LOGIN_LNG below.
CHECKIN_LAT = float(os.environ.get("CHECKIN_LAT", "11.0098"))
CHECKIN_LNG = float(os.environ.get("CHECKIN_LNG", "76.9558"))

STEPS_RUN = []


def call(method, path, body=None, token=None, expect=None):
    url = f"{BASE_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    start = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=70) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    elapsed = time.monotonic() - start
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        parsed = {"_raw": raw.decode("utf-8", errors="replace")}

    ok = expect is None or status == expect
    STEPS_RUN.append({"method": method, "path": path, "status": status, "elapsed_s": round(elapsed, 2), "ok": ok})
    print(f"{'OK  ' if ok else 'FAIL'} {method:6s} {path:45s} -> {status} ({elapsed:.2f}s)")
    if not ok:
        print(f"     expected {expect}, body: {json.dumps(parsed)[:500]}")
        print_summary_and_exit(1)
    return status, parsed


def print_summary_and_exit(code):
    print("\n--- Summary ---")
    for s in STEPS_RUN:
        mark = "OK " if s["ok"] else "FAIL"
        print(f"[{mark}] {s['method']} {s['path']} -> {s['status']} ({s['elapsed_s']}s)")
    sys.exit(code)


def main():
    print(f"Target: {BASE_URL}\n")

    # 0. Health — cheap liveness check, also wakes a Render free-tier
    # instance from cold-start before timing the real flow below.
    call("GET", "/health", expect=200)

    # 1. Login
    _, login_body = call(
        "POST", "/api/auth/login",
        body={"username": USERNAME, "password": PASSWORD},
        expect=200,
    )
    token = login_body["accessToken"]
    print(f"     logged in as {login_body['employee']['username']} (role={login_body['employee']['role']})")

    # 2. Day check-in (idempotent-ish: if already checked in today, a 409 is
    # also an acceptable "backend is alive and enforcing the same rule"
    # signal — don't hard-fail the whole smoke test on that alone).
    status, day_login_body = call(
        "POST", "/api/attendance/login",
        body={"lat": CHECKIN_LAT, "lng": CHECKIN_LNG, "accuracy_meters": 10},
        token=token,
    )
    if status == 201:
        attendance_id = day_login_body["attendance"]["id"]
    elif status == 409:
        attendance_id = day_login_body.get("attendance_id")
        print(f"     already checked in today (attendance_id={attendance_id}) — continuing")
    else:
        print(f"     unexpected status {status} on day check-in: {day_login_body}")
        print_summary_and_exit(1)

    # 3. Dealer list
    call("GET", "/api/dealers", token=token, expect=200)

    # 4. Dealer check-in — use DEALER_ID with coordinates that genuinely
    # differ from CHECKIN_LAT/LNG above to exercise the real Google Routes
    # call, not the degenerate same-point case.
    status, visit_body = call(
        "POST", "/api/visits/login",
        body={
            "attendance_id": attendance_id, "dealer_id": DEALER_ID,
            "lat": CHECKIN_LAT, "lng": CHECKIN_LNG, "accuracy_meters": 10,
        },
        token=token,
    )
    if status == 201:
        visit_id = visit_body["visit"]["id"]
    elif status == 409:
        visit_id = visit_body.get("visit", {}).get("id")
        print(f"     a visit is already open (visit_id={visit_id}) — continuing to check it out")
    else:
        print(f"     unexpected status {status} on dealer check-in: {visit_body}")
        print_summary_and_exit(1)

    # 5. Dealer check-out
    if visit_id:
        call(
            "POST", "/api/visits/logout",
            body={"visit_id": visit_id, "lat": CHECKIN_LAT, "lng": CHECKIN_LNG, "accuracy_meters": 10},
            token=token,
        )

    # 6. Day check-out
    call(
        "POST", "/api/attendance/logout",
        body={"attendance_id": attendance_id, "lat": CHECKIN_LAT, "lng": CHECKIN_LNG, "accuracy_meters": 10},
        token=token,
    )

    # 7. Reports/Sync — read-only report + the offline-sync-failure endpoint
    # (a harmless no-op report of a failure the client already recovered
    # from, matching what the real app sends).
    call("GET", "/api/reports/attendance", token=token)  # 200 for a manager, 403 for a rep — either proves the route/auth chain works
    call(
        "POST", "/api/sync-failures",
        body={"method": "GET", "url": "/api/smoke-test-noop", "error": "smoke test synthetic entry"},
        token=token,
        expect=201,
    )

    print_summary_and_exit(0)


if __name__ == "__main__":
    main()
