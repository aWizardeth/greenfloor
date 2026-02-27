from __future__ import annotations

from greenfloor.config.models import MarketConfig, MarketInventoryConfig, MarketLadderEntry
from greenfloor.daemon.main import (
    _normalize_strategy_pair,
    _strategy_config_from_market,
    _strategy_state_from_bucket_counts,
)


def _market_with_quote(quote_asset: str) -> MarketConfig:
    return MarketConfig(
        market_id="m1",
        enabled=True,
        base_asset="asset",
        base_symbol="BYC",
        quote_asset=quote_asset,
        quote_asset_type="unstable",
        receive_address="xch1a0t57qn6uhe7tzjlxlhwy2qgmuxvvft8gnfzmg5detg0q9f3yc3s2apz0h",
        mode="sell_only",
        signer_key_id="key-main-1",
        inventory=MarketInventoryConfig(low_watermark_base_units=100),
        ladders={
            "sell": [
                MarketLadderEntry(
                    size_base_units=1,
                    target_count=7,
                    split_buffer_count=1,
                    combine_when_excess_factor=2.0,
                ),
                MarketLadderEntry(
                    size_base_units=10,
                    target_count=3,
                    split_buffer_count=1,
                    combine_when_excess_factor=2.0,
                ),
                MarketLadderEntry(
                    size_base_units=100,
                    target_count=2,
                    split_buffer_count=0,
                    combine_when_excess_factor=2.0,
                ),
            ]
        },
    )


def test_normalize_strategy_pair_handles_xch_and_usdc_aliases() -> None:
    assert _normalize_strategy_pair("xch") == "xch"
    assert _normalize_strategy_pair("wUSDC.b") == "usdc"
    assert _normalize_strategy_pair("USDC") == "usdc"


def test_strategy_config_from_market_uses_sell_ladder_targets() -> None:
    cfg = _strategy_config_from_market(_market_with_quote("xch"))
    assert cfg.pair == "xch"
    assert cfg.ones_target == 7
    assert cfg.tens_target == 3
    assert cfg.hundreds_target == 2


def test_strategy_config_from_market_reads_configurable_price_bands_and_spread() -> None:
    market = _market_with_quote("xch")
    market.pricing = {
        "strategy_target_spread_bps": 140,
        "strategy_min_xch_price_usd": 26.5,
        "strategy_max_xch_price_usd": 39.0,
    }
    cfg = _strategy_config_from_market(market)
    assert cfg.target_spread_bps == 140
    assert cfg.min_xch_price_usd == 26.5
    assert cfg.max_xch_price_usd == 39.0


def test_strategy_state_from_bucket_counts_includes_xch_price() -> None:
    state = _strategy_state_from_bucket_counts(
        {1: 2, 10: 1, 100: 0},
        xch_price_usd=32.5,
    )
    assert state.ones == 2
    assert state.tens == 1
    assert state.hundreds == 0
    assert state.xch_price_usd == 32.5


# ---------------------------------------------------------------------------
# Two-sided market: direction-aware strategy config and evaluate_market
# ---------------------------------------------------------------------------

from greenfloor.core.strategy import evaluate_market  # noqa: E402
from datetime import datetime, UTC  # noqa: E402
from greenfloor.daemon.main import _resolve_quote_price_quote_per_base  # noqa: E402


def _two_sided_market() -> MarketConfig:
    return MarketConfig(
        market_id="m_two",
        enabled=True,
        base_asset="ae1536f5" + "0" * 56,
        base_symbol="BYC",
        quote_asset="xch",
        quote_asset_type="unstable",
        receive_address="xch1a0t57qn6uhe7tzjlxlhwy2qgmuxvvft8gnfzmg5detg0q9f3yc3s2apz0h",
        mode="two_sided",
        signer_key_id="key-main-1",
        inventory=MarketInventoryConfig(low_watermark_base_units=5),
        pricing={
            "sell_usd_per_base": 1.02,
            "buy_usd_per_base": 0.98,
        },
        ladders={
            "sell": [
                MarketLadderEntry(size_base_units=1, target_count=3,
                                  split_buffer_count=0, combine_when_excess_factor=2.0),
                MarketLadderEntry(size_base_units=5, target_count=2,
                                  split_buffer_count=0, combine_when_excess_factor=2.0),
            ],
            "buy": [
                MarketLadderEntry(size_base_units=1, target_count=4,
                                  split_buffer_count=0, combine_when_excess_factor=2.0),
                MarketLadderEntry(size_base_units=5, target_count=2,
                                  split_buffer_count=0, combine_when_excess_factor=2.0),
            ],
        },
    )


def test_strategy_config_from_market_buy_direction_uses_buy_ladder() -> None:
    market = _two_sided_market()
    sell_cfg = _strategy_config_from_market(market, direction="sell")
    buy_cfg = _strategy_config_from_market(market, direction="buy")
    assert sell_cfg.targets_by_size == {1: 3, 5: 2}
    assert buy_cfg.targets_by_size == {1: 4, 5: 2}


def test_evaluate_market_tags_actions_with_direction() -> None:
    market = _two_sided_market()
    clock = datetime(2026, 1, 1, tzinfo=UTC)

    sell_cfg = _strategy_config_from_market(market, direction="sell")
    sell_actions = evaluate_market(
        state=_strategy_state_from_bucket_counts({}, xch_price_usd=30.0),
        config=sell_cfg,
        clock=clock,
        direction="sell",
    )
    assert all(a.direction == "sell" for a in sell_actions)
    assert sum(a.repeat for a in sell_actions) == 5  # (3 - 0) + (2 - 0)

    buy_cfg = _strategy_config_from_market(market, direction="buy")
    buy_actions = evaluate_market(
        state=_strategy_state_from_bucket_counts({}, xch_price_usd=30.0),
        config=buy_cfg,
        clock=clock,
        direction="buy",
    )
    assert all(a.direction == "buy" for a in buy_actions)
    assert sum(a.repeat for a in buy_actions) == 6  # (4 - 0) + (2 - 0)


def test_resolve_quote_price_uses_sell_usd_for_sell_direction() -> None:
    market = _two_sided_market()
    price = _resolve_quote_price_quote_per_base(market, direction="sell", xch_price_usd=10.0)
    assert abs(price - 1.02 / 10.0) < 1e-9


def test_resolve_quote_price_uses_buy_usd_for_buy_direction() -> None:
    market = _two_sided_market()
    price = _resolve_quote_price_quote_per_base(market, direction="buy", xch_price_usd=10.0)
    assert abs(price - 0.98 / 10.0) < 1e-9


def test_evaluate_market_buy_actions_reduced_by_existing_open_offers() -> None:
    """When buy buckets already have some slots filled, repeat is reduced accordingly."""
    market = _two_sided_market()
    clock = datetime(2026, 1, 1, tzinfo=UTC)
    buy_cfg = _strategy_config_from_market(market, direction="buy")
    # Pretend 2 existing open buy offers at size 1 already tracked in store
    buy_actions = evaluate_market(
        state=_strategy_state_from_bucket_counts({1: 2}, xch_price_usd=30.0),
        config=buy_cfg,
        clock=clock,
        direction="buy",
    )
    size1_actions = [a for a in buy_actions if a.size == 1]
    assert len(size1_actions) == 1
    assert size1_actions[0].repeat == 2  # target 4 - already 2 = 2 needed
