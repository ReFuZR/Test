// Pure betting math and two independent prediction algorithms. No network, no DOM, so it's unit-tested in Node.
//
//   Algorithm A ("Season"): season-long scoring, recency-weighted game logs, actual hit rates.
//   Algorithm B ("Form"):   last-10 opponent-adjusted results for teams; per-minute rates x projected minutes for players.
//
// Each bet gets both numbers. When they agree the pick is marked Verified; when they don't, it's a Split
// and the app treats it with suspicion (Auto-parlay skips Splits by default).

export const HOME_COURT = 2.2;   // points of home-court advantage
export const SD_MARGIN = 12.5;   // std dev of NBA final margin vs. expectation
export const SD_TOTAL = 18.5;    // std dev of NBA game total vs. expectation
export const VERIFY_TOLERANCE = 0.08;  // algorithms must land within 8 percentage points to "verify"

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

// ---------- odds helpers ----------
/** Parse American odds from a number or string ("+150", "-110", "EVEN"). Returns NaN for anything invalid. */
export function parseAmerican(v) {
  if (typeof v === "string") {
    const s = v.trim().toUpperCase();
    if (s === "EVEN" || s === "EV" || s === "PK") return 100;
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return NaN;
    v = Number(s);
  }
  if (!finite(v) || Math.abs(v) < 100) return NaN;   // American odds are always <= -100 or >= +100
  return v;
}

