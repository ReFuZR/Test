"""Long-only backtest: enter when score >= entry, exit when score <= exit or stop is hit."""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .strategy import scored_frame


@dataclass
class Result:
    trades: int
    win_rate: float
    strategy_return: float
    buy_hold_return: float
    max_drawdown: float
    exposure: float


def run(df: pd.DataFrame, entry: int = 3, exit: int = -2, atr_mult: float = 2.0, cost: float = 0.001) -> tuple[Result, pd.DataFrame]:
    """Signals are acted on at the NEXT bar's open to avoid look-ahead bias."""
    f = scored_frame(df)
    equity, pos, entry_px, stop = 1.0, False, 0.0, 0.0
    curve, trades, in_mkt = [], [], []
    for i in range(len(f) - 1):
        row, nxt = f.iloc[i], f.iloc[i + 1]
        if pos and row["Low"] <= stop:                     # stop-loss hit intrabar
            px = min(stop, row["Open"])
            equity *= px / entry_px * (1 - cost)
            trades.append(px / entry_px - 1)
            pos = False
        elif pos and pd.notna(row["score"]) and row["score"] <= exit:
            px = nxt["Open"]
            equity *= px / entry_px * (1 - cost)
            trades.append(px / entry_px - 1)
            pos = False
        elif not pos and pd.notna(row["score"]) and row["score"] >= entry:
            entry_px = nxt["Open"]
            stop = entry_px - atr_mult * row["atr"]
            equity *= 1 - cost
            pos = True
        in_mkt.append(pos)
        mark = equity * (row["Close"] / entry_px) if pos else equity
        curve.append(mark)
    curve = pd.Series(curve, index=f.index[:-1])
    if pos:
        trades.append(f["Close"].iloc[-1] / entry_px - 1)
    dd = (curve / curve.cummax() - 1).min() if len(curve) else 0.0
    first = f["score"].first_valid_index()
    start = f["Close"].loc[first] if first is not None else f["Close"].iloc[0]
    res = Result(
        trades=len(trades),
        win_rate=float(np.mean([t > 0 for t in trades])) if trades else 0.0,
        strategy_return=float(curve.iloc[-1] - 1) if len(curve) else 0.0,
        buy_hold_return=float(f["Close"].iloc[-1] / start - 1),
        max_drawdown=float(dd),
        exposure=float(np.mean(in_mkt)) if in_mkt else 0.0,
    )
    return res, f.assign(equity=curve)
