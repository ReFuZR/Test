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
| **Props** | Player over/unders (posted early in the day) and prop ladders like "25+ points" (Points, Rebounds, Assists, 3-Pointers, combos like PRA, double-doubles), each with the model %, the book's %, last-10 / season hit rates, and a last-10 bar chart. Each pick shows ✓ Verified or Split. Sort by *Likely*, *Verified* or *Vs book*. |
| **Slip** | Your legs, editable odds (match your book's price), and **Parlay vs Straights**: payout, hit chance and expected value for each. **Auto-parlay** scans the whole slate and builds the most likely 2-5 leg parlays that still pay at least +100 (Safer), +250 (Balanced) or +600 (Long shot). |
| **Tracker** | Bets you saved, graded automatically from ESPN box scores: record, profit, ROI, leg hit rate, parlays vs straights, hit rate by bet type, and an **"Is the model honest?"** table comparing predicted % with how often legs actually hit. Back up / Restore saves your history to a file. |
| **Injuries** | The injury report (all teams or just today's slate) plus trades and roster moves. |

## How the model works: two algorithms that check each other

Every bet is scored by two independent algorithms that use different slices of the data:

| | Season model (A) | Form model (B) |
|---|---|---|
| **Game lines** | Season point differential, shrunk toward average early in the season | Last 10 games, adjusted for opponent strength and home/away |
| **Player props** | Recency-weighted game log, plus actual hit rates this season and over the last 10 | Per-minute production × the minutes he's playing *now* (catches role changes) |
| **Injuries** | Charged by the share of the season the player has played | Charged by the share of the last 10 games he played |

- **✓ Verified:** the two land within 8 percentage points of each other.
- **Split:** they disagree, so treat the % with suspicion. By default Auto-parlay only uses Verified legs; there's a switch to allow Split legs.

The final % averages A and B, then blends that with the sportsbook's no-vig price (60% market for game lines, 35% for props). The market already knows about rest, rotations and late news. Game-line injury impact uses scoring and minutes, weighted Out 100% / Doubtful 80% / Questionable 40%. Scoring props are adjusted for the opponent's points allowed. Players listed as Out are dropped.

The **Tracker's Algorithm check** scores A, B and the final blend on your graded legs (Brier score; lower is sharper) and shows how often Verified legs hit versus Split legs. Over time you'll see which one to trust.

**Parlays.** Hit chance is the product of the legs' chances. That assumes the legs are independent, which isn't true for legs from the same game, so the app warns you about those. **Auto-parlay double-checks its own search:** after an exhaustive search for the most likely combo, a second, independent greedy search runs on the same legs, and if it ever finds a likelier parlay, that one is shown instead.

**Grading.** Moneyline, spread and total legs grade from the final score. Player legs grade from the box score. A player who doesn't play is voided, and that leg drops out of a parlay (the usual sportsbook rule). Postponed or canceled games void every leg on them. An over/under that lands exactly on a whole-number line is a push.

## Files

```
index.html, styles.css    the app
js/app.js                 screens and interactions
js/data.js                ESPN endpoints and parsers
js/model.js               odds math, predictions, parlay builder, grading
sw.js, manifest.webmanifest, icons/   home-screen install + offline shell
test/                     tests (run: npm test), using real saved ESPN responses
```

## Tests

`npm test` runs 110 tests (the browser ones need Playwright):

- **model.test.js:** odds math, both algorithms, parlays, grading and parsers against real ESPN data.
- **edge.test.js:** every bad input we could think of: invalid odds strings, empty and garbage ESPN responses, missing teams, negative or NaN stats, ties and pushes, DNPs, timeouts, offline with stale cache, HTTP errors. It also checks on 40 random slates that the parlay search is never beaten by the second search.
- **e2e.test.js:** the real app in a phone-sized browser. ESPN down / offline / sending garbage, each feed failing on its own, no odds or props posted, hostile team names, started games, corrupted saved data, junk backup files, invalid odds and stakes, double-tapping save, rapid day switching, automatic grading and voids, and no sideways scrolling at 320px in light and dark mode.

Your bets are stored only on your phone (browser storage). Use **Back up** in the Tracker now and then, especially before clearing browser data.
