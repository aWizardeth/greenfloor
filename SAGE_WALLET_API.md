# Sage Wallet API — GreenFloor Integration Reference

Sage is a local Chia wallet application that exposes a Mutual-TLS HTTPS RPC server on
`127.0.0.1:9257`. GreenFloor communicates with it via `greenfloor.adapters.sage_rpc`.

---

## How Detection Works

`sage_certs_present()` checks whether the Sage-generated certificate and key files exist on
disk. If they do, `build-and-post-offer` automatically routes offer construction through the
Sage RPC instead of the BLS signing path.

| OS | Certificate directory |
|----|-----------------------|
| Windows | `%APPDATA%\com.rigidnetwork.sage\ssl\` |
| macOS | `~/Library/Application Support/com.rigidnetwork.sage/ssl/` |
| Linux | `~/.local/share/com.rigidnetwork.sage/ssl/` |

Files expected: `wallet.crt` and `wallet.key`.

---

## `SageRpcClient`

`greenfloor.adapters.sage_rpc.SageRpcClient`

Async aiohttp-based client using Mutual TLS. Sage acts as both the TLS server and validates
the same `wallet.crt` / `wallet.key` as the allowed client certificate.

### Construction

```python
from greenfloor.adapters.sage_rpc import SageRpcClient, resolve_sage_client

# Explicit paths
client = SageRpcClient(cert_path="/path/to/wallet.crt", key_path="/path/to/wallet.key")

# Auto-detect from OS data directory (recommended)
client = resolve_sage_client()

# Custom port / host
client = resolve_sage_client(port=9257, host="127.0.0.1")
```

`SageRpcClient` is an async context manager:

```python
async with resolve_sage_client() as client:
    status = await client.get_sync_status()
```

### Constructor Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cert_path` | `str \| Path` | — | Path to `wallet.crt` |
| `key_path` | `str \| Path` | — | Path to `wallet.key` |
| `port` | `int` | `9257` | Sage RPC port |
| `host` | `str` | `"127.0.0.1"` | Sage RPC host |

---

## Factory Helpers

### `resolve_sage_client`

```python
def resolve_sage_client(
    *,
    port: int = 9257,
    cert_path: str | None = None,
    key_path: str | None = None,
    host: str = "127.0.0.1",
) -> SageRpcClient
```

Returns a `SageRpcClient` using explicit paths or OS-detected defaults.

### `sage_certs_present`

```python
def sage_certs_present(
    cert_path: str | None = None,
    key_path: str | None = None,
) -> bool
```

Returns `True` if both cert and key files exist. Used by `build-and-post-offer` to
decide the signing path at runtime.

---

## Typed RPC Methods

### `get_version() → dict`

Returns the Sage application version.

```python
result = await client.get_version()
# {"version": "0.x.y"}
```

### `get_sync_status() → dict`

Returns wallet sync state.

```python
result = await client.get_sync_status()
# {"synced": true, "synced_coins": true, ...}
```

### `get_keys() → dict`

Returns all wallet key fingerprints known to Sage.

```python
result = await client.get_keys()
# {"keys": [{"fingerprint": 1234567890, ...}, ...]}
```

### `get_key(fingerprint=None) → dict`

Returns a single key record. Pass `None` to get the currently active key.

### `login(fingerprint: int) → dict`

Login to the wallet with the given fingerprint.

```python
await client.login(fingerprint=1234567890)
```

### `logout() → dict`

Logout of the current active key.

### `get_coins(*, asset_id=None, limit=100, offset=0) → dict`

List coins held by the active key.

- `asset_id=None` returns XCH coins.
- Pass a 64-character hex string to filter by CAT asset ID.

```python
# XCH coins
xch_coins = await client.get_coins()

# CAT coins
cat_coins = await client.get_coins(asset_id="ae1536f5...")
```

### `get_cats() → dict`

Returns all CAT tokens held by the active key with `name`, `ticker`, and `icon_url`.

```python
cats = await client.get_cats()
# {"cats": [{"asset_id": "ae1536...", "name": "BYC", "ticker": "BYC", ...}, ...]}
```

### `get_token(asset_id: str | None) → dict`

Return a single token record. Pass `None` for XCH.

### `make_offer(offer_params: dict) → dict`

**The primary GreenFloor endpoint.** Creates a signed offer and returns the `offer1...`
Bech32m string.

#### Request body

```json
{
    "offered_assets": [
        {"asset_id": null, "amount": 382000000000}
    ],
    "requested_assets": [
        {"asset_id": "ae1536f56760e471ad85ead45f00d680ff9cca73b8cc3407be778f1c0c606eac", "amount": 1000}
    ],
    "fee": 0,
    "expiration_seconds": 3600
}
```

