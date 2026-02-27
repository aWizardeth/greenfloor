"""Deterministic tests for _sage_preflight_cat_split and _sage_count_eligible_coins.

Kept in a dedicated file to avoid AST-parser recursion errors that occur when
pytest tries to render failure tracebacks in very large test files.
"""
from __future__ import annotations

import json
from typing import Any


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sage_coins(amounts: list[int], spent_heights: list[int | None] | None = None) -> list[dict]:
    """Build minimal Sage coin dict records for preflight tests."""
    if spent_heights is None:
        spent_heights = [None] * len(amounts)
    return [{"amount": a, "spent_height": sh} for a, sh in zip(amounts, spent_heights)]


class _FakeSageClient:
    """Minimal async context manager standing in for SageRpcClient.

    ``get_sync_status`` returns ``receive_address`` so the preflight can
    resolve the split destination without the markets config.
    """

    def __init__(
        self,
        coins_sequence: list[list[dict]],
        split_error: Exception | None = None,
        receive_address: str = "xch1sage_receive_addr",
    ) -> None:
        self._coins_iter = iter(coins_sequence)
        self._split_error = split_error
        self._receive_address = receive_address
        self.split_calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> "_FakeSageClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        pass

    async def get_sync_status(self) -> dict[str, Any]:
        return {"receive_address": self._receive_address}

    async def get_coins(self, *, asset_id: str | None = None, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        try:
            return {"coins": next(self._coins_iter)}
        except StopIteration:
            return {"coins": []}

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
        self.split_calls.append({"asset_id": asset_id, "addresses": addresses, "amount": amount})
        if self._split_error is not None:
            raise self._split_error
        return {"status": "ok"}


def _patch_sage_client(monkeypatch: Any, client: _FakeSageClient) -> None:
    monkeypatch.setattr(
        "greenfloor.adapters.sage_rpc.resolve_sage_client",
        lambda **kw: client,
    )


def _monotonic_from(*values: float):
    """Return a callable that yields successive *values* then replays the last one.

    asyncio's Windows ProactorEventLoop calls ``time.monotonic()`` internally
    during ``loop.close()``, so we need the mock to be safe against extra calls
    beyond what the test scenario specifies.
    """
    it = iter(values)
    last: list[float] = [0.0]

    def _mono() -> float:
        try:
            last[0] = next(it)
        except StopIteration:
            pass
        return last[0]

    return _mono


# ---------------------------------------------------------------------------
# _sage_count_eligible_coins
# ---------------------------------------------------------------------------


def test_sage_count_eligible_coins_basic() -> None:
    from greenfloor.cli.manager import _sage_count_eligible_coins

    coins = _sage_coins([1000, 500, 2000, 1000])
    # Only exact matches count; over/under-sized coins are excluded.
    assert _sage_count_eligible_coins(coins, offer_mojos=1000) == 2  # indices 0, 3
    assert _sage_count_eligible_coins(coins, offer_mojos=2000) == 1  # index 2
    assert _sage_count_eligible_coins(coins, offer_mojos=2001) == 0  # none


def test_sage_count_eligible_coins_ignores_spent() -> None:
    from greenfloor.cli.manager import _sage_count_eligible_coins

    coins = _sage_coins([1000, 1000], spent_heights=[123, None])
    assert _sage_count_eligible_coins(coins, offer_mojos=1000) == 1


# ---------------------------------------------------------------------------
# _sage_preflight_cat_split: XCH skip
# ---------------------------------------------------------------------------


def test_sage_preflight_xch_skips_immediately() -> None:
    """For XCH/txch/1/empty the preflight must return 0 without any RPC calls."""
    from greenfloor.cli.manager import _sage_preflight_cat_split

    for xch_id in ("xch", "txch", "1", ""):
        rc = _sage_preflight_cat_split(
            asset_id=xch_id,
            offer_mojos=1_000_000_000,
            number_of_coins=3,
        )
        assert rc == 0, f"expected 0 for asset_id={xch_id!r}"


# ---------------------------------------------------------------------------
# already-ready (no split needed)
# ---------------------------------------------------------------------------


def test_sage_preflight_already_ready(monkeypatch: Any) -> None:
    """Return 0 immediately when enough eligible coins already exist."""
    from greenfloor.cli.manager import _sage_preflight_cat_split

    client = _FakeSageClient(coins_sequence=[_sage_coins([1000, 1000])])
    _patch_sage_client(monkeypatch, client)

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        offer_mojos=1000,
        number_of_coins=2,
    )
    assert rc == 0
    assert not client.split_calls, "no split should have been submitted"


# ---------------------------------------------------------------------------
# split submitted, one poll → ready
# ---------------------------------------------------------------------------


def test_sage_preflight_splits_and_polls_until_ready(monkeypatch: Any) -> None:
    """Submit a split; after 1 poll the new coins appear → return 0."""
    client = _FakeSageClient(
        coins_sequence=[
            _sage_coins([]),      # initial check  → 0 eligible
            _sage_coins([1000]),  # first poll     → 1 eligible, done
        ],
        receive_address="xch1sage_recv",
    )
    _patch_sage_client(monkeypatch, client)
    monkeypatch.setattr("greenfloor.cli.manager.time.sleep", lambda _: None)
    monkeypatch.setattr("greenfloor.cli.manager._get_monotonic", _monotonic_from(0.0, 5.0, 5.0))

    from greenfloor.cli.manager import _sage_preflight_cat_split

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        offer_mojos=1000,
        number_of_coins=1,
        wait_seconds=120,
    )
    assert rc == 0
    assert len(client.split_calls) == 1
    # Address must come from Sage's get_sync_status, not from any explicit argument
    assert client.split_calls[0]["addresses"] == ["xch1sage_recv"]
    assert client.split_calls[0]["amount"] == 1000
    assert client.split_calls[0]["asset_id"] == "ae1536aa"


