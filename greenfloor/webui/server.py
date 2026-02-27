"""GreenFloor Web UI – aiohttp server.

Launch:
    python -m greenfloor.webui
    python -m greenfloor.webui --port 8765 --host 0.0.0.0
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

from aiohttp import web

from greenfloor.webui.market_loop import MarketLoop

logger = logging.getLogger("greenfloor.webui")

# ---------------------------------------------------------------------------
# Config path helpers
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[2]
_VENV_BIN = Path(sys.executable).parent


def _manager_cmd() -> str:
    candidates = [
        _VENV_BIN / "greenfloor-manager",
        _VENV_BIN / "greenfloor-manager.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "greenfloor-manager"  # fall back to PATH


def _default_config_paths() -> tuple[str, str]:
    home_cfg = Path.home() / ".greenfloor" / "config"
    program = home_cfg / "program.yaml"
    markets = home_cfg / "markets.yaml"
    if not program.exists():
        program = _REPO_ROOT / "config" / "program.yaml"
    if not markets.exists():
        markets = _REPO_ROOT / "config" / "markets.yaml"
    return str(program), str(markets)


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

async def _run(
    *extra_args: str,
    timeout: int = 60,
    program_path: str | None = None,
    markets_path: str | None = None,
) -> dict[str, Any]:
    prog, mkts = _default_config_paths()
    program_path = program_path or prog
    markets_path = markets_path or mkts
    cmd = [
        _manager_cmd(),
        "--program-config", program_path,
        "--markets-config", markets_path,
        "--json",
        *extra_args,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        raw = stdout.decode(errors="replace")
        err = stderr.decode(errors="replace")
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "raw": raw,
            "parsed": parsed,
            "stderr": err,
            "cmd": cmd,
        }
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timeout", "cmd": cmd}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "cmd": cmd}


async def _stream(
    response: web.StreamResponse,
    *extra_args: str,
    timeout: int = 300,
    program_path: str | None = None,
    markets_path: str | None = None,
) -> None:
    """Write SSE lines to an already-prepared StreamResponse."""
    prog, mkts = _default_config_paths()
    program_path = program_path or prog
    markets_path = markets_path or mkts
    cmd = [
        _manager_cmd(),
        "--program-config", program_path,
        "--markets-config", markets_path,
        "--json",
        *extra_args,
    ]

    async def _send(event_type: str, data: Any) -> None:
        payload = json.dumps({"type": event_type, "data": data})
        await response.write(f"data: {payload}\n\n".encode())

    await _send("cmd", {"cmd": " ".join(cmd)})

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None
        assert proc.stderr is not None

        async def _read_pipe(pipe: asyncio.StreamReader, is_stderr: bool) -> None:
            async for raw_line in pipe:
                line = raw_line.decode(errors="replace").rstrip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                    evt = "stderr_line" if is_stderr else "json_line"
                    await _send(evt, parsed)
                except json.JSONDecodeError:
                    evt = "stderr_text" if is_stderr else "text_line"
                    await _send(evt, line)

        await asyncio.wait_for(
            asyncio.gather(_read_pipe(proc.stdout, False), _read_pipe(proc.stderr, True)),
            timeout=timeout,
        )
        await proc.wait()
        await _send("done", {"exit_code": proc.returncode, "ok": proc.returncode == 0})
    except asyncio.TimeoutError:
        await _send("error", {"message": "command timed out"})
    except Exception as exc:
        await _send("error", {"message": str(exc)})


# ---------------------------------------------------------------------------
# Route handlers
# ---------------------------------------------------------------------------

async def handle_index(request: web.Request) -> web.Response:
    return web.Response(text=_HTML, content_type="text/html")


async def handle_doctor(request: web.Request) -> web.Response:
    result = await _run("doctor")
    return web.json_response(result)


async def handle_config_validate(request: web.Request) -> web.Response:
    result = await _run("config-validate")
    return web.json_response(result)


async def handle_offers_status(request: web.Request) -> web.Response:
    limit = request.rel_url.query.get("limit", "50")
    events_limit = request.rel_url.query.get("events_limit", "30")
    market_id = request.rel_url.query.get("market_id", "")
    extra: list[str] = ["offers-status", "--limit", limit, "--events-limit", events_limit]
    if market_id:
        extra += ["--market-id", market_id]
    result = await _run(*extra)
    return web.json_response(result)


async def handle_offers_reconcile(request: web.Request) -> web.Response:
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    limit = str(body.get("limit", 200))
    market_id = body.get("market_id", "")
    extra: list[str] = ["offers-reconcile", "--limit", limit]
    if market_id:
        extra += ["--market-id", market_id]
    result = await _run(*extra, timeout=120)
    return web.json_response(result)


async def handle_coins_list(request: web.Request) -> web.Response:
    asset = request.rel_url.query.get("asset", "")
    extra: list[str] = ["coins-list"]
    if asset:
        extra += ["--asset", asset]
    result = await _run(*extra, timeout=60)
    return web.json_response(result)


async def handle_config_paths(request: web.Request) -> web.Response:
    prog, mkts = _default_config_paths()
    return web.json_response({
        "program_config": prog,
        "markets_config": mkts,
        "manager_cmd": _manager_cmd(),
        "python": sys.executable,
    })


async def handle_config_read(request: web.Request) -> web.Response:
    """Return the current program.yaml as JSON."""
    try:
        import yaml as _yaml
        prog, _ = _default_config_paths()
        with open(prog, "r", encoding="utf-8") as f:
            data = _yaml.safe_load(f)
        return web.json_response({"ok": True, "path": prog, "config": data})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_config_write(request: web.Request) -> web.Response:
    """Patch specific keys in program.yaml and save."""
    try:
        import yaml as _yaml
        body = await request.json()
        prog, _ = _default_config_paths()

        with open(prog, "r", encoding="utf-8") as f:
            data = _yaml.safe_load(f) or {}

        # Apply patches from body — each key is a dot-path like "cloud_wallet.base_url"
        patches: dict[str, Any] = body.get("patches", {})
        for dot_path, value in patches.items():
            parts = dot_path.split(".")
            node = data
            for part in parts[:-1]:
                if part not in node or not isinstance(node[part], dict):
                    node[part] = {}
                node = node[part]
            node[parts[-1]] = value

        with open(prog, "w", encoding="utf-8") as f:
            _yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)

        return web.json_response({"ok": True, "path": prog})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


# ---------------------------------------------------------------------------
# Sage Wallet RPC proxy handlers
#
# Architecture: the browser cannot speak mTLS directly to Sage's local RPC.
# These handlers act as a transparent proxy – the frontend calls the GreenFloor
# Python API, which forwards the request to Sage using the local cert pair.
# ---------------------------------------------------------------------------

def _load_sage_rpc_cfg() -> dict[str, Any]:
    """Return the sage_rpc sub-section from the current program.yaml."""
    try:
        import yaml as _yaml
        prog, _ = _default_config_paths()
        with open(prog, "r", encoding="utf-8") as f:
            data = _yaml.safe_load(f) or {}
        return dict(data.get("sage_rpc", {}))
    except Exception:
        return {}


def _build_sage_client() -> "Any":
    """Build a SageRpcClient from config (or auto-detected cert paths)."""
    from greenfloor.adapters.sage_rpc import resolve_sage_client
    cfg = _load_sage_rpc_cfg()
    return resolve_sage_client(
        port=int(cfg.get("port") or 9257),
        cert_path=str(cfg.get("cert_path") or "") or None,
        key_path=str(cfg.get("key_path") or "") or None,
    )


async def handle_sage_rpc_status(request: web.Request) -> web.Response:
    """Test the Sage RPC connection and return version + sync status + logged-in key."""
    from greenfloor.adapters.sage_rpc import SageRpcError, sage_certs_present
    cfg = _load_sage_rpc_cfg()
    enabled = bool(cfg.get("enabled", False))
    cert_path = str(cfg.get("cert_path") or "") or None
    key_path = str(cfg.get("key_path") or "") or None

    certs_ok = sage_certs_present(cert_path, key_path)
    if not certs_ok:
        return web.json_response({
            "ok": False,
            "connected": False,
            "enabled": enabled,
            "error": "Sage wallet cert/key not found. Enable the Sage RPC server in Sage Settings -> RPC.",
            "cert_path": cert_path,
        })

    try:
        client = _build_sage_client()
        async with client:
            version = await client.get_version()
            sync = await client.get_sync_status()
            key = await client.get_key()
        return web.json_response({
            "ok": True,
            "connected": True,
            "enabled": enabled,
            "version": version,
            "sync_status": sync,
            "active_key": key.get("key"),
        })
    except SageRpcError as exc:
        return web.json_response({
            "ok": False,
            "connected": False,
            "enabled": enabled,
            "error": str(exc),
            "http_status": exc.status,
        })
    except Exception as exc:
        return web.json_response({
            "ok": False,
            "connected": False,
            "enabled": enabled,
            "error": str(exc),
        })


async def handle_sage_rpc_keys(request: web.Request) -> web.Response:
    """Return the list of keys known to the Sage wallet."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    try:
        client = _build_sage_client()
        async with client:
            result = await client.get_keys()
        return web.json_response({"ok": True, "keys": result.get("keys", [])})
    except SageRpcError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=exc.status or 500)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_sage_rpc_login(request: web.Request) -> web.Response:
    """Login to a Sage wallet key by fingerprint."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    try:
        body = await request.json()
        fingerprint = int(body["fingerprint"])
        client = _build_sage_client()
        async with client:
            result = await client.login(fingerprint)
        return web.json_response({"ok": True, "result": result})
    except SageRpcError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=exc.status or 500)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=400)


async def handle_sage_rpc_call(request: web.Request) -> web.Response:
    """Generic passthrough proxy: POST {"endpoint": "...", "body": {...}} -> Sage RPC."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    try:
        req_body = await request.json()
        endpoint = str(req_body.get("endpoint", "")).strip()
        if not endpoint:
            return web.json_response({"ok": False, "error": "endpoint is required"}, status=400)
        call_body = req_body.get("body") or {}
        client = _build_sage_client()
        async with client:
            result = await client.call(endpoint, call_body)
        return web.json_response({"ok": True, "result": result})
    except SageRpcError as exc:
        return web.json_response({"ok": False, **exc.to_dict()}, status=exc.status or 500)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_sage_rpc_coins(request: web.Request) -> web.Response:
    """Return the full coin list from the active Sage wallet key."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    try:
        asset_id = request.rel_url.query.get("asset_id", "").strip() or None
        limit = int(request.rel_url.query.get("limit", "500"))
        offset = int(request.rel_url.query.get("offset", "0"))
        client = _build_sage_client()
        async with client:
            result = await client.get_coins(asset_id=asset_id, limit=limit, offset=offset)
        return web.json_response({"ok": True, **result})
    except SageRpcError as exc:
        return web.json_response({"ok": False, **exc.to_dict()}, status=exc.status or 500)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_sage_rpc_cats(request: web.Request) -> web.Response:
    """Return all CAT tokens (with name/ticker/icon_url) for the active Sage key."""
    from greenfloor.adapters.sage_rpc import SageRpcError
    try:
        client = _build_sage_client()
        async with client:
            result = await client.get_cats()
        return web.json_response({"ok": True, "cats": result.get("cats", [])})
    except SageRpcError as exc:
        return web.json_response({"ok": False, **exc.to_dict()}, status=exc.status or 500)
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_prices(request: web.Request) -> web.Response:
    """Return XCH/USD price (coincodex) and CAT/XCH tickers (Dexie v3)."""
    import aiohttp

    xch_usd: float = 0.0
    tickers: list = []

    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(
                "https://coincodex.com/api/coincodex/get_coin/xch", timeout=aiohttp.ClientTimeout(total=8)
            ) as r:
                data = await r.json(content_type=None)
                xch_usd = float(data.get("last_price_usd", 0))
        except Exception:
            pass

        try:
            async with session.get(
                "https://api.dexie.space/v3/prices/tickers", timeout=aiohttp.ClientTimeout(total=10)
            ) as r:
                payload = await r.json(content_type=None)
                tickers = payload if isinstance(payload, list) else payload.get("tickers", [])
        except Exception:
            pass

    return web.json_response({"ok": True, "xch_usd": xch_usd, "tickers": tickers})


async def handle_markets_list(request: web.Request) -> web.Response:
    """Return the markets array from markets.yaml as JSON."""
    try:
        import yaml as _yaml
        _, mkts_path = _default_config_paths()
        with open(mkts_path, "r", encoding="utf-8") as f:
            data = _yaml.safe_load(f) or {}
        return web.json_response({"ok": True, "markets": data.get("markets", [])})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


async def handle_markets_write(request: web.Request) -> web.Response:
    """Write the full markets array back to markets.yaml, preserving other top-level keys."""
    try:
        import yaml as _yaml
        body = await request.json()
        markets = body.get("markets", [])
        _, mkts_path = _default_config_paths()
        with open(mkts_path, "r", encoding="utf-8") as f:
            data = _yaml.safe_load(f) or {}
        data["markets"] = markets
        with open(mkts_path, "w", encoding="utf-8") as f:
            _yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
        return web.json_response({"ok": True, "count": len(markets)})
    except Exception as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=500)


# ---------------------------------------------------------------------------
# Market loop handlers
# ---------------------------------------------------------------------------

async def handle_market_loop_status(request: web.Request) -> web.Response:
    loop: MarketLoop = request.app["market_loop"]
    return web.json_response(loop.status())


async def handle_market_loop_start(request: web.Request) -> web.Response:
    loop: MarketLoop = request.app["market_loop"]
    status = loop.status()
    if not status["sage_connected"]:
        return web.json_response({"ok": False, "error": "sage_not_connected"}, status=400)
    if status["enabled_markets"] == 0:
        return web.json_response({"ok": False, "error": "no_enabled_markets"}, status=400)
    loop.start()
    return web.json_response({"ok": True, "status": loop.status()})


async def handle_market_loop_stop(request: web.Request) -> web.Response:
    loop: MarketLoop = request.app["market_loop"]
    loop.stop()
    return web.json_response({"ok": True, "status": loop.status()})


async def handle_market_loop_trigger(request: web.Request) -> web.Response:
    loop: MarketLoop = request.app["market_loop"]
    status = loop.status()
    if not status["sage_connected"]:
        return web.json_response({"ok": False, "error": "sage_not_connected"}, status=400)
    if status["enabled_markets"] == 0:
        return web.json_response({"ok": False, "error": "no_enabled_markets"}, status=400)
    result = await loop.trigger_once()
    return web.json_response({"ok": True, "result": result})


# ---------------------------------------------------------------------------
# SSE handlers for long-running commands
# ---------------------------------------------------------------------------

async def handle_build_offer_stream(request: web.Request) -> web.StreamResponse:
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    pair = body.get("pair", "")
    size = str(body.get("size_base_units", 1))
    network = body.get("network", "mainnet")
    dry_run = bool(body.get("dry_run", False))
    venue = body.get("venue", "")

    extra: list[str] = ["build-and-post-offer", "--pair", pair, "--size-base-units", size]
    if network and network != "mainnet":
        extra += ["--network", network]
    if dry_run:
        extra.append("--dry-run")
    if venue:
        extra += ["--venue", venue]

    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    await response.prepare(request)
    await _stream(response, *extra, timeout=120)
    return response


async def handle_coin_split_stream(request: web.Request) -> web.StreamResponse:
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    pair = body.get("pair", "")
    coin_id = body.get("coin_id", "")
    amount_per_coin = str(body.get("amount_per_coin", 0))
    number_of_coins = str(body.get("number_of_coins", 0))
    network = body.get("network", "mainnet")
    no_wait = bool(body.get("no_wait", False))

    extra: list[str] = [
        "coin-split",
        "--pair", pair,
        "--amount-per-coin", amount_per_coin,
        "--number-of-coins", number_of_coins,
    ]
    if coin_id:
        extra += ["--coin-id", coin_id]
    if network and network != "mainnet":
        extra += ["--network", network]
    if no_wait:
        extra.append("--no-wait")

    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    await response.prepare(request)
    await _stream(response, *extra, timeout=300)
    return response


async def handle_coin_combine_stream(request: web.Request) -> web.StreamResponse:
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    pair = body.get("pair", "")
    input_coin_count = str(body.get("input_coin_count", 2))
    asset_id = body.get("asset_id", "")
    network = body.get("network", "mainnet")
    no_wait = bool(body.get("no_wait", False))

    extra: list[str] = ["coin-combine", "--pair", pair, "--input-coin-count", input_coin_count]
    if asset_id:
        extra += ["--asset-id", asset_id]
    if network and network != "mainnet":
        extra += ["--network", network]
    if no_wait:
        extra.append("--no-wait")

    response = web.StreamResponse()
    response.headers["Content-Type"] = "text/event-stream"
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    await response.prepare(request)
    await _stream(response, *extra, timeout=300)
    return response


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

async def _on_startup(app: web.Application) -> None:
    """Auto-start the market loop when Sage is connected and markets are enabled."""
    from greenfloor.adapters.sage_rpc import sage_certs_present
    loop: MarketLoop = app["market_loop"]
    status = loop.status()
    if status["sage_connected"] and status["enabled_markets"] > 0:
        loop.start()
        logger.info(
            "market_loop auto-started: sage_connected=True enabled_markets=%d",
            status["enabled_markets"],
        )
    else:
        reasons = []
        if not status["sage_connected"]:
            reasons.append("sage_not_connected")
        if status["enabled_markets"] == 0:
            reasons.append("no_enabled_markets")
        logger.info("market_loop not auto-started: %s", ", ".join(reasons))


async def _on_cleanup(app: web.Application) -> None:
    app["market_loop"].stop()


def create_app() -> web.Application:
    prog, mkts = _default_config_paths()
    market_loop = MarketLoop(
        program_path=Path(prog),
        markets_path=Path(mkts),
    )

    app = web.Application()
    app["market_loop"] = market_loop
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    app.router.add_get("/", handle_index)
    app.router.add_get("/api/doctor", handle_doctor)
    app.router.add_get("/api/config-validate", handle_config_validate)
    app.router.add_get("/api/config-paths", handle_config_paths)
    app.router.add_get("/api/config-read", handle_config_read)
    app.router.add_post("/api/config-write", handle_config_write)
    app.router.add_get("/api/offers-status", handle_offers_status)
    app.router.add_post("/api/offers-reconcile", handle_offers_reconcile)
    app.router.add_get("/api/coins-list", handle_coins_list)
    app.router.add_post("/api/build-offer/stream", handle_build_offer_stream)
    app.router.add_post("/api/coin-split/stream", handle_coin_split_stream)
    app.router.add_post("/api/coin-combine/stream", handle_coin_combine_stream)
    app.router.add_get("/api/sage-rpc/status", handle_sage_rpc_status)
    app.router.add_get("/api/sage-rpc/keys", handle_sage_rpc_keys)
    app.router.add_post("/api/sage-rpc/login", handle_sage_rpc_login)
    app.router.add_post("/api/sage-rpc/call", handle_sage_rpc_call)
    app.router.add_get("/api/sage-rpc/coins", handle_sage_rpc_coins)
    app.router.add_get("/api/sage-rpc/cats", handle_sage_rpc_cats)
    app.router.add_get("/api/prices", handle_prices)
    app.router.add_get("/api/markets-list", handle_markets_list)
    app.router.add_post("/api/markets-write", handle_markets_write)
    app.router.add_get("/api/market-loop/status", handle_market_loop_status)
    app.router.add_post("/api/market-loop/start", handle_market_loop_start)
    app.router.add_post("/api/market-loop/stop", handle_market_loop_stop)
    app.router.add_post("/api/market-loop/trigger", handle_market_loop_trigger)
    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="GreenFloor Web UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # Windows: use ProactorEventLoop so asyncio.create_subprocess_exec works.
    # aiohttp 3.8+ is fully compatible with ProactorEventLoop on Windows.
    if sys.platform == "win32":
        import asyncio
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

    app = create_app()
    print(f"GreenFloor Web UI -> http://{args.host}:{args.port}", flush=True)
    web.run_app(app, host=args.host, port=args.port, print=None, handle_signals=True)


# ---------------------------------------------------------------------------
# Embedded HTML/CSS/JS frontend
# ---------------------------------------------------------------------------

_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GreenFloor</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface2: #21262d;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --blue: #58a6ff;
    --purple: #bc8cff;
    --accent: #238636;
    --accent-hover: #2ea043;
    --font-mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }

  /* ── Sidebar ── */
  #sidebar {
    width: 220px; min-width: 220px; background: var(--surface); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; padding: 0;
  }
  #sidebar-header {
    padding: 20px 16px 16px; border-bottom: 1px solid var(--border);
  }
  #sidebar-header h1 { font-size: 18px; font-weight: 700; color: var(--green); }
  #sidebar-header p  { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
  nav { padding: 8px 0; flex: 1; }
  nav a {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 16px; color: var(--text-muted); text-decoration: none; font-size: 14px;
    border-left: 3px solid transparent; cursor: pointer; transition: all .15s;
  }
  nav a:hover { background: var(--surface2); color: var(--text); }
  nav a.active { color: var(--text); background: var(--surface2); border-left-color: var(--green); }
  nav a .icon { font-size: 16px; width: 20px; text-align: center; }
  #sidebar-footer { padding: 12px 16px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }

  /* ── Main ── */
  #main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #topbar {
    height: 52px; min-height: 52px; background: var(--surface); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 24px; gap: 16px;
  }
  #topbar h2 { font-size: 16px; font-weight: 600; flex: 1; }
  #content { flex: 1; overflow-y: auto; padding: 24px; }

  /* ── Cards ── */
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; margin-bottom: 20px;
  }
  .card-title { font-size: 13px; font-weight: 600; color: var(--text-muted);
                text-transform: uppercase; letter-spacing: .05em; margin-bottom: 16px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }

  /* ── Stat pills ── */
  .stat { background: var(--surface2); border-radius: 6px; padding: 14px 16px; }
  .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .05em; }
  .stat-value { font-size: 22px; font-weight: 700; margin-top: 4px; }

  /* ── Badges ── */
  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 20px;
  }
  .badge-green  { background: rgba(63,185,80,.15);  color: var(--green); }
  .badge-red    { background: rgba(248,81,73,.15);  color: var(--red); }
  .badge-yellow { background: rgba(210,153,34,.15); color: var(--yellow); }
  .badge-blue   { background: rgba(88,166,255,.15); color: var(--blue); }
  .badge-muted  { background: var(--surface2); color: var(--text-muted); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }

  /* ── Table ── */
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; color: var(--text-muted); font-weight: 600;
       font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
       border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--surface2); }
  .truncate { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Buttons ── */
  .btn {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;
    border: 1px solid transparent; transition: all .15s;
  }
  .btn-primary   { background: var(--accent); color: #fff; border-color: var(--accent-hover); }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-secondary { background: var(--surface2); color: var(--text); border-color: var(--border); }
  .btn-secondary:hover { background: var(--border); }
  .btn-danger    { background: rgba(248,81,73,.15); color: var(--red); border-color: rgba(248,81,73,.3); }
  .btn-danger:hover { background: rgba(248,81,73,.25); }
  .btn:disabled  { opacity: .5; cursor: not-allowed; }
  .btn-group     { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  /* ── Forms ── */
  label    { font-size: 12px; font-weight: 600; color: var(--text-muted); display: block; margin-bottom: 5px; }
  input, select {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 8px 12px; font-size: 13px; outline: none;
    transition: border-color .15s;
  }
  input:focus, select:focus { border-color: var(--blue); }
  .form-group { margin-bottom: 16px; }
  .form-row   { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; }
  .checkbox-row input { width: auto; }
  .checkbox-row label { margin: 0; font-size: 13px; color: var(--text); }
  .form-hint { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

  /* ── Terminal / stream output ── */
  .terminal {
    background: #010409; border: 1px solid var(--border); border-radius: 6px;
    font-family: var(--font-mono); font-size: 12px; padding: 14px;
    max-height: 420px; overflow-y: auto; color: #c9d1d9; line-height: 1.6;
  }
  .terminal .ln-cmd    { color: var(--text-muted); margin-bottom: 6px; }
  .terminal .ln-ok     { color: var(--green); }
  .terminal .ln-err    { color: var(--red); }
  .terminal .ln-warn   { color: var(--yellow); }
  .terminal .ln-info   { color: var(--blue); }
  .terminal .ln-done   { font-weight: 700; }
  .terminal .ln-json   { color: #c9d1d9; }
  .terminal .key       { color: var(--purple); }
  .terminal .str       { color: var(--green); }
  .terminal .num       { color: var(--blue); }
  .terminal .bool-t    { color: var(--green); }
  .terminal .bool-f    { color: var(--red); }

  /* ── JSON viewer ── */
  .json-view { font-family: var(--font-mono); font-size: 12px; line-height: 1.7; white-space: pre-wrap; word-break: break-all; }
  .json-view .key  { color: var(--purple); }
  .json-view .str  { color: var(--green); }
  .json-view .num  { color: var(--blue); }
  .json-view .bool { color: var(--yellow); }
  .json-view .null { color: var(--text-muted); }

  /* ── Check list ── */
  .check-list { display: flex; flex-direction: column; gap: 8px; }
  .check-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
                background: var(--surface2); border-radius: 6px; font-size: 13px; }
  .check-item .ci-icon { font-size: 16px; margin-top: 1px; }
  .check-item .ci-key  { font-weight: 600; margin-bottom: 2px; }
  .check-item .ci-val  { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); }

  /* ── Loading ── */
  .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid var(--border);
             border-top-color: var(--blue); border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-row { display: flex; align-items: center; gap: 10px; color: var(--text-muted);
                 font-size: 13px; padding: 20px 0; }

  /* ── Empty state ── */
  .empty { text-align: center; padding: 40px 20px; color: var(--text-muted); font-size: 13px; }

  /* ── Misc ── */
  .section-header { display: flex; align-items: center; justify-content: space-between;
                    margin-bottom: 16px; }
  .section-header h3 { font-size: 15px; font-weight: 600; }
  code { font-family: var(--font-mono); font-size: 11px; background: var(--surface2);
         padding: 2px 6px; border-radius: 4px; color: var(--blue); }
  .text-muted { color: var(--text-muted); font-size: 12px; }
  .mt-16 { margin-top: 16px; }
  .mb-16 { margin-bottom: 16px; }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>

<!-- Sidebar -->
<div id="sidebar">
  <div id="sidebar-header">
    <h1>🌿 GreenFloor</h1>
    <p>CAT Market Maker</p>
  </div>
  <nav>
    <a class="active" data-page="dashboard"><span class="icon">🏠</span> Dashboard</a>
    <a data-page="offers"><span class="icon">📋</span> Offers</a>
    <a data-page="coins"><span class="icon">💰</span> Coins</a>
    <a data-page="build"><span class="icon">📤</span> Build Offer</a>
    <a data-page="config"><span class="icon">⚙️</span> Config</a>
  </nav>
  <div id="sidebar-footer">
    <div id="env-info">Loading…</div>
  </div>
</div>

<!-- Main -->
<div id="main">
  <div id="topbar">
    <h2 id="page-title">Dashboard</h2>
    <div id="topbar-actions"></div>
  </div>
  <div id="content">
    <div class="loading-row"><div class="spinner"></div> Loading…</div>
  </div>
</div>

<script>
// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function el(tag, attrs={}, ...children) {
  const e = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

function jsonHtml(obj, indent=0) {
  const pad = '  '.repeat(indent);
  const pad1 = '  '.repeat(indent+1);
  if (obj === null) return `<span class="null">null</span>`;
  if (typeof obj === 'boolean') return `<span class="${obj?'bool':'bool'}" style="color:${obj?'var(--green)':'var(--red)'}">${obj}</span>`;
  if (typeof obj === 'number') return `<span class="num">${obj}</span>`;
  if (typeof obj === 'string') return `<span class="str">"${escHtml(obj)}"</span>`;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => `${pad1}${jsonHtml(v, indent+1)}`).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const items = keys.map(k => `${pad1}<span class="key">"${escHtml(k)}"</span>: ${jsonHtml(obj[k], indent+1)}`).join(',\n');
    return `{\n${items}\n${pad}}`;
  }
  return String(obj);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function badge(text, type='muted') {
  const b = el('span', {class:`badge badge-${type}`});
  b.innerHTML = `<span class="dot"></span>${escHtml(text)}`;
  return b;
}

function statusBadge(ok) {
  return badge(ok ? 'OK' : 'FAIL', ok ? 'green' : 'red');
}

async function api(path, opts={}) {
  const r = await fetch(path, opts);
  return r.json();
}

// ---------------------------------------------------------------------------
// JSON pretty viewer
// ---------------------------------------------------------------------------
function renderJson(obj) {
  const pre = el('pre', {class:'json-view'});
  pre.innerHTML = jsonHtml(obj);
  return pre;
}

// ---------------------------------------------------------------------------
// Terminal (SSE stream)
// ---------------------------------------------------------------------------
function createTerminal() {
  const term = el('div', {class:'terminal'});
  term.innerHTML = '<span class="text-muted">Ready.</span>';
  let lineCount = 0;

  function append(html) {
    const line = document.createElement('div');
    line.innerHTML = html;
    if (lineCount === 0) term.innerHTML = '';
    term.appendChild(line);
    lineCount++;
    term.scrollTop = term.scrollHeight;
  }

  function handleEvent(evtType, data) {
    if (evtType === 'cmd') {
      append(`<span class="ln-cmd">$ ${escHtml(data.cmd)}</span>`);
    } else if (evtType === 'json_line') {
      const evtName = data.event || data.type || '';
      const ok = data.ok !== false;
      let cls = 'ln-json';
      if (!ok || evtName.includes('error') || evtName.includes('fail')) cls = 'ln-err';
      else if (evtName.includes('warn')) cls = 'ln-warn';
      else if (evtName.includes('ok') || evtName.includes('success') || evtName.includes('confirm')) cls = 'ln-ok';
      append(`<span class="${cls}">${escHtml(JSON.stringify(data))}</span>`);
    } else if (evtType === 'text_line') {
      append(`<span class="ln-json">${escHtml(data)}</span>`);
    } else if (evtType === 'stderr_text' || evtType === 'stderr_line') {
      append(`<span class="ln-warn">${escHtml(typeof data === 'string' ? data : JSON.stringify(data))}</span>`);
    } else if (evtType === 'done') {
      const cls = data.ok ? 'ln-ok ln-done' : 'ln-err ln-done';
      append(`<span class="${cls}">── exit ${data.exit_code} ${data.ok ? '✓' : '✗'} ──</span>`);
    } else if (evtType === 'error') {
      append(`<span class="ln-err">ERROR: ${escHtml(data.message)}</span>`);
    }
  }

  return { term, handleEvent };
}

async function streamPost(url, body, onEvent) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += dec.decode(value, {stream:true});
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim());
        onEvent(obj.type, obj.data);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const pages = {};

// ── Dashboard ──────────────────────────────────────────────────────────────
pages.dashboard = async function(content) {
  content.innerHTML = '';
  const topbar = document.getElementById('topbar-actions');
  topbar.innerHTML = '';
  const btn = el('button', {class:'btn btn-secondary', onclick: ()=>pages.dashboard(content)}, '↻ Refresh');
  topbar.appendChild(btn);

  content.appendChild(el('div', {class:'loading-row'},
    el('div',{class:'spinner'}), document.createTextNode(' Running doctor…')));

  const res = await api('/api/doctor');
  content.innerHTML = '';

  // summary strip
  const summaryCard = el('div', {class:'card'});
  summaryCard.appendChild(el('div',{class:'card-title'}, 'System Status'));
  const grid = el('div', {class:'grid-3'});

  const okStat = el('div',{class:'stat'});
  okStat.appendChild(el('div',{class:'stat-label'},'Status'));
  const sv = el('div',{class:'stat-value',style:`color:${res.ok?'var(--green)':'var(--red)'}`});
  sv.textContent = res.ok ? 'Healthy' : 'Issues';
  okStat.appendChild(sv);
  grid.appendChild(okStat);

  const exitStat = el('div',{class:'stat'});
  exitStat.appendChild(el('div',{class:'stat-label'}, 'Exit Code'));
  const esv = el('div',{class:'stat-value'});
  esv.textContent = res.exit_code ?? '—';
  exitStat.appendChild(esv);
  grid.appendChild(exitStat);

  const parsedKeys = res.parsed ? Object.keys(res.parsed) : [];
  const ksStat = el('div',{class:'stat'});
  ksStat.appendChild(el('div',{class:'stat-label'}, 'Checks'));
  const ksv = el('div',{class:'stat-value'});
  ksv.textContent = parsedKeys.length || '—';
  ksStat.appendChild(ksv);
  grid.appendChild(ksStat);

  summaryCard.appendChild(grid);
  content.appendChild(summaryCard);

  // check list
  if (res.parsed && typeof res.parsed === 'object') {
    const checkCard = el('div',{class:'card'});
    checkCard.appendChild(el('div',{class:'card-title'}, 'Doctor Checks'));
    const list = el('div',{class:'check-list'});
    function renderChecks(obj, prefix='') {
      for (const [k,v] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          renderChecks(v, fullKey);
          continue;
        }
        const item = el('div',{class:'check-item'});
        const ok = v === true || v === 'ok' || v === 'pass';
        const fail = v === false || v === 'fail' || v === 'error';
        item.appendChild(el('span',{class:'ci-icon'}, ok?'✅':fail?'❌':'ℹ️'));
        const info = el('div');
        info.appendChild(el('div',{class:'ci-key'}, fullKey));
        info.appendChild(el('div',{class:'ci-val'}, typeof v === 'object' ? JSON.stringify(v) : String(v)));
        item.appendChild(info);
        list.appendChild(item);
      }
    }
    renderChecks(res.parsed);
    checkCard.appendChild(list);
    content.appendChild(checkCard);
  }

  // raw output fallback
  if (!res.parsed && res.raw) {
    const rawCard = el('div',{class:'card'});
    rawCard.appendChild(el('div',{class:'card-title'}, 'Raw Output'));
    const term = el('div',{class:'terminal'});
    term.textContent = res.raw;
    rawCard.appendChild(term);
    content.appendChild(rawCard);
  }

  if (res.error) {
    const errCard = el('div',{class:'card'});
    errCard.appendChild(el('div',{class:'card-title'}, 'Error'));
    const term = el('div',{class:'terminal'});
    term.style.color = 'var(--red)';
    term.textContent = res.error + '\n' + (res.stderr||'');
    errCard.appendChild(term);
    content.appendChild(errCard);
  }
};

// ── Offers ─────────────────────────────────────────────────────────────────
pages.offers = async function(content) {
  content.innerHTML = '';
  const topbar = document.getElementById('topbar-actions');
  topbar.innerHTML = '';

  const btnRefresh = el('button',{class:'btn btn-secondary', onclick:()=>loadOffers()},'↻ Refresh');
  const btnReconcile = el('button',{class:'btn btn-primary', onclick:()=>runReconcile()},'⚡ Reconcile');
  topbar.appendChild(el('div',{class:'btn-group'}, btnRefresh, btnReconcile));

  const statusCard = el('div',{class:'card'});
  const reconCard  = el('div',{class:'card'});
  reconCard.style.display = 'none';
  content.appendChild(statusCard);
  content.appendChild(reconCard);

  async function loadOffers() {
    statusCard.innerHTML = '<div class="card-title">Offers Status</div><div class="loading-row"><div class="spinner"></div> Loading…</div>';
    const res = await api('/api/offers-status?limit=50&events_limit=20');
    statusCard.innerHTML = '<div class="card-title">Offers Status</div>';
    if (!res.parsed) {
      const t = el('div',{class:'terminal'}); t.textContent = res.raw||res.error||'No output';
      statusCard.appendChild(t); return;
    }
    const offers = res.parsed.offers || res.parsed.results || [];
    if (!offers.length) {
      statusCard.appendChild(el('div',{class:'empty'},'No offers found.'));
      return;
    }
    const wrap = el('div',{class:'tbl-wrap'});
    const tbl = el('table');
    tbl.appendChild(el('thead',{},el('tr',{},
      ...[['Offer ID','160px'],['Market',''],['State',''],['Pair',''],['Taker Signal',''],['Created',''],['Expires',''],['Events','']].map(
        ([h,w])=>{ const th=el('th'); th.textContent=h; if(w) th.style.minWidth=w; return th;}
      )
    )));
    const tbody = el('tbody');
    for (const o of offers) {
      const state = o.state || o.offer_state || '?';
      const stateColor = state==='active'?'green':state==='taken'?'blue':state==='expired'?'muted':'yellow';
      const takerSig = o.taker_signal || '—';
      const ts = takerSig !== 'none' && takerSig !== '—' ? badge(takerSig,'blue') : el('span',{class:'text-muted'}, takerSig);
      const evts = (o.events||[]).length;
      const row = el('tr',{});
      function td(child) { const t=el('td'); if(typeof child==='string') t.textContent=child; else t.appendChild(child); return t; }
      const idSpan = el('span',{class:'truncate',style:'font-family:var(--font-mono);font-size:11px;display:block'}); idSpan.textContent=o.offer_id||'—';
      row.appendChild(td(idSpan));
      row.appendChild(td(o.market_id||'—'));
      row.appendChild(el('td',{},badge(state,stateColor)));
      row.appendChild(td(`${o.base_symbol||'?'}:${o.quote_asset||'?'}`));
      row.appendChild(el('td',{},ts));
      row.appendChild(td(o.created_at ? new Date(o.created_at).toLocaleString() : '—'));
      row.appendChild(td(o.expires_at ? new Date(o.expires_at).toLocaleString() : '—'));
      row.appendChild(td(String(evts)));
      tbody.appendChild(row);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    statusCard.appendChild(wrap);
    // summary
    const total = offers.length;
    const active = offers.filter(o=>(o.state||'').includes('active')).length;
    statusCard.insertBefore(
      (() => {
        const g = el('div',{class:'grid-3 mb-16'});
        function stat(l,v) { const s=el('div',{class:'stat'}); s.appendChild(el('div',{class:'stat-label'},l)); const sv=el('div',{class:'stat-value'}); sv.textContent=v; s.appendChild(sv); return s; }
        g.appendChild(stat('Total',total));
        g.appendChild(stat('Active',active));
        g.appendChild(stat('Other',total-active));
        return g;
      })(),
      wrap
    );
  }

  async function runReconcile() {
    btnReconcile.disabled = true;
    reconCard.style.display = '';
    reconCard.innerHTML = '<div class="card-title">Reconcile Output</div><div class="loading-row"><div class="spinner"></div> Reconciling…</div>';
    const res = await api('/api/offers-reconcile', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    reconCard.innerHTML = '<div class="card-title">Reconcile Output</div>';
    const viewer = el('div',{class:'terminal'});
    viewer.appendChild(el('pre',{class:'json-view'}));
    viewer.querySelector('pre').innerHTML = jsonHtml(res.parsed||{raw:res.raw,error:res.error});
    reconCard.appendChild(viewer);
    btnReconcile.disabled = false;
  }

  loadOffers();
};

// ── Coins ──────────────────────────────────────────────────────────────────
pages.coins = async function(content) {
  content.innerHTML = '';
  const topbar = document.getElementById('topbar-actions');
  topbar.innerHTML = '';
  const btnRefresh = el('button',{class:'btn btn-secondary',onclick:()=>loadCoins()},'↻ Refresh');
  topbar.appendChild(btnRefresh);

  const listCard   = el('div',{class:'card'});
  const splitCard  = el('div',{class:'card'});
  const combineCard= el('div',{class:'card'});
  content.appendChild(listCard);

  // Split form
  splitCard.appendChild(el('div',{class:'card-title'},'Split Coin'));
  const splitForm = buildSplitForm();
  splitCard.appendChild(splitForm.el);
  content.appendChild(splitCard);

  // Combine form
  combineCard.appendChild(el('div',{class:'card-title'},'Combine Coins'));
  const combineForm = buildCombineForm();
  combineCard.appendChild(combineForm.el);
  content.appendChild(combineCard);

  async function loadCoins() {
    listCard.innerHTML = '<div class="card-title">Coin Inventory</div><div class="loading-row"><div class="spinner"></div> Loading…</div>';
    const res = await api('/api/coins-list');
    listCard.innerHTML = '<div class="card-title">Coin Inventory</div>';
    if (!res.parsed) {
      const t = el('div',{class:'terminal'}); t.textContent = res.raw||res.error||'No output'; listCard.appendChild(t); return;
    }
    const coins = res.parsed.coins || res.parsed.results || [];
    if (!coins.length) { listCard.appendChild(el('div',{class:'empty'},'No coins found.')); return; }
    const wrap = el('div',{class:'tbl-wrap'});
    const tbl = el('table');
    tbl.appendChild(el('thead',{},el('tr',{},
      ...['Asset','Coin ID','Amount','State','Spendable'].map(h=>{ const t=el('th'); t.textContent=h; return t; })
    )));
    const tbody = el('tbody');
    for (const c of coins) {
      const state = c.state||c.coin_state||'?';
      const ok = state==='spendable'||state==='confirmed';
      const row = el('tr');
      function td(v) { const t=el('td'); t.textContent=String(v??'—'); return t; }
      const idSpan = el('span',{style:'font-family:var(--font-mono);font-size:11px'}); idSpan.textContent=c.coin_id||c.id||'—';
      row.appendChild(td(c.asset||c.ticker||c.asset_id||'XCH'));
      row.appendChild(el('td',{},idSpan));
      row.appendChild(td(c.amount_mojos||c.amount||c.mojos||'—'));
      row.appendChild(el('td',{},badge(state,ok?'green':'yellow')));
      row.appendChild(el('td',{},badge(c.spendable?'yes':'no', c.spendable?'green':'muted')));
      tbody.appendChild(row);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    listCard.appendChild(wrap);
    const total = coins.length;
    const spendable = coins.filter(c=>c.spendable).length;
    listCard.insertBefore((() => {
      const g = el('div',{class:'grid-3 mb-16'});
      function stat(l,v) { const s=el('div',{class:'stat'}); s.appendChild(el('div',{class:'stat-label'},l)); const sv=el('div',{class:'stat-value'}); sv.textContent=v; s.appendChild(sv); return s; }
      g.appendChild(stat('Total Coins',total));
      g.appendChild(stat('Spendable',spendable));
      g.appendChild(stat('Locked',total-spendable));
      return g;
    })(), wrap);
  }

  function buildSplitForm() {
    const wrapper = el('div');
    const row1 = el('div',{class:'form-row'});
    const fg1=el('div',{class:'form-group'}); fg1.appendChild(el('label',{},'Pair')); const inpPair=el('input',{type:'text',placeholder:'e.g. TDBX:txch'}); fg1.appendChild(inpPair); row1.appendChild(fg1);
    const fg2=el('div',{class:'form-group'}); fg2.appendChild(el('label',{},'Amount Per Coin')); const inpAmt=el('input',{type:'number',placeholder:'e.g. 1000'}); fg2.appendChild(inpAmt); row1.appendChild(fg2);
    wrapper.appendChild(row1);
    const row2 = el('div',{class:'form-row'});
    const fg3=el('div',{class:'form-group'}); fg3.appendChild(el('label',{},'Number of Coins')); const inpNum=el('input',{type:'number',placeholder:'e.g. 10'}); fg3.appendChild(inpNum); row2.appendChild(fg3);
    const fg4=el('div',{class:'form-group'}); fg4.appendChild(el('label',{},'Coin ID (optional)')); const inpCoin=el('input',{type:'text',placeholder:'leave blank for auto-select'}); fg4.appendChild(inpCoin); row2.appendChild(fg4);
    wrapper.appendChild(row2);
    const {term,handleEvent} = createTerminal();
    const btn = el('button',{class:'btn btn-primary',onclick:async()=>{ btn.disabled=true; term.style.display=''; await streamPost('/api/coin-split/stream',{pair:inpPair.value.trim(),coin_id:inpCoin.value.trim(),amount_per_coin:+inpAmt.value,number_of_coins:+inpNum.value},handleEvent); btn.disabled=false; }},'▶ Split');
    wrapper.appendChild(el('div',{class:'btn-group mt-16'},btn));
    term.style.display='none';
    wrapper.appendChild(el('div',{class:'mt-16'},term));
    return {el:wrapper};
  }

  function buildCombineForm() {
    const wrapper = el('div');
    const row1 = el('div',{class:'form-row'});
    const fg1=el('div',{class:'form-group'}); fg1.appendChild(el('label',{},'Pair')); const inpPair=el('input',{type:'text',placeholder:'e.g. TDBX:txch'}); fg1.appendChild(inpPair); row1.appendChild(fg1);
    const fg2=el('div',{class:'form-group'}); fg2.appendChild(el('label',{},'Input Coin Count')); const inpCnt=el('input',{type:'number',value:'2',placeholder:'e.g. 10'}); fg2.appendChild(inpCnt); row1.appendChild(fg2);
    wrapper.appendChild(row1);
    const fg3=el('div',{class:'form-group'}); fg3.appendChild(el('label',{},'Asset ID (optional)')); const inpAsset=el('input',{type:'text',placeholder:'e.g. xch or CAT asset id'}); fg3.appendChild(inpAsset); wrapper.appendChild(fg3);
    const {term,handleEvent} = createTerminal();
    const btn = el('button',{class:'btn btn-primary',onclick:async()=>{ btn.disabled=true; term.style.display=''; await streamPost('/api/coin-combine/stream',{pair:inpPair.value.trim(),input_coin_count:+inpCnt.value,asset_id:inpAsset.value.trim()},handleEvent); btn.disabled=false; }},'▶ Combine');
    wrapper.appendChild(el('div',{class:'btn-group mt-16'},btn));
    term.style.display='none';
    wrapper.appendChild(el('div',{class:'mt-16'},term));
    return {el:wrapper};
  }

  loadCoins();
};

// ── Build Offer ─────────────────────────────────────────────────────────────
pages.build = async function(content) {
  content.innerHTML = '';
  const topbar = document.getElementById('topbar-actions');
  topbar.innerHTML = '';

  const card = el('div',{class:'card'});
  card.appendChild(el('div',{class:'card-title'},'Build & Post Offer'));

  const row1 = el('div',{class:'form-row'});
  const fg1=el('div',{class:'form-group'}); fg1.appendChild(el('label',{},'Pair')); const inpPair=el('input',{type:'text',placeholder:'e.g. CARBON22:xch',value:'CARBON22:xch'}); fg1.appendChild(inpPair); row1.appendChild(fg1);
  const fg2=el('div',{class:'form-group'}); fg2.appendChild(el('label',{},'Size (base units)')); const inpSize=el('input',{type:'number',value:'1',min:'1'}); fg2.appendChild(inpSize); row1.appendChild(fg2);
  card.appendChild(row1);

  const row2 = el('div',{class:'form-row'});
  const fg3=el('div',{class:'form-group'}); fg3.appendChild(el('label',{},'Network'));
  const selNet=el('select'); ['mainnet','testnet11'].forEach(n=>{ const o=el('option',{value:n}); o.textContent=n; selNet.appendChild(o); }); fg3.appendChild(selNet); row2.appendChild(fg3);
  const fg4=el('div',{class:'form-group'}); fg4.appendChild(el('label',{},'Venue'));
  const selVenue=el('select'); [['','(default)'],['dexie','Dexie'],['splash','Splash']].forEach(([v,t])=>{ const o=el('option',{value:v}); o.textContent=t; selVenue.appendChild(o); }); fg4.appendChild(selVenue); row2.appendChild(fg4);
  card.appendChild(row2);

  const chkRow = el('div',{class:'checkbox-row mb-16'});
  const chkDry = el('input',{type:'checkbox',id:'dry-run-chk',checked:''}); chkDry.checked=true;
  const chkLbl = el('label',{for:'dry-run-chk'},'Dry run (no actual posting)');
  chkRow.appendChild(chkDry); chkRow.appendChild(chkLbl);
  card.appendChild(chkRow);
  const hint = el('div',{class:'form-hint mb-16'},'⚠ Uncheck dry run only when you have keys onboarded and a funded vault.');
  card.appendChild(hint);

  const {term,handleEvent} = createTerminal();
  const btn = el('button',{class:'btn btn-primary',onclick:async()=>{
    btn.disabled=true;
    term.style.display='';
    await streamPost('/api/build-offer/stream',{
      pair: inpPair.value.trim(),
      size_base_units: +inpSize.value,
      network: selNet.value,
      venue: selVenue.value,
      dry_run: chkDry.checked,
    }, handleEvent);
    btn.disabled=false;
  }},chkDry.checked?'▶ Build Offer (dry run)':'▶ Build & Post Offer');

  chkDry.addEventListener('change',()=>{
    btn.textContent = chkDry.checked ? '▶ Build Offer (dry run)' : '▶ Build & Post Offer';
    btn.className = chkDry.checked ? 'btn btn-secondary' : 'btn btn-danger';
  });
  btn.className = 'btn btn-secondary';

  card.appendChild(el('div',{class:'btn-group'},btn));
  term.style.display='none';
  card.appendChild(el('div',{class:'mt-16'},term));
  content.appendChild(card);
};

// ── Config ──────────────────────────────────────────────────────────────────
pages.config = async function(content) {
  content.innerHTML = '';
  const topbar = document.getElementById('topbar-actions');
  topbar.innerHTML = '';
  const btnRefresh = el('button',{class:'btn btn-secondary',onclick:()=>pages.config(content)},'↻ Refresh');
  const btnValidate = el('button',{class:'btn btn-primary',onclick:()=>loadValidate()},'✓ Validate Config');
  topbar.appendChild(el('div',{class:'btn-group'},btnRefresh,btnValidate));

  // Paths card
  const pathsCard = el('div',{class:'card'});
  pathsCard.appendChild(el('div',{class:'card-title'},'Config Paths'));
  pathsCard.innerHTML += '<div class="loading-row"><div class="spinner"></div> Loading…</div>';
  content.appendChild(pathsCard);

  const validateCard = el('div',{class:'card'});
  validateCard.style.display='none';
  content.appendChild(validateCard);

  const res = await api('/api/config-paths');
  pathsCard.innerHTML = '<div class="card-title">Config Paths & Environment</div>';
  const list = el('div',{class:'check-list'});
  for (const [k,v] of Object.entries(res)) {
    const item = el('div',{class:'check-item'});
    item.appendChild(el('span',{class:'ci-icon'},'📄'));
    const info=el('div');
    info.appendChild(el('div',{class:'ci-key'},k.replace(/_/g,' ')));
    info.appendChild(el('div',{class:'ci-val'},String(v)));
    item.appendChild(info);
    list.appendChild(item);
  }
  pathsCard.appendChild(list);

  async function loadValidate() {
    validateCard.style.display='';
    validateCard.innerHTML = '<div class="card-title">Config Validation</div><div class="loading-row"><div class="spinner"></div> Validating…</div>';
    const r = await api('/api/config-validate');
    validateCard.innerHTML = '<div class="card-title">Config Validation</div>';
    const hdr = el('div',{class:'section-header mb-16'});
    hdr.appendChild(statusBadge(r.ok));
    validateCard.appendChild(hdr);
    if (r.parsed) {
      const pre = el('div',{class:'terminal'});
      pre.appendChild(el('pre',{class:'json-view'}));
      pre.querySelector('pre').innerHTML = jsonHtml(r.parsed);
      validateCard.appendChild(pre);
    } else {
      const t = el('div',{class:'terminal'}); t.textContent=r.raw||r.error||''; validateCard.appendChild(t);
    }
  }
};

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const PAGE_TITLES = {
  dashboard: 'Dashboard',
  offers:    'Offers',
  coins:     'Coins',
  build:     'Build Offer',
  config:    'Config',
};

function navigate(page) {
  document.querySelectorAll('nav a').forEach(a=>{
    a.classList.toggle('active', a.dataset.page===page);
  });
  document.getElementById('page-title').textContent = PAGE_TITLES[page]||page;
  const content = document.getElementById('content');
  content.innerHTML = '';
  document.getElementById('topbar-actions').innerHTML='';
  (pages[page]||pages.dashboard)(content);
}

document.querySelectorAll('nav a').forEach(a=>{
  a.addEventListener('click',()=>navigate(a.dataset.page));
});

// Load env info
(async()=>{
  try {
    const r = await api('/api/config-paths');
    document.getElementById('env-info').innerHTML =
      `<code style="color:var(--green);background:none;padding:0;">${r.manager_cmd.split('/').pop().split('\\\\').pop()}</code><br>` +
      `<span>Python ${r.python.includes('3.11')||r.python.includes('3.12')||r.python.includes('3.13')?'✓':''}</span>`;
  } catch {}
})();

// Boot
navigate('dashboard');
</script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
