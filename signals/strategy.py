"""Combine indicators into a scored BUY / SELL / HOLD signal with risk levels and an options idea."""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .indicators import add_all

MIN_BARS = 60  # need enough history for SMA50 / MACD to be meaningful


@dataclass
class Signal:
    ticker: str
    date: str
    price: float
    score: int                      # roughly -10 (very bearish) .. +10 (very bullish)
    action: str                     # STRONG BUY / BUY / HOLD / SELL / STRONG SELL
    reasons: list = field(default_factory=list)
    stop_loss: float | None = None
    target: float | None = None
    option_idea: str | None = None


def score_row(row: pd.Series, prev: pd.Series) -> tuple[int, list[str]]:
    """Score one bar using the current and previous bar's indicators."""
    score, why = 0, []

    def vote(points, reason):
        nonlocal score
        score += points
        why.append(f"{'+' if points > 0 else ''}{points} {reason}")

    c = row["Close"]
    # Trend
    if pd.notna(row["sma200"]):
        vote(2, "price above 200-day SMA (long-term uptrend)") if c > row["sma200"] else vote(-2, "price below 200-day SMA (long-term downtrend)")
    if pd.notna(row["sma50"]) and pd.notna(row["sma20"]):
        if prev["sma20"] <= prev["sma50"] and row["sma20"] > row["sma50"]:
            vote(2, "20/50 SMA golden cross")
        elif prev["sma20"] >= prev["sma50"] and row["sma20"] < row["sma50"]:
            vote(-2, "20/50 SMA death cross")
        elif row["sma20"] > row["sma50"]:
            vote(1, "20-day SMA above 50-day")
        else:
            vote(-1, "20-day SMA below 50-day")
    # Momentum: MACD
    if pd.notna(row["macd_hist"]) and pd.notna(prev["macd_hist"]):
        if prev["macd_hist"] <= 0 < row["macd_hist"]:
            vote(2, "MACD bullish crossover")
        elif prev["macd_hist"] >= 0 > row["macd_hist"]:
            vote(-2, "MACD bearish crossover")
        elif row["macd_hist"] > 0:
            vote(1, "MACD above signal line")
        else:
            vote(-1, "MACD below signal line")
    # Mean reversion: RSI and Bollinger
    r = row["rsi"]
    if pd.notna(r):
        if r < 30:
            vote(2, f"RSI {r:.0f} oversold")
        elif r > 70:
            vote(-2, f"RSI {r:.0f} overbought")
    b = row["bb_pct"]
    if pd.notna(b):
        if b < 0:
            vote(1, "closed below lower Bollinger band")
        elif b > 1:
            vote(-1, "closed above upper Bollinger band")
    # Volume confirms the day's move
    if pd.notna(row["vol_ratio"]) and row["vol_ratio"] > 1.5:
        up = c > prev["Close"]
        vote(1 if up else -1, f"volume {row['vol_ratio']:.1f}x average on {'up' if up else 'down'} day")
    return score, why


def action_for(score: int) -> str:
    if score >= 6:
        return "STRONG BUY"
    if score >= 3:
        return "BUY"
    if score <= -6:
        return "STRONG SELL"
    if score <= -3:
        return "SELL"
    return "HOLD"


def option_idea(action: str, price: float, atr_val: float) -> str | None:
    """A simple, generic options idea. Strike ~1 ATR out of the money, 30-45 days out."""
    if np.isnan(atr_val):
        return None
    if action in ("STRONG BUY", "BUY"):
        strike = price + atr_val
        return f"Consider CALL, strike ~${strike:.2f}, 30-45 DTE" + ("" if action == "STRONG BUY" else " (smaller size)")
    if action in ("STRONG SELL", "SELL"):
        strike = price - atr_val
        return f"Consider PUT, strike ~${strike:.2f}, 30-45 DTE" + ("" if action == "STRONG SELL" else " (smaller size)")
    return None


def scored_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Indicator frame plus a per-bar 'score' and 'action' column (used by the backtester)."""
    ind = add_all(df)
    scores = [np.nan]
    for i in range(1, len(ind)):
        scores.append(score_row(ind.iloc[i], ind.iloc[i - 1])[0])
    ind["score"] = scores
    ind.loc[ind.index[:MIN_BARS], "score"] = np.nan
    ind["action"] = ind["score"].map(lambda s: action_for(int(s)) if pd.notna(s) else None)
    return ind


def latest_signal(ticker: str, df: pd.DataFrame, atr_mult: float = 2.0) -> Signal:
    if len(df) < MIN_BARS:
        raise ValueError(f"{ticker}: need at least {MIN_BARS} bars, got {len(df)}")
    ind = add_all(df)
    row, prev = ind.iloc[-1], ind.iloc[-2]
    score, why = score_row(row, prev)
    action = action_for(score)
    price, a = float(row["Close"]), float(row["atr"])
    stop = target = None
    if action.endswith("BUY"):
        stop, target = price - atr_mult * a, price + 2 * atr_mult * a
    elif action.endswith("SELL"):
        stop, target = price + atr_mult * a, price - 2 * atr_mult * a
    return Signal(ticker, str(pd.Timestamp(ind.index[-1]).date()), price, score, action, why,
                  stop, target, option_idea(action, price, a))
