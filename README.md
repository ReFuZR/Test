# Courtside Parlays

An NBA betting assistant that runs on your phone. It pulls live odds, player props, injuries and trades from ESPN, estimates each bet's chance of hitting, builds parlays, compares a parlay with the same money bet as straights, and grades your tracked bets automatically when the games end.

> **For entertainment, 21+.** No model can guarantee wins. Every leg you add to a parlay multiplies the sportsbook's edge, so parlays lose more often than they look like they should. Only bet what you can afford to lose. Gambling problem? Call 1-800-GAMBLER.

## Put it on your phone

1. On GitHub, open this repo → **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick the branch this code is on, folder **/ (root)**, and save.
3. After a minute GitHub shows the site's address (like `https://<user>.github.io/Test/`). Open it on your phone.
4. Add it to your home screen:
   - **iPhone (Safari):** Share → **Add to Home Screen**
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**

It then opens full-screen like a normal app. There's no server and no account; it talks to ESPN directly from your phone.

## What's in it

| Tab | What it does |
|---|---|
| **Games** | Every game with DraftKings moneyline, spread and total, the model's % for each side, a projected score, and each team's injuries with an estimated point impact. Tap a price to add it to your slip. |
| **Props** | Player prop ladders (Points, Rebounds, Assists, 3-Pointers, combos like PRA, double-doubles), each with the model %, the book's %, last-10 / season hit rates, and a last-10 bar chart. Sort by *Most likely* or *Best vs. book*. |
| **Slip** | Your legs, editable odds (match your book's price), and **Parlay vs Straights**: payout, hit chance and expected value for each. **Auto-parlay** scans the whole slate and builds the most likely 2-5 leg parlays that still pay at least +100 (Safer), +250 (Balanced) or +600 (Long shot). |
| **Tracker** | Bets you saved, graded automatically from ESPN box scores: record, profit, ROI, leg hit rate, parlays vs straights, hit rate by bet type, and an **"Is the model honest?"** table comparing predicted % with how often legs actually hit. Back up / Restore saves your history to a file. |
| **Injuries** | The injury report (all teams or just today's slate) plus trades and roster moves. |

## How the model works

**Game lines.** Each team's season point differential, shrunk toward average early in the season, plus 2.2 points for home court. It subtracts the estimated impact of injured players (based on their scoring and minutes, weighted Out 100% / Doubtful 80% / Questionable 40%) and turns the projected margin and total into win, cover and over/under probabilities. That estimate is then blended 40/60 with the sportsbook's no-vig line. The market already knows about rest, rotations and late news, so this keeps the numbers realistic.

**Player props.** Recency-weighted averages from the player's game log (last season fills in when there are fewer than 8 games this season). Low-count stats use a Poisson distribution, the rest a normal distribution, mixed with actual hit rates over the season and last 10 games. Scoring props are adjusted for the opponent's points allowed. The result is blended 65/35 with the book's price. Players listed as Out are dropped.

**Parlays.** Hit chance is the product of the legs' chances. That assumes the legs are independent, which isn't true for legs from the same game, so the app warns you about those.

**Grading.** Moneyline, spread and total legs grade from the final score. Player legs grade from the box score. A player who doesn't play is voided, and that leg drops out of a parlay (the usual sportsbook rule).

## Files

```
index.html, styles.css    the app
js/app.js                 screens and interactions
js/data.js                ESPN endpoints and parsers
js/model.js               odds math, predictions, parlay builder, grading
sw.js, manifest.webmanifest, icons/   home-screen install + offline shell
test/                     unit tests (run: npm test) with real saved ESPN responses
```

Your bets are stored only on your phone (browser storage). Use **Back up** in the Tracker now and then, especially before clearing browser data.
