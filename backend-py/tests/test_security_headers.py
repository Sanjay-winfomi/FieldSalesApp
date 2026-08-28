"""Verifies SecurityHeadersMiddleware's output against helmet@8.3.0's real
default header set — not inferred from documentation, but diffed directly
against a live `helmet()` Express app running the exact pinned version
(package-lock.json had helmet 8.3.0) on 2026-08-28. Byte-for-byte match,
confirming app/core/security_headers.py's claimed parity is accurate.

Uses the real app (the module-scoped `client` fixture from conftest.py) so
the assertion runs against the actual middleware stack in app.main, not a
reconstructed minimal app."""
import pytest

pytestmark = pytest.mark.asyncio(loop_scope="module")

# Captured verbatim from `curl -sD - http://localhost:4123/` against a bare
# `express(); app.use(helmet())` server running helmet@8.3.0.
EXPECTED_HELMET_8_3_0_HEADERS = {
    "content-security-policy": (
        "default-src 'self';base-uri 'self';font-src 'self' https: data:;"
        "form-action 'self';frame-ancestors 'self';img-src 'self' data:;"
        "object-src 'none';script-src 'self';script-src-attr 'none';"
        "style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests"
    ),
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-dns-prefetch-control": "off",
    "x-download-options": "noopen",
    "x-frame-options": "SAMEORIGIN",
    "x-permitted-cross-domain-policies": "none",
    "x-xss-protection": "0",
}


async def test_response_headers_match_real_helmet_8_3_0_defaults(client):
    response = await client.get("/health")
    for name, expected_value in EXPECTED_HELMET_8_3_0_HEADERS.items():
        assert response.headers.get(name) == expected_value, f"header {name!r} mismatch"


async def test_does_not_send_cross_origin_embedder_policy(client):
    # COEP is opt-in in helmet 5+ (not part of the default set) — asserting
    # its absence guards against ever accidentally adding it and silently
    # diverging from the Node app's actual (COEP-less) header set.
    response = await client.get("/health")
    assert "cross-origin-embedder-policy" not in response.headers
