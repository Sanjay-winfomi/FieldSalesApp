"""Verifies get_client_ip's multi-hop X-Forwarded-For parsing against real
Express `trust proxy` (numeric-hop) behavior — not inferred from the
`proxy-addr` source, but diffed directly against a live Express app running
`app.set('trust proxy', N)` for N=1/2/3, multiple chain lengths, and the
too-few-hops clamping case, on 2026-08-28. Every case below reproduces the
exact `req.ip` Express returned."""
from starlette.requests import Request

from app.core import config
from app.core.rate_limit import get_client_ip


def _make_request(remote_host: str, xff: str | None) -> Request:
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    scope = {
        "type": "http",
        "headers": headers,
        "client": (remote_host, 12345),
    }
    return Request(scope)


def test_no_xff_header_returns_socket_address(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "TRUST_PROXY_HOPS", 1)
    request = _make_request("10.0.0.1", None)
    assert get_client_ip(request) == "10.0.0.1"


def test_hops_1_returns_rightmost_entry(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "TRUST_PROXY_HOPS", 1)
    request = _make_request("10.0.0.1", "1.1.1.1, 2.2.2.2, 3.3.3.3")
    assert get_client_ip(request) == "3.3.3.3"


def test_hops_2_returns_second_from_right(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "TRUST_PROXY_HOPS", 2)
    request = _make_request("10.0.0.1", "1.1.1.1, 2.2.2.2, 3.3.3.3")
    assert get_client_ip(request) == "2.2.2.2"


def test_hops_3_returns_third_from_right(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "TRUST_PROXY_HOPS", 3)
    request = _make_request("10.0.0.1", "1.1.1.1, 2.2.2.2, 3.3.3.3")
    assert get_client_ip(request) == "1.1.1.1"


def test_hops_exceeding_chain_length_clamps_to_leftmost_entry(monkeypatch):
    # Express itself clamps rather than erroring when trust proxy asks for
    # more hops than the header actually has.
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    monkeypatch.setattr(config, "TRUST_PROXY_HOPS", 2)
    request = _make_request("10.0.0.1", "1.1.1.1")
    assert get_client_ip(request) == "1.1.1.1"


def test_five_entry_chain_at_each_hop_count(monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    xff = "0.0.0.0, 1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4"
    expected = {1: "4.4.4.4", 2: "3.3.3.3", 3: "2.2.2.2"}
    for hops, expected_ip in expected.items():
        monkeypatch.setattr(config, "TRUST_PROXY_HOPS", hops)
        request = _make_request("10.0.0.1", xff)
        assert get_client_ip(request) == expected_ip


def test_dev_mode_ignores_xff_and_always_uses_socket_address(monkeypatch):
    # Same as the Node app: X-Forwarded-For is only honored when
    # NODE_ENV=production — every request appears to share one IP in dev
    # unless behind a real proxy.
    monkeypatch.setattr(config, "IS_PRODUCTION", False)
    request = _make_request("10.0.0.1", "9.9.9.9")
    assert get_client_ip(request) == "10.0.0.1"