export function toDecimal(american) {
  const a = parseAmerican(american);
  if (!finite(a)) return NaN;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

export function toAmerican(decimal) {
  if (!finite(decimal) || decimal <= 1) return NaN;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export const fmtAmerican = (a) => (!finite(a) ? "—" : a > 0 ? `+${a}` : `${a}`);
export const impliedProb = (american) => 1 / toDecimal(american);

/** Remove the bookmaker's margin from a two-way market. */
export function noVig(americanA, americanB) {
  const a = impliedProb(americanA), b = impliedProb(americanB);
  if (!finite(a) || !finite(b)) return [NaN, NaN];
  return [a / (a + b), b / (a + b)];
}

/** One-sided prop prices carry ~5% vig; strip it roughly so a ladder rung can be compared fairly. */
export const fairOneSided = (american) => { const p = impliedProb(american); return finite(p) ? clamp(p / 1.05, 0.005, 0.99) : NaN; };

// ---------- distributions ----------
export function normCdf(z) {
  if (!finite(z)) return z === Infinity ? 1 : z === -Infinity ? 0 : NaN;
  // Abramowitz-Stegun 7.1.26 approximation of erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** P(X >= k) for Poisson(lambda). */
export function poissonAtLeast(k, lambda) {
  if (!finite(k) || !finite(lambda) || lambda < 0) return NaN;
  if (k <= 0) return 1;
  if (lambda === 0) return 0;
  let term = Math.exp(-lambda), cdf = term;
  for (let i = 1; i < Math.ceil(k); i++) { term *= lambda / i; cdf += term; }
  return clamp(1 - cdf, 0, 1);
}

/** P(count >= threshold) given a mean and spread: Poisson for small means, normal (continuity-corrected) otherwise. */
function atLeast(threshold, mu, sd) {
  if (mu < 6) return poissonAtLeast(threshold, Math.max(mu, 0.05));
  return 1 - normCdf((threshold - 0.5 - mu) / Math.max(sd, 1));
}

/** Blend a stats estimate with the market's. wMarket = weight on the market. */
export function blend(pStats, pMarket, wMarket = 0.6) {
  if (!finite(pMarket)) return finite(pStats) ? clamp(pStats, 0.01, 0.99) : NaN;
  if (!finite(pStats)) return pMarket;
  return clamp((1 - wMarket) * pStats + wMarket * pMarket, 0.01, 0.99);
}

/** Cross-check two algorithms. Verified when they land within the tolerance. */
export function consensus(pA, pB, tol = VERIFY_TOLERANCE) {
  const a = finite(pA), b = finite(pB);
  if (!a && !b) return { p: NaN, gap: NaN, verified: false, status: "none" };
  if (!a || !b) return { p: a ? pA : pB, gap: NaN, verified: false, status: "single" };
  const gap = Math.abs(pA - pB);
  const ok = gap <= tol + 1e-9;   // floating-point slack: 0.68 - 0.60 is 0.08000000000000007
  return { p: (pA + pB) / 2, gap, verified: ok, status: ok ? "verified" : "split" };
}

// ---------- algorithm A: season model for games ----------
const validTeam = (t) => t && finite(t.ppg) && finite(t.opp) && finite(t.wins) && finite(t.losses);

/** Sport settings; defaults are the NBA's. hca = home edge in points/runs, sd* = spread of results. */
const NBA_CFG = { hca: HOME_COURT, sdMargin: SD_MARGIN, sdTotal: SD_TOTAL, shrinkGames: 8 };
const cfgOf = (c) => ({ ...NBA_CFG, ...(c || {}) });

/** Team strength in points per game vs. average, shrunk toward 0 early in the season. */
export function teamRating(t, cfg) {
  if (!validTeam(t)) return 0;
  const gp = t.wins + t.losses + (finite(t.ties) ? t.ties : 0);
  return gp > 0 ? (t.ppg - t.opp) * gp / (gp + cfgOf(cfg).shrinkGames) : 0;
}

/** Season-based projection. Returns null when either team's numbers are missing. */
export function projectGame(home, away, { homeInjury = 0, awayInjury = 0 } = {}, cfg) {
  if (!validTeam(home) || !validTeam(away)) return null;
  const c = cfgOf(cfg);
  const hi = finite(homeInjury) ? homeInjury : 0, ai = finite(awayInjury) ? awayInjury : 0;
  const margin = teamRating(home, c) - teamRating(away, c) + c.hca - hi + ai;
  const total = (home.ppg + away.opp) / 2 + (away.ppg + home.opp) / 2 - (hi + ai) / 2;
  return { margin, total, homePts: total / 2 + margin / 2, awayPts: total / 2 - margin / 2, pHome: normCdf(margin / c.sdMargin), sdMargin: c.sdMargin, sdTotal: c.sdTotal };
}

// ---------- algorithm B: recent-form model for games ----------
/**
 * Opponent-adjusted form over the last `n` games.
 * games: [{home: bool, pf, pa, oppId}] most recent first. ratings: {teamId: season rating} to credit tough opponents.
 */
export function formRating(games, ratings = {}, n = 10, cfg) {
  const c = cfgOf(cfg);
  const g = (games || []).filter((x) => x && finite(x.pf) && finite(x.pa)).slice(0, n);
  if (!g.length) return null;
  const adj = g.map((x) => (x.pf - x.pa) - (x.home ? c.hca : -c.hca) + (finite(ratings[x.oppId]) ? ratings[x.oppId] : 0));
  return { rating: mean(adj) * g.length / (g.length + 4), pf: mean(g.map((x) => x.pf)), pa: mean(g.map((x) => x.pa)), n: g.length };
}

export function projectGameForm(homeForm, awayForm, { homeInjury = 0, awayInjury = 0 } = {}, cfg) {
  if (!homeForm || !awayForm) return null;
  const c = cfgOf(cfg);
  const hi = finite(homeInjury) ? homeInjury : 0, ai = finite(awayInjury) ? awayInjury : 0;
  const margin = homeForm.rating - awayForm.rating + c.hca - hi + ai;
  const total = (homeForm.pf + awayForm.pa) / 2 + (awayForm.pf + homeForm.pa) / 2 - (hi + ai) / 2;
  return { margin, total, homePts: total / 2 + margin / 2, awayPts: total / 2 - margin / 2, pHome: normCdf(margin / c.sdMargin), sdMargin: c.sdMargin, sdTotal: c.sdTotal };
}

/** Probability the side covers. line is that side's spread (e.g. -4.5); marginForSide is expected margin for that side. */
export const pCover = (marginForSide, line, sd = SD_MARGIN) => (finite(marginForSide) && finite(line) ? normCdf((marginForSide + line) / sd) : NaN);
export const pOver = (projTotal, line, sd = SD_TOTAL) => (finite(projTotal) && finite(line) ? normCdf((projTotal - line) / sd) : NaN);

// ---------- head-to-head matches with no sportsbook line (tennis, esports) ----------
/** Tennis algorithm A: ranking points as strength (Bradley-Terry). Players outside the list get a low default. */
export function tennisPointsProb(ptsA, ptsB) {
  const a = finite(ptsA) && ptsA > 0 ? ptsA : 250, b = finite(ptsB) && ptsB > 0 ? ptsB : 250;
  return clamp(a / (a + b), 0.03, 0.97);
}
/** Tennis algorithm B: ranking position (log scale), which smooths the points gaps at the very top. */
export function tennisRankProb(rankA, rankB) {
  const a = finite(rankA) && rankA > 0 ? rankA : 200, b = finite(rankB) && rankB > 0 ? rankB : 200;
  return clamp(1 / (1 + Math.pow(a / b, 0.85)), 0.03, 0.97);
}
/** Elo win probability. */
export const eloProb = (ra, rb) => (finite(ra) && finite(rb) ? 1 / (1 + Math.pow(10, (rb - ra) / 400)) : NaN);
/** Esports algorithm B: recent win rates (shrunk toward 50%), combined head-to-head with log5. */
export function formProb(winsA, gamesA, winsB, gamesB) {
  const r = (w, g) => (finite(w) && finite(g) && g >= 0 ? (w + 3) / (g + 6) : 0.5);
  const a = r(winsA, gamesA), b = r(winsB, gamesB);
  return clamp((a - a * b) / (a + b - 2 * a * b), 0.03, 0.97);
}
/** Fair American price for a probability (no vig): what the model thinks the bet is worth. */
export const fairAmerican = (p) => (finite(p) && p > 0 && p < 1 ? toAmerican(1 / p) : NaN);

/** Rough margin cost of losing a player, from his scoring and minutes. Capped so one player can't swing a game more than 6 pts. */
export function injuryImpact({ ppg = 0, rpg = 0, apg = 0, mpg = 0 } = {}) {
  const v = (x) => (finite(x) && x > 0 ? x : 0);
  if (v(mpg) < 12) return 0;
  return clamp(0.14 * v(ppg) + 0.06 * v(rpg) + 0.1 * v(apg) - 0.8, 0, 6);
}

// ---------- algorithm A: game-log model for props ----------
const cleanValues = (values) => (values || []).filter((v) => finite(v) && v >= 0);

/**
 * Probability a player records at least `threshold` of a stat.
 * values: stat per game, most recent first. oppFactor scales the mean for matchup (1 = neutral).
 */
export function propProb(values, threshold, oppFactor = 1) {
  const xs = cleanValues(values);
  const n = xs.length;
  if (!n || !finite(threshold)) return null;
  const f = finite(oppFactor) && oppFactor > 0 ? oppFactor : 1;
  const weights = xs.map((_, i) => Math.pow(0.93, i));
  const wSum = weights.reduce((s, w) => s + w, 0);
  const mu = xs.reduce((s, v, i) => s + v * weights[i], 0) / wSum * f;
  const m = mean(xs);
  const sd = Math.max(Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1)), Math.sqrt(Math.max(mu, 0.5)) * 0.9, 1);

  const pDist = atLeast(threshold, mu, sd);
  const hit = (arr) => (arr.length ? arr.filter((v) => v >= threshold).length / arr.length : null);
  const hitSeason = hit(xs), hitL10 = hit(xs.slice(0, 10)), hitL5 = hit(xs.slice(0, 5));

  const wEmp = clamp(n / 20, 0, 0.5);
  const p = clamp((1 - wEmp) * pDist + wEmp * (0.5 * hitSeason + 0.5 * hitL10), 0.02, 0.98);
  return { p, mean: mu, sd, n, hitSeason, hitL10, hitL5, confidence: n >= 15 ? "high" : n >= 8 ? "medium" : "low" };
}

/** Double/triple-double probability from game logs: rows of {pts, reb, ast, stl, blk}. */
export function multiDoubleProb(rows, cats = 2) {
  const rs = (rows || []).filter(Boolean);
  if (!rs.length) return null;
  const isHit = (r) => ["pts", "reb", "ast", "stl", "blk"].filter((k) => r[k] >= 10).length >= cats;
  const k = rs.filter(isHit).length, l10 = rs.slice(0, 10), k10 = l10.filter(isHit).length;
  const season = (k + 0.5) / (rs.length + 1), last = (k10 + 0.5) / (l10.length + 1);
  return { p: clamp(0.6 * season + 0.4 * last, 0.01, 0.97), n: rs.length, hitSeason: k / rs.length, hitL10: k10 / l10.length };
}

// ---------- algorithm B: per-minute model for props ----------
/**
 * Projects the stat as (per-minute rate) x (expected minutes), so a player whose role just grew or shrank
 * is judged on his current minutes instead of his season average.
 * rows: [{min, ...stats}] most recent first. statOf(row) returns the stat for a game.
 */
export function perMinuteProp(rows, threshold, statOf, oppFactor = 1) {
  return perVolumeProp(rows, threshold, statOf, (r) => r.min, oppFactor);
}

/**
 * Same idea for any opportunity stat: rate per opportunity x expected opportunities (minutes in the NBA,
 * targets/carries/attempts in the NFL, at-bats or outs in MLB). Returns `projMin` for the projected volume.
 */
export function perVolumeProp(rows, threshold, statOf, volOf, oppFactor = 1) {
  const rs = (rows || []).filter((r) => r && finite(volOf(r)) && volOf(r) > 0 && finite(statOf(r)) && statOf(r) >= 0);
  if (rs.length < 3 || !finite(threshold)) return null;
  const w = rs.map((_, i) => Math.pow(0.95, i));
  const rate = rs.reduce((s, r, i) => s + statOf(r) * w[i], 0) / rs.reduce((s, r, i) => s + volOf(r) * w[i], 0);
  const projMin = mean(rs.slice(0, 5).map(volOf));
  const f = finite(oppFactor) && oppFactor > 0 ? oppFactor : 1;
  const mu = rate * projMin * f;
  const perVol = rs.map((r) => statOf(r) / volOf(r));
  const pm = mean(perVol);
  const sdRate = Math.sqrt(perVol.reduce((s, v) => s + (v - pm) ** 2, 0) / Math.max(1, perVol.length - 1));
  const sd = Math.max(sdRate * projMin, Math.sqrt(Math.max(mu, 0.5)) * 1.1, 1);
  return { p: clamp(atLeast(threshold, mu, sd), 0.02, 0.98), mean: mu, projMin, rate, n: rs.length };
}

/**
 * Second algorithm for markets with no opportunity stat (carries, pass attempts, outs): the last 5 games only,
 * with a spread taken from the whole log. Disagrees with algorithm A exactly when recent form has moved.
 */
export function recentProp(values, threshold, oppFactor = 1) {
  const xs = cleanValues(values);
  if (xs.length < 3 || !finite(threshold)) return null;
  const f = finite(oppFactor) && oppFactor > 0 ? oppFactor : 1;
  const recent = xs.slice(0, 5), mu = mean(recent) * f, m = mean(xs);
  const sd = Math.max(Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)), Math.sqrt(Math.max(mu, 0.5)), 1);
  return { p: clamp(atLeast(threshold, mu, sd), 0.02, 0.98), mean: mu, n: recent.length };
}

