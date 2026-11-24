# Stock Trading Signals

A command-line tool that scans stocks and gives **BUY / SELL / HOLD** signals based on technical analysis. Each signal comes with a stop-loss, a price target and an optional **call/put options idea**. It also backtests the strategy on price history.

> ⚠️ **Educational tool only, not financial advice.** Technical signals are often wrong. Backtest results don't predict future returns, and options can lose 100% of their value. Never trade money you can't afford to lose.

## Install

```bash
pip install -r requirements.txt
```

## Usage

```bash
# Latest signal for a watchlist (live data from Yahoo Finance)
python -m signals scan AAPL MSFT NVDA TSLA SPY

# Hide the call/put ideas
python -m signals scan AAPL --no-options

# Backtest the strategy on 5 years of history
python -m signals backtest AAPL --period 5y

# Tune the backtest: buy at score >= 4, sell at score <= -1
python -m signals backtest AAPL --entry 4 --exit -1

# Your own data (CSV with Date, Open, High, Low, Close, Volume)
python -m signals scan MYSTOCK --csv prices.csv

# Offline demo with synthetic prices
python -m signals scan AAPL MSFT --demo
```

Example output:

```
TICKER  DATE             PRICE  SCORE  ACTION
--------------------------------------------------
UP      2025-02-21      298.19     +5  BUY

== UP: BUY (score +5)
   +2 price above 200-day SMA (long-term uptrend)
   +1 20-day SMA above 50-day
   +2 MACD bullish crossover
   Stop-loss $285.80   Target $322.96
   Options: Consider CALL, strike ~$304.38, 30-45 DTE (smaller size)
```

## How signals are scored

Each indicator adds or subtracts points:

| Signal | Points |
|---|---|
| Price above / below 200-day SMA | +2 / −2 |
| 20/50 SMA golden / death cross (on that day) | +2 / −2 |
| 20-day SMA above / below 50-day | +1 / −1 |
| MACD bullish / bearish crossover | +2 / −2 |
| MACD above / below signal line | +1 / −1 |
| RSI < 30 oversold / > 70 overbought | +2 / −2 |
| Close below lower / above upper Bollinger band | +1 / −1 |
| Volume > 1.5× average on an up / down day | +1 / −1 |

**Score → action:** ≥ 6 STRONG BUY · ≥ 3 BUY · −2…+2 HOLD · ≤ −3 SELL · ≤ −6 STRONG SELL

**Risk levels:** the stop-loss is 2 × ATR from price (`--atr-mult` changes this). The target is twice that distance, a 2:1 reward-to-risk ratio.

**Options idea:** on a buy signal it suggests a call about 1 ATR out of the money, 30–45 days to expiry. A sell signal gets the mirror-image put. These are generic starting points. They don't use live option chains, implied volatility or earnings dates.

**Backtest:** long only. It acts on each signal at the next day's open, so it can't see the future. It exits on the sell threshold or the stop-loss and charges 0.1% per trade.

## Project layout

```
signals/indicators.py  SMA, EMA, RSI, MACD, Bollinger Bands, ATR, volume ratio
signals/strategy.py    scoring, actions, stop/target, options idea
signals/data.py        Yahoo Finance, CSV and synthetic data loaders
signals/backtest.py    historical simulation
signals/__main__.py    command-line interface
tests/                 pytest suite (run: python -m pytest)
```
