"""Sage Wallet RPC adapter.

Sage runs a local HTTPS RPC server on 127.0.0.1:9257 (default) using Mutual TLS.
Both the server certificate and the allowed client certificate are the same
``wallet.crt`` / ``wallet.key`` pair that Sage generates in its data directory.

This module provides:
- ``_sage_data_dir()``    – OS-aware path to com.rigidnetwork.sage/
- ``SageRpcClient``       – async aiohttp-based RPC client with mTLS
- ``resolve_sage_client`` – build a client from config or auto-detected paths
"""
from __future__ import annotations

import json
import platform
import ssl
from pathlib import Path
from typing import Any

import aiohttp


# ---------------------------------------------------------------------------
# Module-level fingerprint lock
# ---------------------------------------------------------------------------

_default_fingerprint: int | None = None


def configure_sage_fingerprint(fingerprint: int | None) -> None:
    """Store the configured fingerprint as the module-level default.

    This is called once at server startup.  It does NOT call login(); the
    actual Sage login RPC is issued separately (once at startup via
    _on_startup, and on demand via the webui login button).  Switching
    wallets only happens when explicitly requested -- not on every session.
    """
    global _default_fingerprint
    _default_fingerprint = fingerprint


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _sage_data_dir() -> Path:
    """Return the default Sage wallet data directory for the current OS."""
    system = platform.system()
    if system == "Windows":
        base = Path.home() / "AppData" / "Roaming"
    elif system == "Darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        # Linux / other POSIX
        base = Path.home() / ".local" / "share"
    return base / "com.rigidnetwork.sage"


def _default_cert_path() -> Path:
    return _sage_data_dir() / "ssl" / "wallet.crt"