/** Per-minute version of the double/triple-double: chance each category reaches 10, combined. */
export function perMinuteMultiDouble(rows, cats = 2) {
  if ((rows || []).filter((r) => r && r.min > 0).length < 3) return null;
  const keys = ["pts", "reb", "ast", "stl", "blk"];
  // A category the player basically never reaches gets ~0, not the 2% floor perMinuteProp applies
  const ps = keys.map((k) => { const r = perMinuteProp(rows, 10, (x) => x[k], 1); return !r ? 0 : r.mean < 2 ? 0 : r.p; });
  // P(at least `cats` of the categories hit), treating categories as independent
  let dist = [1];
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, i) => { next[i] += q * (1 - p); next[i + 1] += q * p; });
    dist = next;
  }
  const p = dist.slice(cats).reduce((s, x) => s + x, 0);
  return { p: clamp(p, 0.01, 0.97) };
}

// ---------- parlays ----------
export function parlayMath(legs) {
  const ls = (legs || []).filter(Boolean);
  if (!ls.length) return null;
  const dec = ls.reduce((d, l) => d * toDecimal(l.american), 1);
  const pModel = ls.reduce((p, l) => p * (finite(l.pModel) ? l.pModel : NaN), 1);
  return {
    decimal: dec, american: toAmerican(dec), pModel, pBook: 1 / dec,
    ev: pModel * dec - 1,
    valid: finite(dec) && finite(pModel),
    sameGame: new Set(ls.map((l) => l.eventId)).size < ls.length,
    verified: ls.every((l) => l.verified),
  };
}

