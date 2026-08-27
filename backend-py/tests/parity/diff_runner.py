"""
diff_runner.py — Phase 3 request-diff harness. Sends equivalent requests to
the live Node backend (default :3001) and the live FastAPI backend (default
:3002) against the SAME database, and diffs status code + JSON body (with a
declared set of non-deterministic fields ignored: ids, timestamps that are
"now"-derived, etc.).

Usage:
    NODE_BASE_URL=http://localhost:3001 FASTAPI_BASE_URL=http://localhost:3002 \
        backend-py/.venv/Scripts/python.exe backend-py/tests/parity/diff_runner.py

Writes a machine-readable JSON report to PARITY_RUN_RESULTS.json (repo root)
and prints a human summary to stdout. This does NOT fabricate results — every
row is a real HTTP call to both live servers.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

NODE_BASE = os.environ.get("NODE_BASE_URL", "http://localhost:3001")
FASTAPI_BASE = os.environ.get("FASTAPI_BASE_URL", "http://localhost:3002")

# Fields whose exact value is expected to legitimately differ between two
# independent runs / two independent backends (fresh ids, "now" timestamps,
# generated tokens) — compared for TYPE/PRESENCE only, not exact value.
NONDETERMINISTIC_KEYS = {
    "id", "accessToken", "refreshToken", "created_at", "updated_at",
    "login_time", "logout_time", "time", "resolved_at", "started_at",
    "ended_at", "attendance_id", "visit_id", "generated_at",
    "last_activity", "last_location_check_at",
}


@dataclass
class CaseResult:
    name: str
    method: str
    path: str
    node_status: Optional[int] = None
    fastapi_status: Optional[int] = None
    node_body: Any = None
    fastapi_body: Any = None
    node_error: Optional[str] = None
    fastapi_error: Optional[str] = None
    diffs: list = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return (
            self.node_error is None
            and self.fastapi_error is None
            and self.node_status == self.fastapi_status
            and not self.diffs
        )


def _request(base: str, method: str, path: str, body: dict | None = None, token: str | None = None, headers: dict | None = None):
    url = f"{base}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        status = e.code
    try:
        parsed = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        parsed = raw.decode("utf-8", errors="replace")
    return status, parsed


def _diff_json(a: Any, b: Any, path: str = "$") -> list[str]:
    diffs = []
    if type(a) is not type(b):
        # Allow int/float cross-type (JSON number formatting differences)
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            if abs(a - b) > 1e-9:
                diffs.append(f"{path}: {a!r} != {b!r}")
            return diffs
        diffs.append(f"{path}: type {type(a).__name__} != {type(b).__name__} ({a!r} vs {b!r})")
        return diffs
    if isinstance(a, dict):
        keys_a, keys_b = set(a.keys()), set(b.keys())
        if keys_a != keys_b:
            missing_in_b = keys_a - keys_b
            missing_in_a = keys_b - keys_a
            if missing_in_b:
                diffs.append(f"{path}: keys missing in FastAPI response: {sorted(missing_in_b)}")
            if missing_in_a:
                diffs.append(f"{path}: extra keys in FastAPI response: {sorted(missing_in_a)}")
        for k in keys_a & keys_b:
            if k in NONDETERMINISTIC_KEYS:
                # presence/type only
                if (a[k] is None) != (b[k] is None):
                    diffs.append(f"{path}.{k}: null-ness differs ({a[k]!r} vs {b[k]!r})")
                continue
            diffs.extend(_diff_json(a[k], b[k], f"{path}.{k}"))
    elif isinstance(a, list):
        if len(a) != len(b):
            diffs.append(f"{path}: length {len(a)} != {len(b)}")
        else:
            for i, (x, y) in enumerate(zip(a, b)):
                diffs.extend(_diff_json(x, y, f"{path}[{i}]"))
    else:
        if a != b:
            diffs.append(f"{path}: {a!r} != {b!r}")
    return diffs


def run_case(name, method, path, body=None, node_token=None, fastapi_token=None, headers=None) -> CaseResult:
    result = CaseResult(name=name, method=method, path=path)
    try:
        result.node_status, result.node_body = _request(NODE_BASE, method, path, body, node_token, headers)
    except Exception as e:  # noqa: BLE001
        result.node_error = repr(e)
    try:
        result.fastapi_status, result.fastapi_body = _request(FASTAPI_BASE, method, path, body, fastapi_token, headers)
    except Exception as e:  # noqa: BLE001
        result.fastapi_error = repr(e)

    if result.node_error or result.fastapi_error:
        return result
    if result.node_status != result.fastapi_status:
        result.diffs.append(f"status: {result.node_status} != {result.fastapi_status}")
    if isinstance(result.node_body, dict) and isinstance(result.fastapi_body, dict):
        result.diffs.extend(_diff_json(result.node_body, result.fastapi_body))
    elif result.node_body != result.fastapi_body:
        result.diffs.append(f"body: {result.node_body!r} != {result.fastapi_body!r}")
    return result


def login(base_url_env_name, username, password):
    base = NODE_BASE if base_url_env_name == "node" else FASTAPI_BASE
    status, body = _request(base, "POST", "/api/auth/login", {"username": username, "password": password})
    if status != 200:
        raise RuntimeError(f"login failed against {base}: {status} {body}")
    return body["accessToken"], body["employee"]


def main():
    results: list[CaseResult] = []

    print(f"Node backend: {NODE_BASE}")
    print(f"FastAPI backend: {FASTAPI_BASE}")

    node_rep_token, rep_employee = login("node", "arun.kumar", "password123")
    fastapi_rep_token, _ = login("fastapi", "arun.kumar", "password123")
    node_mgr_token, _ = login("node", "manager", "manager123")
    fastapi_mgr_token, _ = login("fastapi", "manager", "manager123")

    def add(name, method, path, **kw):
        results.append(run_case(name, method, path, **kw))

    # --- Auth ---
    add("login: missing fields", "POST", "/api/auth/login", body={})
    add("login: unknown username", "POST", "/api/auth/login", body={"username": "no_such_user", "password": "x"})
    add("login: wrong password", "POST", "/api/auth/login", body={"username": "arun.kumar", "password": "wrong"})
    add("auth: no token", "GET", "/api/attendance/today")
    add("auth: malformed token", "GET", "/api/attendance/today", headers={"Authorization": "Bearer garbage"})

    # --- Today's attendance (idempotent GET, safe to diff freely) ---
    add("attendance/today: rep", "GET", "/api/attendance/today", node_token=node_rep_token, fastapi_token=fastapi_rep_token)

    # --- Dealer APIs ---
    add("dealers: list", "GET", "/api/dealers", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("dealers: search", "GET", "/api/dealers?search=kovai", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("dealers: not-visited (manager)", "GET", "/api/dealers/not-visited?days=7", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("dealers: not-visited forbidden for rep", "GET", "/api/dealers/not-visited", node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("dealers: not-visited days=0 rejected", "GET", "/api/dealers/not-visited?days=0", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)

    # --- Config / assignments / notifications (read-only, safe) ---
    add("config", "GET", "/api/config", node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("assignments: today (rep)", "GET", "/api/assignments/today", node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("notifications: list (manager)", "GET", "/api/notifications", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("notifications: unread-count (manager)", "GET", "/api/notifications/unread-count", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("notes: list (rep)", "GET", "/api/notes", node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("reminders: list (rep)", "GET", "/api/reminders", node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("reports: attendance (manager)", "GET", "/api/reports/attendance", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("dashboard: today (manager)", "GET", "/api/dashboard/today", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)
    add("employees: list (manager)", "GET", "/api/employees", node_token=node_mgr_token, fastapi_token=fastapi_mgr_token)

    # --- Validation-only cases (no persisted side effects) ---
    add("attendance/login: missing lat/lng", "POST", "/api/attendance/login", body={}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("attendance/login: lat out of range", "POST", "/api/attendance/login", body={"lat": 200, "lng": 10}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("attendance/login: accuracy exceeds threshold", "POST", "/api/attendance/login",
        body={"lat": 11.0098, "lng": 76.9558, "accuracy_meters": 500}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("visits/login: missing fields", "POST", "/api/visits/login", body={}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("visits/logout: missing fields", "POST", "/api/visits/logout", body={}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)
    add("sync-failures: missing url", "POST", "/api/sync-failures", body={}, node_token=node_rep_token, fastapi_token=fastapi_rep_token)

    # --- 404 shape ---
    add("404: unknown route", "GET", "/api/this-route-does-not-exist", node_token=node_rep_token, fastapi_token=fastapi_rep_token)

    passed = [r for r in results if r.ok]
    failed = [r for r in results if not r.ok]

    print(f"\n{len(passed)}/{len(results)} cases matched exactly.\n")
    for r in failed:
        print(f"--- MISMATCH: {r.name} ({r.method} {r.path}) ---")
        if r.node_error or r.fastapi_error:
            print(f"  node_error={r.node_error} fastapi_error={r.fastapi_error}")
        else:
            print(f"  node_status={r.node_status} fastapi_status={r.fastapi_status}")
            for d in r.diffs:
                print(f"  {d}")
        print()

    report = {
        "node_base": NODE_BASE,
        "fastapi_base": FASTAPI_BASE,
        "total": len(results),
        "passed": len(passed),
        "failed": len(failed),
        "cases": [
            {
                "name": r.name,
                "method": r.method,
                "path": r.path,
                "ok": r.ok,
                "node_status": r.node_status,
                "fastapi_status": r.fastapi_status,
                "node_error": r.node_error,
                "fastapi_error": r.fastapi_error,
                "diffs": r.diffs,
                "node_body": r.node_body,
                "fastapi_body": r.fastapi_body,
            }
            for r in results
        ],
    }
    out_path = os.environ.get("PARITY_REPORT_PATH", "PARITY_RUN_RESULTS.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"Full report written to {out_path}")

    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