def test_sage_preflight_receive_address_override(monkeypatch: Any) -> None:
    """Explicit receive_address overrides the Sage sync-status address."""
    client = _FakeSageClient(
        coins_sequence=[_sage_coins([]), _sage_coins([1000])],
        receive_address="xch1sage_default",
    )
    _patch_sage_client(monkeypatch, client)
    monkeypatch.setattr("greenfloor.cli.manager.time.sleep", lambda _: None)
    monkeypatch.setattr("greenfloor.cli.manager._get_monotonic", _monotonic_from(0.0, 5.0, 5.0))

    from greenfloor.cli.manager import _sage_preflight_cat_split

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        receive_address="xch1explicit_override",  # must win over sage default
        offer_mojos=1000,
        number_of_coins=1,
        wait_seconds=120,
    )
    assert rc == 0
    assert client.split_calls[0]["addresses"] == ["xch1explicit_override"]


# ---------------------------------------------------------------------------
# correct number of split addresses
# ---------------------------------------------------------------------------


def test_sage_preflight_creates_correct_number_of_addresses(monkeypatch: Any) -> None:
    """bulk_send_cat should receive one address entry per missing coin."""
    client = _FakeSageClient(
        coins_sequence=[
            _sage_coins([500]),              # initial: 1 of 3 exactly-denominated
            _sage_coins([500, 500, 500]),    # poll: 3 eligible, done
        ],
        receive_address="xch1sage_recv",
    )
    _patch_sage_client(monkeypatch, client)
    monkeypatch.setattr("greenfloor.cli.manager.time.sleep", lambda _: None)
    monkeypatch.setattr("greenfloor.cli.manager._get_monotonic", _monotonic_from(0.0, 5.0, 5.0))

    from greenfloor.cli.manager import _sage_preflight_cat_split

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        offer_mojos=500,
        number_of_coins=3,
        wait_seconds=120,
    )
    assert rc == 0
    assert len(client.split_calls) == 1
    # 2 missing coins → 2 address entries
    assert client.split_calls[0]["addresses"] == ["xch1sage_recv", "xch1sage_recv"]
    assert client.split_calls[0]["amount"] == 500


# ---------------------------------------------------------------------------
# timeout with warning
# ---------------------------------------------------------------------------


def test_sage_preflight_times_out_and_emits_warning(monkeypatch: Any, capsys: Any) -> None:
    """Return 3 on timeout; verify the still_waiting warning fires at warning_interval."""
    client = _FakeSageClient(
        coins_sequence=[_sage_coins([])] * 5,
        receive_address="xch1sage_recv",
    )
    _patch_sage_client(monkeypatch, client)
    # start=0.0, poll-1 elapsed=50.0 (< 120 → continue; ≥ 30 → warning), poll-2 elapsed=130.0 (timeout)
    monkeypatch.setattr("greenfloor.cli.manager.time.sleep", lambda _: None)
    # Patch _get_monotonic (not time.monotonic) so asyncio's internal
    # ProactorEventLoop calls are not intercepted by our mock.
    monkeypatch.setattr(
        "greenfloor.cli.manager._get_monotonic",
        _monotonic_from(0.0, 50.0, 50.0, 130.0),
    )

    from greenfloor.cli.manager import _sage_preflight_cat_split

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        offer_mojos=1000,
        number_of_coins=1,
        wait_seconds=120,
        warning_interval=30.0,
    )
    assert rc == 3
    out = capsys.readouterr().out
    # _format_json_output produces pretty-printed multi-line JSON blobs; parse all
    # top-level objects sequentially using JSONDecoder.raw_decode.
    decoder = json.JSONDecoder()
    messages: list[dict] = []
    pos = 0
    while pos < len(out):
        while pos < len(out) and out[pos] in " \t\n\r":
            pos += 1
        if pos >= len(out):
            break
        obj, pos = decoder.raw_decode(out, pos)
        messages.append(obj)
    results = [m["result"] for m in messages]
    assert "still_waiting" in results
    assert "timeout" in results


# ---------------------------------------------------------------------------
# split RPC error
# ---------------------------------------------------------------------------


def test_sage_preflight_split_failed_returns_3(monkeypatch: Any) -> None:
    """Return 3 when bulk_send_cat raises SageRpcError."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    from greenfloor.cli.manager import _sage_preflight_cat_split

    client = _FakeSageClient(
        coins_sequence=[_sage_coins([])],
        split_error=SageRpcError(500, "Insufficient balance", "bulk_send_cat"),
        receive_address="xch1sage_recv",
    )
    _patch_sage_client(monkeypatch, client)

    rc = _sage_preflight_cat_split(
        asset_id="ae1536aa",
        offer_mojos=1000,
        number_of_coins=1,
    )
    assert rc == 3
