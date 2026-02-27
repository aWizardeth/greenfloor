"""Tests for Sage RPC fingerprint tracking.

SageRpcClient.__aenter__ does NOT call login().  The fingerprint is stored
on the client and on the module-level _default_fingerprint, but the actual
Sage login RPC is only issued:
  - once at webui server startup (_on_startup)
  - on explicit request via the /api/sage-rpc/login endpoint

This means Sage UI wallet switches have no immediate effect; they are only
overridden when the webui issues an explicit login.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from greenfloor.adapters.sage_rpc import (
    SageRpcClient,
    configure_sage_fingerprint,
    resolve_sage_client,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(fingerprint: int | None = None) -> SageRpcClient:
    return SageRpcClient(
        port=9257,
        cert_path=Path("/fake/wallet.crt"),
        key_path=Path("/fake/wallet.key"),
        fingerprint=fingerprint,
    )


def _patch_session(client: SageRpcClient) -> MagicMock:
    mock_session = MagicMock()
    mock_session.closed = False
    mock_session.close = AsyncMock()
    client._make_session = MagicMock(return_value=mock_session)  # type: ignore[method-assign]
    client.login = AsyncMock(return_value={"success": True})  # type: ignore[method-assign]
    return mock_session


# ---------------------------------------------------------------------------
# __aenter__ never calls login regardless of fingerprint
# ---------------------------------------------------------------------------


def test_aenter_no_fingerprint_does_not_call_login() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=None)
        _patch_session(client)
        result = await client.__aenter__()
        assert result is client
        client.login.assert_not_called()

    asyncio.run(_run())


def test_aenter_with_fingerprint_does_not_call_login() -> None:
    """Fingerprint is stored on the client but __aenter__ never calls login()."""
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client)
        result = await client.__aenter__()
        assert result is client
        client.login.assert_not_called()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# configure_sage_fingerprint sets the module-level default
# ---------------------------------------------------------------------------


def test_configure_sage_fingerprint_sets_default() -> None:
    from greenfloor.adapters import sage_rpc as mod

    original = mod._default_fingerprint
    try:
        configure_sage_fingerprint(424242)
        assert mod._default_fingerprint == 424242

        configure_sage_fingerprint(None)
        assert mod._default_fingerprint is None
    finally:
        mod._default_fingerprint = original


def test_resolve_sage_client_uses_module_default(tmp_path: Path) -> None:
    from greenfloor.adapters import sage_rpc as mod

    fake_cert = tmp_path / "wallet.crt"
    fake_cert.touch()
    fake_key = tmp_path / "wallet.key"
    fake_key.touch()

    original = mod._default_fingerprint
    try:
        configure_sage_fingerprint(777888)
        client = resolve_sage_client(
            port=9257,
            cert_path=str(fake_cert),
            key_path=str(fake_key),
        )
        assert client._fingerprint == 777888
    finally:
        mod._default_fingerprint = original
