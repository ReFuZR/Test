# Courtside Parlays

A betting assistant for your phone covering the **NBA, NFL, MLB, tennis and esports**. It pulls live odds, player props, injuries and trades, rates every bet with two independent algorithms that check each other, builds parlays, compares a parlay with the same money bet as straights, and grades your tracked bets automatically. The **Prop Finder** puts every prop on the slate in one sortable table with hit rates.

> **For entertainment, 21+.** No model can guarantee wins. Every leg you add to a parlay multiplies the sportsbook's edge, so parlays lose more often than they look like they should. Only bet what you can afford to lose. Gambling problem? Call 1-800-GAMBLER.

## Put it on your phone (one-time setup)

1. On GitHub, open this repo → **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
2. For esports: **Settings → Secrets and variables → Actions → New repository secret**. Name it `PANDASCORE_TOKEN` and paste your PandaScore API key. (Everything else works without it.)
3. Open the **Actions** tab, pick **Build and publish**, and click **Run workflow** (after that it runs by itself every 30 minutes and on every push).
4. When it finishes, the run shows the site's address (like `https://<user>.github.io/Test/`). Open it on your phone and add it to your home screen:
   - **iPhone (Safari):** Share → **Add to Home Screen**
   - **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install app**

There's no server and no account. NBA, NFL, MLB and tennis data comes straight from ESPN to your phone. Esports data comes from PandaScore through the GitHub Action, so your key stays in GitHub's secret store and never reaches the phone (PandaScore also doesn't allow direct calls from a web page).

## What's in it

Pick a sport in the row under the header. Your choice is remembered.

| Tab | What it does |
|---|---|
| **Games** | NBA/NFL/MLB: moneyline, spread (run line in MLB) and total from DraftKings, the model's % for each side, a win-chance bar and a "Double-check" panel showing both algorithms. NBA also shows each team's injuries with an estimated point impact. Tennis and esports: each match with a "to win" pick for both sides. **Injuries** (button at the top) has the injury report and trades. |
| **Finder** | Every prop on the slate in one table: player, prop, odds, and hit rates over the **last 5, 10, 20 games, the season, and head-to-head against tonight's opponent**, plus the model %. Sort by any column, filter by stat, overs/unders, L10 hit rate (60/70/80%+), "both algorithms agree", or search a player. Tap a row for a 20-game bar chart against the line and an Add to slip button. |
| **Props** | The same props grouped by player, with recent averages and a last-10 chart. |
| **Slip** | Your legs, editable odds, and **Parlay vs Straights** (payout, hit chance, expected value). **Auto-parlay** builds the most likely 2–5 leg parlays paying at least +100, +250 or +600, and double-checks its own search. |
| **Tracker** | Auto-graded bets: record, profit, ROI, legs hit, parlays vs straights, hit rate **by sport** and by bet type, "Is the model honest?" calibration, and the Algorithm check. Back up / Restore. |

### What each sport covers

| | Odds | Player props | Second algorithm uses | Grading |
|---|---|---|---|---|
| **NBA** | DraftKings via ESPN | Points, rebounds, assists, 3s, combos, double/triple-doubles | Per-minute rate × current minutes | Box score |
| **NFL** | DraftKings via ESPN | Pass/rush/rec yards, receptions, completions, attempts, carries, pass TDs, anytime TD, 2+ TDs | Per-target / per-carry / per-attempt rate × current role | Box score |
| **MLB** | DraftKings via ESPN | Hits, runs, RBIs, home runs, H+R+RBI, walks, batter Ks; pitcher strikeouts, hits allowed, earned runs, walks, outs | Per-at-bat / per-out rate | Box score |
| **Tennis** | None available free | — | Ranking points (A) vs ranking position (B) | ESPN result |
| **Esports** | None on PandaScore's free plan | — | Elo from ~300 recent results per title (A) vs last-10 record (B) | PandaScore result |

Esports titles: Counter-Strike 2, League of Legends, Dota 2, Valorant, Rainbow Six Siege, Rocket League, Call of Duty, Overwatch, Mobile Legends, Honor of Kings, Wild Rift, StarCraft II, StarCraft: Brood War and EA Sports FC. PUBG is left out: it's a battle royale, so head-to-head picks don't apply.

**Where there's no sportsbook price** (tennis, esports, and NFL props the book has posted but not priced yet) the app shows the model's **fair** price, marked "fair". Type your book's real price into the slip before you save; the slip warns you until you do.

Some prop markets are deliberately left out because the app couldn't grade them automatically: MLB total bases, singles, doubles, triples and stolen bases (ESPN box scores don't list them), and first/last touchdown scorers.

**Off-season:** MLB runs roughly late March to October and tennis is quiet from late November to January. The app says so when a sport has no games on the chosen day.

## How the model works: two algorithms that check each other

| | Season model (A) | Form model (B) |
|---|---|---|
| **Game lines** | Season scoring margin, shrunk toward average early in the season | Last 10 games, adjusted for opponent strength and home/away |
| **Player props** | Recency-weighted game log, plus actual hit rates this season and over the last 10 | Rate per opportunity (minutes, targets, carries, at-bats, outs) × his current role; last-5 form where there's no opportunity stat |
| **Tennis** | Ranking points | Ranking position |
| **Esports** | Elo rating | Recent win rate |

- **✓ Verified:** the two land within 8 percentage points of each other.
- **Split:** they disagree, so treat the % with suspicion. Auto-parlay and the Finder can be limited to Verified picks.

Each sport has its own settings (home edge, how spread out results are, how fast early-season numbers are trusted). Where a sportsbook price exists, the final % blends the two algorithms with the book's no-vig price (60% market for game lines, 35% for props). Props are skipped when a player's recent log is nowhere near the book's line (a sign the log doesn't reflect his current role), and match picks are skipped when neither side has any rating.

**Parlays.** Hit chance is the product of the legs' chances, which assumes the legs are independent. That isn't true for legs from the same game or on the same player, and the slip warns you about those.

**Grading.** Game lines grade from the final score; player legs from the box score; tennis and esports from the match winner. A player who doesn't play is voided and drops out of a parlay. Postponed or canceled games void their legs. An over/under that lands exactly on a whole-number line is a push.

## Files

```
index.html, styles.css         the app
js/app.js                      screens and interactions
js/sports.js                   per-sport settings and prop markets
js/data.js                     ESPN / esports data and parsers
js/model.js                    odds math, both algorithms, parlay builder, grading
scripts/esports.mjs            builds data/esports.json from PandaScore (run by the GitHub Action)
.github/workflows/site.yml     tests, builds esports data, publishes to GitHub Pages every 30 min
sw.js, manifest.webmanifest, icons/   home-screen install + offline shell
test/                          tests (npm test), using real saved ESPN and PandaScore data
```

## Tests

`npm test` runs 151 tests (the browser ones need Playwright):

- **model.test.js / edge.test.js:** odds math, both algorithms, parlays, grading, and every bad input we could think of (invalid odds, garbage responses, NaN stats, ties, DNPs, timeouts, offline).
- **sports.test.js:** NFL, MLB, tennis and esports parsers against real data, the per-sport models, and the esports builder without a key.
- **e2e.test.js:** the app in a phone-sized browser: outages, bad data, user mistakes, grading, and no sideways scrolling at 320px.
- **e2e-sports.test.js:** sport switching (including mid-load), the Finder's sorting, filters, search and chart, unpriced NFL props, tennis and esports picks and grading, the esports setup messages, and a parlay that mixes sports.

Your bets are stored only on your phone. Use **Back up** in the Tracker now and then.
