import numpy as np
import pandas as pd
import pytest

from signals import backtest, data
from signals.__main__ import main
from signals.indicators import add_all, rsi
from signals.strategy import action_for, latest_signal, option_idea, scored_frame


def trend(days=300, step=0.004, vol=0.01):
    noise = np.random.default_rng(0).normal(0, vol, days)
    close = 100 * np.exp(np.cumsum(step + noise))
    idx = pd.bdate_range("2024-01-01", periods=days)
    return pd.DataFrame({"Open": close * 0.999, "High": close * 1.01, "Low": close * 0.99,
                         "Close": close, "Volume": 1_000_000}, index=idx)


def test_rsi_bounds_and_extremes():
    up = rsi(trend(vol=0)["Close"])
    assert up.dropna().between(0, 100).all()
    assert up.iloc[-1] > 70
    assert rsi(trend(step=-0.004, vol=0)["Close"]).iloc[-1] < 30


def test_indicators_present():
    cols = add_all(trend()).columns
    for c in ["sma200", "rsi", "macd_hist", "bb_pct", "atr", "vol_ratio"]:
        assert c in cols


@pytest.mark.parametrize("score,action", [(8, "STRONG BUY"), (3, "BUY"), (0, "HOLD"), (-4, "SELL"), (-7, "STRONG SELL")])
def test_action_thresholds(score, action):
    assert action_for(score) == action


def test_uptrend_is_bullish_with_risk_levels():
    s = latest_signal("UP", trend())
    assert s.score > 0
    if s.action.endswith("BUY"):
        assert s.stop_loss < s.price < s.target
        assert "CALL" in s.option_idea


def test_average_score_follows_trend():
    assert scored_frame(trend())["score"].tail(100).mean() > 0
    assert scored_frame(trend(step=-0.004))["score"].tail(100).mean() < 0


def test_option_idea():
    assert "CALL" in option_idea("BUY", 100, 2) and "102.00" in option_idea("BUY", 100, 2)
    assert "PUT" in option_idea("STRONG SELL", 100, 2)
    assert option_idea("HOLD", 100, 2) is None


def test_too_little_history():
    with pytest.raises(ValueError):
        latest_signal("X", trend(days=30))


def test_synthetic_is_deterministic():
    pd.testing.assert_frame_equal(data.synthetic("AAPL"), data.synthetic("AAPL"))


def test_backtest_runs():
    res, frame = backtest.run(data.synthetic("DEMO"))
    assert 0 <= res.win_rate <= 1 and 0 <= res.exposure <= 1
    assert res.max_drawdown <= 0
    assert "equity" in frame


def test_csv_roundtrip(tmp_path):
    p = tmp_path / "px.csv"
    trend().rename_axis("date").reset_index().rename(columns=str.lower).to_csv(p, index=False)
    assert len(data.from_csv(str(p))) == 300


def test_cli_demo(capsys):
    assert main(["scan", "AAPL", "MSFT", "--demo", "--no-color"]) == 0
    out = capsys.readouterr().out
    assert "AAPL" in out and "not financial advice" in out
