"""CLI:  python -m signals scan AAPL MSFT   |   python -m signals backtest AAPL"""
import argparse
import sys

from . import backtest, data
from .strategy import latest_signal

DISCLAIMER = "Educational tool only - not financial advice. Do your own research before trading."
COLORS = {"STRONG BUY": "\033[1;32m", "BUY": "\033[32m", "HOLD": "\033[33m", "SELL": "\033[31m", "STRONG SELL": "\033[1;31m"}


def load(ticker, args):
    if args.demo:
        return data.synthetic(ticker)
    if args.csv:
        return data.from_csv(args.csv)
    return data.from_yahoo(ticker, args.period)


def color(text, action, enabled):
    return f"{COLORS[action]}{text}\033[0m" if enabled else text


def cmd_scan(args):
    use_color = sys.stdout.isatty() and not args.no_color
    sigs = []
    for t in args.tickers:
        try:
            sigs.append(latest_signal(t.upper(), load(t, args), args.atr_mult))
        except Exception as e:  # keep scanning the rest of the list
            print(f"{t}: error - {e}", file=sys.stderr)
    sigs.sort(key=lambda s: s.score, reverse=True)
    print(f"\n{'TICKER':<8}{'DATE':<12}{'PRICE':>10}{'SCORE':>7}  ACTION")
    print("-" * 50)
    for s in sigs:
        print(f"{s.ticker:<8}{s.date:<12}{s.price:>10.2f}{s.score:>+7d}  {color(s.action, s.action, use_color)}")
    for s in sigs:
        print(f"\n== {s.ticker}: {color(s.action, s.action, use_color)} (score {s.score:+d})")
        for r in s.reasons:
            print(f"   {r}")
        if s.stop_loss:
            print(f"   Stop-loss ${s.stop_loss:.2f}   Target ${s.target:.2f}")
        if s.option_idea and not args.no_options:
            print(f"   Options: {s.option_idea}")
    print(f"\n{DISCLAIMER}")
    return 0 if sigs else 1


def cmd_backtest(args):
    df = load(args.ticker, args)
    res, _ = backtest.run(df, args.entry, args.exit, args.atr_mult)
    print(f"\nBacktest {args.ticker.upper()}  ({df.index[0].date()} -> {df.index[-1].date()}, {len(df)} bars)")
    print(f"  Trades            {res.trades}")
    print(f"  Win rate          {res.win_rate:.0%}")
    print(f"  Strategy return   {res.strategy_return:+.1%}")
    print(f"  Buy & hold        {res.buy_hold_return:+.1%}")
    print(f"  Max drawdown      {res.max_drawdown:.1%}")
    print(f"  Time in market    {res.exposure:.0%}")
    print(f"\nPast performance does not predict future results. {DISCLAIMER}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="signals", description="Technical-analysis buy/sell signals for stocks.")
    src = argparse.ArgumentParser(add_help=False)
    src.add_argument("--period", default="2y", help="Yahoo history period (default 2y)")
    src.add_argument("--csv", help="load OHLCV from a CSV file instead of Yahoo")
    src.add_argument("--demo", action="store_true", help="use synthetic data (no network)")
    src.add_argument("--atr-mult", type=float, default=2.0, help="stop-loss distance in ATRs (default 2)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", parents=[src], help="latest signal for one or more tickers")
    s.add_argument("tickers", nargs="+")
    s.add_argument("--no-options", action="store_true", help="hide call/put ideas")
    s.add_argument("--no-color", action="store_true")
    s.set_defaults(func=cmd_scan)

    b = sub.add_parser("backtest", parents=[src], help="test the strategy on history")
    b.add_argument("ticker")
    b.add_argument("--entry", type=int, default=3, help="buy when score >= this (default 3)")
    b.add_argument("--exit", type=int, default=-2, help="sell when score <= this (default -2)")
    b.set_defaults(func=cmd_backtest)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