/** Compare one parlay vs. splitting the same total stake across straight bets. */
export function compareStraightVsParlay(legs, stake = 10) {
  const parlay = parlayMath(legs);
  if (!parlay) return null;
  const s = finite(stake) && stake > 0 ? stake : 0;
  const each = s / legs.length;
  const straights = legs.map((l) => {
    const d = toDecimal(l.american);
    return { label: l.label, stake: each, toWin: each * (d - 1), p: l.pModel, ev: each * (l.pModel * d - 1) };
  });
  return {
    parlay: { stake: s, toWin: s * (parlay.decimal - 1), p: parlay.pModel, ev: s * parlay.ev, american: parlay.american },
    straights,
    straightsEv: straights.reduce((t, x) => t + x.ev, 0),
    straightsPAnyWin: 1 - legs.reduce((q, l) => q * (1 - l.pModel), 1),
  };
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < arr.length; i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop(); }
}

/**
 * Suggest parlays: for each size, the leg combination with the highest model hit probability
 * that still pays at least `minAmerican`. One leg per player, one game-line leg per game.
 * verifiedOnly keeps legs both algorithms agree on.
 */
export function suggestParlays(candidates, { sizes = [2, 3, 4], minAmerican = 100, pool = 24, maxSameGame = 2, verifiedOnly = false } = {}) {
  const minDec = toDecimal(minAmerican);
  const score = (c) => c.pModel * (1 + Math.max(0, c.pModel - impliedProb(c.american)));
  const ranked = (candidates || [])
    .filter((c) => c && finite(c.pModel) && finite(toDecimal(c.american)) && c.pModel > 0.3 && (!verifiedOnly || c.verified))
    .sort((a, b) => score(b) - score(a));
  // Keep the pool spread across games: one game with many near-locks would otherwise fill it, and the
  // per-game cap would then leave no room for 3+ leg parlays.
  const perGameCap = Math.max(maxSameGame + 2, Math.ceil(pool / 4));
  const seen = {}, top = [];
  for (const c of ranked) {
    if ((seen[c.eventId] = (seen[c.eventId] || 0) + 1) > perGameCap) continue;
    top.push(c);
    if (top.length === pool) break;
  }
  const out = [];
  for (const k of sizes) {
    if (k > top.length) continue;
    let best = null;
    for (const c of combos(top, k)) {
      const players = c.filter((l) => l.athleteId).map((l) => l.athleteId);
      if (new Set(players).size !== players.length) continue;
      const lines = c.filter((l) => !l.athleteId).map((l) => l.eventId);
      if (new Set(lines).size !== lines.length) continue;
      const perGame = {};
      if (c.some((l) => (perGame[l.eventId] = (perGame[l.eventId] || 0) + 1) > maxSameGame)) continue;
      const m = parlayMath(c);
      if (!m.valid || m.decimal < minDec) continue;
      if (!best || m.pModel > best.math.pModel) best = { legs: c, math: m };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Independent check of the parlay search: greedy build (take the likeliest leg that fits, repeat).
 * If greedy finds a combo the exhaustive search missed that is more likely, the search is wrong.
 */
export function greedyParlay(candidates, size, minAmerican = 100, { maxSameGame = 2 } = {}) {
  // Same rules as suggestParlays, or the "double-check" could win only by breaking them
  const pool = (candidates || []).filter((c) => c && finite(c.pModel) && c.pModel > 0.3 && finite(toDecimal(c.american))).sort((a, b) => b.pModel - a.pModel);
  const pick = [];
  for (const c of pool) {
    if (pick.length === size) break;
    if (c.athleteId && pick.some((l) => l.athleteId === c.athleteId)) continue;
    if (!c.athleteId && pick.some((l) => !l.athleteId && l.eventId === c.eventId)) continue;
    if (pick.filter((l) => l.eventId === c.eventId).length >= maxSameGame) continue;
    pick.push(c);
  }
  if (pick.length < size) return null;
  const m = parlayMath(pick);
  return m.decimal >= toDecimal(minAmerican) ? { legs: pick, math: m } : null;
}

// ---------- grading ----------
/**
 * Grade one leg against a final result.
 * result: {completed, home:{id,score}, away:{id,score}, players:{[athleteId]: {pts,reb,ast,tpm,stl,blk,dnp}}}
 */
export function gradeLeg(leg, result) {
  if (!leg || !result) return "pending";
  if (result.canceled) return "void";
  if (!result.completed) return "pending";
  const hs = result.home?.score, as = result.away?.score;
  const scored = finite(hs) && finite(as);
  const forSide = (side) => (side === "home" ? hs - as : as - hs);
  switch (leg.kind) {
    case "ml": return !scored ? "pending" : forSide(leg.side) > 0 ? "win" : forSide(leg.side) < 0 ? "loss" : "push";
    case "win": {                                           // tennis / esports: did the picked side win?
      if (!result.winnerId) return result.draw ? "push" : "void";
      return String(result.winnerId) === String(leg.pickId) ? "win" : "loss";
    }
    case "spread": {
      if (!scored || !finite(leg.line)) return "pending";
      const v = forSide(leg.side) + leg.line;
      return v > 0 ? "win" : v < 0 ? "loss" : "push";
    }
    case "total": {
      if (!scored || !finite(leg.line)) return "pending";
      const t = hs + as;
      if (t === leg.line) return "push";
      return (leg.side === "over") === (t > leg.line) ? "win" : "loss";
    }
    case "prop": case "dd": case "td": {
      const p = result.players?.[leg.athleteId];
      if (!p || p.dnp) return "void";
      if (leg.kind === "prop") {
        const vals = (leg.stats || []).map((k) => p[k]);
        if (!vals.length || vals.some((v) => !finite(v))) return "void";
        const got = vals.reduce((s, v) => s + v, 0);
        if (finite(leg.line)) {                               // over/under market: exact line is a push
          if (got === leg.line) return "push";
          return (leg.side === "under") === (got < leg.line) ? "win" : "loss";
        }
        if (!finite(leg.threshold)) return "void";
        const over = got >= leg.threshold;                    // ladder: "N+"
        return (leg.side === "under" ? !over : over) ? "win" : "loss";
      }
      const cats = ["pts", "reb", "ast", "stl", "blk"].filter((k) => p[k] >= 10).length;
      return cats >= (leg.kind === "dd" ? 2 : 3) ? "win" : "loss";
    }
    default: return "pending";
  }
}

/** Settle a bet from its graded legs. Returns {status, profit}. Push/void legs drop out of a parlay. */
export function settleBet(bet) {
  const legs = bet?.legs || [];
  const stake = finite(bet?.stake) && bet.stake > 0 ? bet.stake : 0;
  if (!legs.length) return { status: "push", profit: 0 };
  const r = legs.map((l) => l.result || "pending");
  if (bet.type === "parlay") {
    if (r.includes("loss")) return { status: "loss", profit: -stake };
    if (r.includes("pending")) return { status: "pending", profit: 0 };
    const live = legs.filter((l) => l.result === "win");
    if (!live.length) return { status: "push", profit: 0 };
    const dec = live.reduce((d, l) => d * toDecimal(l.american), 1);
    return finite(dec) ? { status: "win", profit: stake * (dec - 1) } : { status: "pending", profit: 0 };
  }
  const [res] = r;
  if (res === "win") { const d = toDecimal(legs[0].american); return finite(d) ? { status: "win", profit: stake * (d - 1) } : { status: "pending", profit: 0 }; }
  if (res === "loss") return { status: "loss", profit: -stake };
  if (res === "push" || res === "void") return { status: "push", profit: 0 };
  return { status: "pending", profit: 0 };
}

const brier = (legs, key) => { const xs = legs.filter((l) => finite(l[key])); return xs.length ? mean(xs.map((l) => (l[key] - (l.result === "win" ? 1 : 0)) ** 2)) : null; };

/** Summary stats for the tracker, including calibration and a head-to-head of the two algorithms. */
export function trackerStats(bets) {
  const all = (bets || []).filter((b) => b && Array.isArray(b.legs));
  const settled = all.filter((b) => b.status && b.status !== "pending");
  const staked = settled.reduce((s, b) => s + (b.status === "push" || !finite(b.stake) ? 0 : b.stake), 0);
  const profit = settled.reduce((s, b) => s + (finite(b.profit) ? b.profit : 0), 0);
  const legs = all.flatMap((b) => b.legs).filter((l) => l && (l.result === "win" || l.result === "loss"));
  const byKind = {};
  for (const l of legs) {
    const k = l.kind === "prop" ? "Player props" : l.kind === "ml" ? "Moneyline" : l.kind === "spread" ? "Spread" : l.kind === "total" ? "Totals" : l.kind === "win" ? "Match winner" : "Double/Triple-double";
    byKind[k] = byKind[k] || { hits: 0, total: 0 };
    byKind[k].total++; if (l.result === "win") byKind[k].hits++;
  }
  const buckets = [[0, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, 0.85], [0.85, 1.01]].map(([lo, hi]) => {
    const xs = legs.filter((l) => finite(l.pModel) && l.pModel >= lo && l.pModel < hi);
    return { lo, hi, n: xs.length, predicted: xs.length ? mean(xs.map((l) => l.pModel)) : null, actual: xs.length ? xs.filter((l) => l.result === "win").length / xs.length : null };
  });
  const rate = (xs) => (xs.length ? xs.filter((l) => l.result === "win").length / xs.length : null);
  const count = (type, status) => settled.filter((b) => b.type === type && b.status === status).length;
  return {
    wins: settled.filter((b) => b.status === "win").length,
    losses: settled.filter((b) => b.status === "loss").length,
    pushes: settled.filter((b) => b.status === "push").length,
    pending: all.length - settled.length,
    staked, profit, roi: staked ? profit / staked : 0,
    parlay: { wins: count("parlay", "win"), losses: count("parlay", "loss") },
    straight: { wins: count("straight", "win"), losses: count("straight", "loss") },
    legHits: legs.filter((l) => l.result === "win").length, legTotal: legs.length,
    byKind, buckets,
    bySport: legs.reduce((m, l) => { const k = l.sport || "nba"; m[k] = m[k] || { hits: 0, total: 0 }; m[k].total++; if (l.result === "win") m[k].hits++; return m; }, {}),
    // Lower Brier score = sharper forecasts. Compares the two algorithms on the same graded legs.
    algo: { brierA: brier(legs, "pA"), brierB: brier(legs, "pB"), brierFinal: brier(legs, "pModel"), n: legs.filter((l) => finite(l.pA) && finite(l.pB)).length,
      verifiedHit: rate(legs.filter((l) => l.verified)), splitHit: rate(legs.filter((l) => l.verified === false)),
      verifiedN: legs.filter((l) => l.verified).length, splitN: legs.filter((l) => l.verified === false).length },
  };
}
