"""Price data loaders: Yahoo Finance (yfinance), CSV files, or synthetic demo data."""
import zlib

import numpy as np
import pandas as pd

COLS = ["Open", "High", "Low", "Close", "Volume"]


def from_yahoo(ticker: str, period: str = "2y") -> pd.DataFrame:
    try:
        import yfinance as yf
    except ImportError as e:
        raise SystemExit("yfinance is not installed: pip install yfinance") from e
    df = yf.download(ticker, period=period, auto_adjust=True, progress=False)
    if df.empty:
        raise ValueError(f"{ticker}: no data returned from Yahoo Finance")
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    return df[COLS].dropna()


def from_csv(path: str) -> pd.DataFrame:
    """CSV with a Date column plus Open, High, Low, Close, Volume (case-insensitive)."""
    df = pd.read_csv(path)
    df.columns = [c.strip().title() for c in df.columns]
    if "Adj Close" in df.columns and "Close" not in df.columns:
        df["Close"] = df["Adj Close"]
    missing = [c for c in COLS + ["Date"] if c not in df.columns]
    if missing:
        raise ValueError(f"{path}: missing columns {missing}")
    df["Date"] = pd.to_datetime(df["Date"])
    return df.set_index("Date").sort_index()[COLS].dropna()


def synthetic(ticker: str = "DEMO", days: int = 500, seed: int | None = None) -> pd.DataFrame:
    """Random-walk OHLCV with regime shifts, for trying the tool offline."""
    rng = np.random.default_rng(seed if seed is not None else zlib.crc32(ticker.encode()))
    drift = np.repeat(rng.normal(0, 0.002, days // 50 + 1), 50)[:days]
    rets = drift + rng.normal(0, 0.018, days)
    close = 100 * np.exp(np.cumsum(rets))
    open_ = close * np.exp(rng.normal(0, 0.005, days))
    high = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.008, days)))
    low = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.008, days)))
    vol = rng.lognormal(15, 0.4, days).astype(int)
    idx = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=days)
    return pd.DataFrame({"Open": open_, "High": high, "Low": low, "Close": close, "Volume": vol}, index=idx)