def _default_key_path() -> Path:
    return _sage_data_dir() / "ssl" / "wallet.key"


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class SageRpcClient:
    """Async client for the Sage wallet local RPC.

    All Sage endpoints accept POST /{endpoint_name} with a JSON body and
    return a JSON response.  Authentication is Mutual TLS – the client must
    present the same wallet.crt + wallet.key that Sage generated.

    Usage (async context manager)::

        async with SageRpcClient(cert_path, key_path) as client:
            status = await client.call("get_sync_status", {})
            keys   = await client.call("get_keys", {})
    """

    def __init__(
        self,
        cert_path: str | Path,
        key_path: str | Path,
        port: int = 9257,
        host: str = "127.0.0.1",
        fingerprint: int | None = None,
    ) -> None:
        self._cert_path = Path(cert_path)
        self._key_path = Path(key_path)
        self._base_url = f"https://{host}:{port}"
        self._session: aiohttp.ClientSession | None = None
        self._fingerprint = fingerprint

    # ------------------------------------------------------------------
    # Context-manager helpers
    # ------------------------------------------------------------------

    async def __aenter__(self) -> "SageRpcClient":
        self._session = self._make_session()
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None

    def _make_session(self) -> aiohttp.ClientSession:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE  # Sage uses a self-signed cert
        ssl_ctx.load_cert_chain(
            certfile=str(self._cert_path),
            keyfile=str(self._key_path),
        )
        connector = aiohttp.TCPConnector(ssl=ssl_ctx)
        return aiohttp.ClientSession(connector=connector)

    # ------------------------------------------------------------------
    # Core RPC call
    # ------------------------------------------------------------------

    async def call(self, endpoint: str, body: dict[str, Any] | None = None) -> Any:
        """Call a Sage RPC endpoint and return the parsed JSON response.

        Args:
            endpoint: snake_case endpoint name, e.g. ``make_offer``.
            body:     JSON-serialisable request body (default: empty dict).

        Returns:
            Parsed JSON from the response body.

        Raises:
            SageRpcError: on non-200 HTTP status.
            RuntimeError: if the client has not been started with ``async with``.
        """
        if self._session is None:
            # Allow one-shot usage without context manager
            self._session = self._make_session()

        url = f"{self._base_url}/{endpoint}"
        payload = body or {}

        async with self._session.post(url, json=payload) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise SageRpcError(resp.status, text, endpoint)
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text

    # ------------------------------------------------------------------
    # Typed helpers for the endpoints GreenFloor actually uses
    # ------------------------------------------------------------------

    async def get_version(self) -> dict[str, Any]:
        return await self.call("get_version", {})

    async def get_sync_status(self) -> dict[str, Any]:
        return await self.call("get_sync_status", {})

    async def get_keys(self) -> dict[str, Any]:
        return await self.call("get_keys", {})

    async def get_key(self, fingerprint: int | None = None) -> dict[str, Any]:
        return await self.call("get_key", {"fingerprint": fingerprint})

    async def login(self, fingerprint: int) -> dict[str, Any]:
        return await self.call("login", {"fingerprint": fingerprint})

    async def logout(self) -> dict[str, Any]:
        return await self.call("logout", {})

    async def get_coins(
        self,
        *,
        asset_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"limit": limit, "offset": offset}
        if asset_id is not None:
            body["asset_id"] = asset_id
        return await self.call("get_coins", body)

    async def get_cats(self) -> dict[str, Any]:
        """Return all CAT tokens held by the active key with name/ticker/icon_url."""
        return await self.call("get_cats", {})

    async def get_token(self, asset_id: str | None) -> dict[str, Any]:
        """Return a single TokenRecord by asset_id (pass None for XCH)."""
        return await self.call("get_token", {"asset_id": asset_id})

    async def make_offer(self, offer_params: dict[str, Any]) -> dict[str, Any]:
        """Call make_offer. ``offer_params`` is passed directly as the body.

        Minimal example::

            {
                "offered_assets": [{"asset_id": null, "amount": {"mojos": 1000}}],
                "requested_assets": [{"asset_id": "<cat-id>", "amount": {"mojos": 1000}}],
                "fee": {"mojos": 0},
                "expiration_seconds": 3600
            }
        """
        return await self.call("make_offer", offer_params)

    async def sign_coin_spends(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self.call("sign_coin_spends", body)

    async def submit_transaction(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self.call("submit_transaction", body)

    async def view_offer(self, offer: str) -> dict[str, Any]:
        return await self.call("view_offer", {"offer": offer})

    async def bulk_send_cat(
        self,
        *,
        asset_id: str,
        addresses: list[str],
        amount: int,
        fee: int = 0,
        auto_submit: bool = True,
        include_hint: bool = True,
    ) -> dict[str, Any]:
        """Send *amount* mojos of *asset_id* to each address in *addresses*.

        Useful for coin splitting: pass the same address N times to create
        N new coins of exactly *amount* mojos each from the wallet's
        existing holdings.  The surplus balance (change) stays in the wallet.

        ``auto_submit=True`` broadcasts the transaction immediately.
        """
        body: dict[str, Any] = {
            "asset_id": asset_id,
            "addresses": addresses,
            "amount": amount,
            "fee": fee,
            "auto_submit": auto_submit,
            "include_hint": include_hint,
        }
        return await self.call("bulk_send_cat", body)

    async def close(self) -> None:
        """Explicitly close the underlying session."""
        if self._session and not self._session.closed:
            await self._session.close()
        self._session = None


# ---------------------------------------------------------------------------
# Error type
# ---------------------------------------------------------------------------

class SageRpcError(Exception):
    """Raised when Sage RPC returns a non-200 status."""

    def __init__(self, status: int, body: str, endpoint: str = "") -> None:
        self.status = status
        self.body = body
        self.endpoint = endpoint
        super().__init__(f"Sage RPC {endpoint!r} failed with HTTP {status}: {body}")

    def to_dict(self) -> dict[str, Any]:
        return {
            "error": self.body,
            "status": self.status,
            "endpoint": self.endpoint,
        }


# ---------------------------------------------------------------------------
# Factory helpers
# ---------------------------------------------------------------------------

def resolve_sage_client(
    *,
    port: int = 9257,
    cert_path: str | None = None,
    key_path: str | None = None,
    host: str = "127.0.0.1",
    fingerprint: int | None = None,
) -> SageRpcClient:
    """Build a ``SageRpcClient`` from explicit paths or auto-detected defaults.

    If *fingerprint* is not passed explicitly, the module-level default set by
    ``configure_sage_fingerprint()`` is used.  When a fingerprint is active the
    client calls ``login(fingerprint)`` on ``__aenter__`` so every session is
    locked to the correct wallet regardless of what is active in the Sage UI.

    Call ``await client.close()`` when finished, or use as an async context
    manager.
    """
    fp = fingerprint if fingerprint is not None else _default_fingerprint
    cp = Path(cert_path) if cert_path else _default_cert_path()
    kp = Path(key_path) if key_path else _default_key_path()
    return SageRpcClient(cert_path=cp, key_path=kp, port=port, host=host, fingerprint=fp)


def sage_certs_present(
    cert_path: str | None = None,
    key_path: str | None = None,
) -> bool:
    """Return True if the Sage wallet cert+key files exist on disk."""
    cp = Path(cert_path) if cert_path else _default_cert_path()
    kp = Path(key_path) if key_path else _default_key_path()
    return cp.exists() and kp.exists()
