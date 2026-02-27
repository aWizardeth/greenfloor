"""Tests for Sage RPC fingerprint pinning behaviour.

The daemon pins the configured fingerprint by calling login(fingerprint) on
every session open, so switching wallets in the Sage UI has no lasting effect
on which wallet the daemon operates on.

Two branches in SageRpcClient.__aenter__:
  1. No fingerprint configured → login() NOT called; uses whatever wallet is active.
  2. Fingerprint configured → login(fingerprint) called every session open.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from greenfloor.adapters.sage_rpc import (
    SageRpcClient,
    configure_sage_fingerprint,
    resolve_sage_client,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_client(fingerprint: int | None = None) -> SageRpcClient:
    """Build a SageRpcClient with dummy cert paths; skip real filesystem."""
    return SageRpcClient(
        port=9257,
        cert_path=Path("/fake/wallet.crt"),
        key_path=Path("/fake/wallet.key"),
        fingerprint=fingerprint,
    )


def _patch_session(client: SageRpcClient) -> MagicMock:
    """Patch _make_session and login so no real network calls occur."""
    mock_session = MagicMock()
    mock_session.closed = False
    mock_session.close = AsyncMock()
    client._make_session = MagicMock(return_value=mock_session)  # type: ignore[method-assign]
    client.login = AsyncMock(return_value={"success": True})  # type: ignore[method-assign]
    return mock_session


# ---------------------------------------------------------------------------
# Branch 1: no fingerprint configured → login NOT called
# ---------------------------------------------------------------------------


def test_aenter_no_fingerprint_skips_login() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=None)
        _patch_session(client)

        result = await client.__aenter__()

        assert result is client
        client.login.assert_not_called()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Branch 2: fingerprint configured → login called with correct fingerprint
# ---------------------------------------------------------------------------


def test_aenter_fingerprint_calls_login() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client)

        result = await client.__aenter__()

        assert result is client
        client.login.assert_awaited_once_with(111222333)

    asyncio.run(_run())


def test_aenter_fingerprint_overrides_active_wallet() -> None:
    """Even if the Sage UI switched to a different wallet, login() re-asserts the pin."""
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client)
        # Simulate: UI had switched to 999888777; daemon still calls login(111222333)
        client.login = AsyncMock(return_value={"success": True})  # type: ignore[method-assign]

        await client.__aenter__()

        client.login.assert_awaited_once_with(111222333)

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# configure_sage_fingerprint wires through resolve_sage_client
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
    """resolve_sage_client picks up _default_fingerprint when none passed explicitly."""
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
