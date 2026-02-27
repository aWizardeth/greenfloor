"""Tests for Sage RPC fingerprint guard behaviour.

Three branches in SageRpcClient.__aenter__:
  1. No fingerprint configured → no check, enters normally.
  2. Fingerprint configured and active wallet matches → enters normally.
  3. Fingerprint configured but active wallet differs → raises SageWrongFingerprintError.

The daemon never calls login() automatically; switching wallets is always
an explicit user action in the Sage UI.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from greenfloor.adapters.sage_rpc import (
    SageRpcClient,
    SageWrongFingerprintError,
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


def _patch_session(client: SageRpcClient, active_fingerprint: int | None) -> None:
    """Patch _make_session and get_key so no real network calls occur."""
    mock_session = MagicMock()
    mock_session.closed = False
    mock_session.close = AsyncMock()
    client._make_session = MagicMock(return_value=mock_session)  # type: ignore[method-assign]
    client.get_key = AsyncMock(  # type: ignore[method-assign]
        return_value={"key": {"fingerprint": active_fingerprint}}
    )


# ---------------------------------------------------------------------------
# Branch 1: no fingerprint configured
# ---------------------------------------------------------------------------


def test_aenter_no_fingerprint_skips_check() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=None)
        mock_session = MagicMock()
        mock_session.closed = False
        client._make_session = MagicMock(return_value=mock_session)  # type: ignore[method-assign]
        client.get_key = AsyncMock()  # type: ignore[method-assign]

        result = await client.__aenter__()

        assert result is client
        client.get_key.assert_not_called()  # no check performed

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Branch 2: fingerprint matches active wallet
# ---------------------------------------------------------------------------


def test_aenter_fingerprint_match_enters_normally() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client, active_fingerprint=111222333)

        result = await client.__aenter__()

        assert result is client
        client.get_key.assert_awaited_once()

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Branch 3: fingerprint mismatch → raise, session cleaned up
# ---------------------------------------------------------------------------


def test_aenter_fingerprint_mismatch_raises() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client, active_fingerprint=999888777)

        with pytest.raises(SageWrongFingerprintError) as exc_info:
            await client.__aenter__()

        err = exc_info.value
        assert err.expected == 111222333
        assert err.active == 999888777
        # Session must have been closed — no resource leak
        assert client._session is None

    asyncio.run(_run())


def test_aenter_fingerprint_mismatch_message_is_helpful() -> None:
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client, active_fingerprint=999888777)

        with pytest.raises(SageWrongFingerprintError) as exc_info:
            await client.__aenter__()

        msg = str(exc_info.value)
        assert "111222333" in msg
        assert "999888777" in msg
        assert "Sage UI" in msg

    asyncio.run(_run())


# ---------------------------------------------------------------------------
# Mismatch when active key is None (Sage logged out)
# ---------------------------------------------------------------------------


def test_aenter_fingerprint_mismatch_none_active_raises() -> None:
    """get_key returns no active key (e.g. logged out) → treated as mismatch."""
    async def _run() -> None:
        client = _make_client(fingerprint=111222333)
        _patch_session(client, active_fingerprint=None)

        with pytest.raises(SageWrongFingerprintError) as exc_info:
            await client.__aenter__()

        assert exc_info.value.active is None

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