- `asset_id: null` means XCH.
- `asset_id: "<hex>"` is a 64-character CAT asset ID hex string.
- `amount` is always in **mojos**:
  - XCH: `1 XCH = 1_000_000_000_000 mojos`
  - CAT: `1 CAT unit = 1_000 mojos`

#### Sell side (offer CAT, request XCH)

```python
offer_params = {
    "offered_assets": [{"asset_id": "<cat-id>", "amount": size_base_units * 1000}],
    "requested_assets": [{"asset_id": None, "amount": int(size_base_units * price_xch_per_base * 1_000_000_000_000)}],
    "fee": 0,
    "expiration_seconds": 3600,
}
result = await client.make_offer(offer_params)
offer_str = result["offer"]  # "offer1..."
```

#### Buy side (offer XCH, request CAT)

```python
offer_params = {
    "offered_assets": [{"asset_id": None, "amount": int(size_base_units * price_xch_per_base * 1_000_000_000_000)}],
    "requested_assets": [{"asset_id": "<cat-id>", "amount": size_base_units * 1000}],
    "fee": 0,
    "expiration_seconds": 3600,
}
result = await client.make_offer(offer_params)
offer_str = result["offer"]  # "offer1..."
```

#### Response

```json
{"offer": "offer1..."}
```

### `sign_coin_spends(body: dict) → dict`

Sign a set of coin spends with the active key.

### `submit_transaction(body: dict) → dict`

Submit a signed transaction to the network.

### `view_offer(offer: str) → dict`

Decode and return a human-readable summary of an `offer1...` string.

### `bulk_send_cat(*, asset_id, addresses, amount, fee=0, auto_submit=True, include_hint=True) → dict`

Send `amount` mojos of `asset_id` to each address in `addresses`.

Useful for coin splitting: pass the same receive address N times to create N coins of
exactly `amount` mojos each from existing wallet holdings. Change stays in the wallet.

```python
await client.bulk_send_cat(
    asset_id="ae1536f5...",
    addresses=["xch1abc...", "xch1abc...", "xch1abc..."],  # same address = 3 equal coins
    amount=1000,  # mojos per coin
    fee=0,
    auto_submit=True,
)
```

### `call(endpoint: str, body: dict | None = None) → Any`

Low-level method that calls any Sage endpoint by name.

```python
result = await client.call("get_version", {})
result = await client.call("make_offer", offer_params)
```

---

## `SageRpcError`

Raised when Sage returns a non-200 HTTP status.

```python
from greenfloor.adapters.sage_rpc import SageRpcError

try:
    result = await client.make_offer(params)
except SageRpcError as exc:
    print(exc.status)    # HTTP status code
    print(exc.body)      # raw response body
    print(exc.endpoint)  # endpoint name, e.g. "make_offer"
    print(exc.to_dict()) # {"error": ..., "status": ..., "endpoint": ...}
```

---

## GreenFloor Offer Builder Dispatch

`greenfloor.cli.offer_builder_sdk.build_offer_text(payload)` selects the signing path:

1. **Sage RPC** — when `payload["use_sage_wallet"]` is `True` (set automatically when `sage_certs_present()` returns `True`).
2. **External subprocess** — when `GREENFLOOR_OFFER_BUILDER_CMD` env var is set.
3. **BLS / chia-wallet-sdk** — default in-process signing path.

The Sage path calls `_sage_make_offer_async`, which translates the internal GreenFloor
payload into a Sage `make_offer` body and returns the `offer1...` string.

### Mojo override fields (buy-side)

When `side == "buy"`, `_build_and_post_offer` sets `offer_mojos_override` and
`request_mojos_override` in the payload to bypass the default `size * price * multiplier`
formula. The Sage path honours these overrides directly:

```python
# In payload:
{
    "offer_mojos_override": 382000000000,   # exact XCH mojos to offer
    "request_mojos_override": 1000,         # exact CAT mojos to request
    "use_sage_wallet": True,
    ...
}
```

---

## Web UI Integration

The web UI (`greenfloor.webui.server`) exposes these Sage-specific endpoints:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sage-rpc/status` | Reachability check + `get_sync_status` |
| GET | `/api/sage-rpc/keys` | `get_keys` result |
| POST | `/api/sage-rpc/login` | `login` with `{"fingerprint": <int>}` |
| POST | `/api/sage-rpc/call` | Raw passthrough: `{"endpoint": "...", "body": {...}}` |
| GET | `/api/sage-rpc/coins` | `get_coins` with optional `?asset_id=` query param |
| GET | `/api/sage-rpc/cats` | `get_cats` result |

The dashboard detects Sage availability on load and shows a **Sage status badge** with sync
state. When Sage is present, the **Build & Post Offer** card routes through the Sage path
automatically and `use_sage_wallet: true` is injected into the stream request body.
