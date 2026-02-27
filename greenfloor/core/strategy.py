from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class MarketState:
    ones: int
    tens: int
    hundreds: int
    xch_price_usd: float | None = None
    # Generic bucket map for arbitrary ladder sizes (e.g. size=5).
    # When populated, used in place of `ones`/`tens`/`hundreds` for
    # markets that define non-standard bucket sizes.
    buckets_by_size: dict[int, int] | None = None


@dataclass(frozen=True, slots=True)
class StrategyConfig:
    pair: str
    ones_target: int = 5
    tens_target: int = 2
    hundreds_target: int = 1
    target_spread_bps: int | None = None
    min_xch_price_usd: float | None = None
    max_xch_price_usd: float | None = None
    # Generic target map for arbitrary ladder sizes.  When populated,
    # `evaluate_market` uses this instead of ones/tens/hundreds lookup.
    targets_by_size: dict[int, int] | None = None


@dataclass(frozen=True, slots=True)
class PlannedAction:
    size: int
    repeat: int
    pair: str
    expiry_unit: str
    expiry_value: int
    cancel_after_create: bool
    reason: str
    target_spread_bps: int | None = None
    # "sell": offer base asset, request quote asset.
    # "buy":  offer quote asset (XCH), request base asset.
    direction: str = "sell"


_PAIR_EXPIRY_CONFIG: dict[str, tuple[str, int]] = {
    "xch": ("minutes", 10),
    "usdc": ("minutes", 10),
}


def evaluate_market(
    state: MarketState,
    config: StrategyConfig,
    clock: datetime,
    *,
    direction: str = "sell",
) -> list[PlannedAction]:
    _ = clock
    pair = config.pair.lower()
    if pair == "xch":
        if state.xch_price_usd is None:
            return []
        if state.xch_price_usd <= 0:
            return []
        if config.min_xch_price_usd is not None and state.xch_price_usd < config.min_xch_price_usd:
            return []
        if config.max_xch_price_usd is not None and state.xch_price_usd > config.max_xch_price_usd:
            return []
    expiry_unit, expiry_value = _PAIR_EXPIRY_CONFIG.get(pair, _PAIR_EXPIRY_CONFIG["xch"])

    # Generic ladder: use targets_by_size + buckets_by_size when both are available.
    if config.targets_by_size is not None:
        current_by_size = (state.buckets_by_size or {}) if state.buckets_by_size is not None else {}
        offer_configs_generic = [
            (size, int(current_by_size.get(size, 0)), int(target))
            for size, target in sorted(config.targets_by_size.items())
        ]
        actions: list[PlannedAction] = []
        for size, current, target in offer_configs_generic:
            if current < target:
                actions.append(
                    PlannedAction(
                        size=size,
                        repeat=target - current,
                        pair=pair,
                        expiry_unit=expiry_unit,
                        expiry_value=expiry_value,
                        cancel_after_create=True,
                        reason="below_target",
                        target_spread_bps=config.target_spread_bps,
                        direction=direction,
                    )
                )
        return actions

    offer_configs = [
        (1, state.ones, config.ones_target),
        (10, state.tens, config.tens_target),
        (100, state.hundreds, config.hundreds_target),
    ]

    legacy_actions: list[PlannedAction] = []
    for size, current, target in offer_configs:
        if current < target:
            legacy_actions.append(
                PlannedAction(
                    size=size,
                    repeat=target - current,
                    pair=pair,
                    expiry_unit=expiry_unit,
                    expiry_value=expiry_value,
                    cancel_after_create=True,
                    reason="below_target",
                    target_spread_bps=config.target_spread_bps,
                    direction=direction,
                )
            )
    return legacy_actions
