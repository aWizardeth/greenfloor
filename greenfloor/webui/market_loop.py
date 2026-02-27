"""GreenFloor WebUI – background market management loop.

When Sage is connected and at least one market is enabled, this loop
replicates exactly what ``greenfloord`` does on each cycle:

1. Fetch current XCH price.
2. Evaluate ladder strategy vs live Dexie offers.
3. Post new offers to fill gaps (via Sage RPC).
4. Cancel / rotate offers when the cancel policy triggers.

Implementation: wraps the daemon's synchronous ``run_once`` in
``asyncio.get_event_loop().run_in_executor`` so the aiohttp event loop
is never blocked.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from greenfloor.adapters.sage_rpc import sage_certs_present
from greenfloor.config.io import load_markets_config_with_optional_overlay, load_program_config

logger = logging.getLogger("greenfloor.webui.market_loop")

_MAX_LOG_EVENTS = 200


class MarketLoop:
    """Asyncio background task that runs the daemon market cycle."""

    def __init__(
        self,
        program_path: Path,
        markets_path: Path,
        testnet_markets_path: Path | None = None,
    ) -> None:
        self._program_path = program_path
        self._markets_path = markets_path
        self._testnet_markets_path = testnet_markets_path

        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._last_cycle_at: str | None = None
        self._last_result: dict[str, Any] | None = None
        self._cycle_count = 0
        self._error_count = 0
        self._log_events: list[dict[str, Any]] = []

    # ------------------------------------------------------------------
    # Public control API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Start the background loop (no-op if already running)."""
        if self._task and not self._task.done():
            return
        self._running = True
        self._task = asyncio.create_task(self._loop(), name="greenfloor-market-loop")
        logger.info("market_loop started")

    def stop(self) -> None:
        """Stop the background loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("market_loop stopped")

    def status(self) -> dict[str, Any]:
        """Return current loop state for the API."""
        active = bool(self._task and not self._task.done() and self._running)
        sage_ok = sage_certs_present()
        enabled_markets = self._count_enabled_markets()
        return {
            "running": active,
            "sage_connected": sage_ok,
            "enabled_markets": enabled_markets,
            "can_start": sage_ok and enabled_markets > 0,
            "last_cycle_at": self._last_cycle_at,
            "last_result": self._last_result,
            "cycle_count": self._cycle_count,
            "error_count": self._error_count,
            "recent_events": list(self._log_events[-20:]),
        }

    async def trigger_once(self) -> dict[str, Any]:
        """Run one cycle immediately in the executor and return the result."""
        self._emit("trigger", "Manual cycle triggered")
        result = await self._run_once_in_executor()
        return result

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _count_enabled_markets(self) -> int:
        try:
            markets = load_markets_config_with_optional_overlay(
                path=self._markets_path,
                overlay_path=self._testnet_markets_path,
            )
            return sum(1 for m in markets.markets if m.enabled)
        except Exception:
            return 0

    def _emit(self, event_type: str, message: str, extra: dict[str, Any] | None = None) -> None:
        entry: dict[str, Any] = {
            "at": datetime.now(UTC).isoformat(),
            "type": event_type,
            "message": message,
        }
        if extra:
            entry.update(extra)
        self._log_events.append(entry)
        if len(self._log_events) > _MAX_LOG_EVENTS:
            self._log_events = self._log_events[-_MAX_LOG_EVENTS:]

    async def _loop(self) -> None:
        while self._running:
            result = await self._run_once_in_executor()
            interval = int(result.get("loop_interval_seconds", 30))
            self._emit("sleep", f"Next cycle in {interval}s")
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                break

    async def _run_once_in_executor(self) -> dict[str, Any]:
        loop = asyncio.get_event_loop()
        try:
            program = load_program_config(self._program_path)
            state_dir = Path(program.home_dir).expanduser() / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            interval = int(getattr(program, "runtime_loop_interval_seconds", 30))

            self._emit("cycle_start", "Running market cycle")

            def _sync_run() -> int:
                from greenfloor.daemon.main import run_once
                return run_once(
                    program_path=self._program_path,
                    markets_path=self._markets_path,
                    allowed_keys=None,
                    db_path_override=None,
                    coinset_base_url="",
                    state_dir=state_dir,
                    poll_coinset_mempool=True,
                    program=program,
                    testnet_markets_path=self._testnet_markets_path,
                )

            exit_code: int = await loop.run_in_executor(None, _sync_run)
            self._cycle_count += 1
            self._last_cycle_at = datetime.now(UTC).isoformat()
            status = "ok" if exit_code == 0 else "error"
            self._last_result = {
                "status": status,
                "exit_code": exit_code,
                "at": self._last_cycle_at,
                "cycle": self._cycle_count,
            }
            self._emit(
                "cycle_done",
                f"Cycle {self._cycle_count} complete (exit {exit_code})",
                {"exit_code": exit_code},
            )
            return {"loop_interval_seconds": interval, **self._last_result}

        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._error_count += 1
            msg = f"Cycle error: {exc}"
            logger.exception("market_loop cycle error")
            err_result: dict[str, Any] = {
                "status": "error",
                "error": str(exc),
                "cycle": self._cycle_count,
            }
            self._last_result = err_result
            self._emit("cycle_error", msg, {"error": str(exc)})
            return {"loop_interval_seconds": 30, **err_result}
