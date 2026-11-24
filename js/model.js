// Pure betting math and prediction model. No network, no DOM, so it can be unit-tested in Node.

export const HOME_COURT = 2.2;   // points of home-court advantage
export const SD_MARGIN = 12.5;   // std dev of NBA final margin vs. expectation
export const SD_TOTAL = 18.5;    // std dev of NBA game total vs. expectation

// ---------- odds helpers ----------
export function toDecimal(american) {
  const a = Number(american);
  if (!Number.isFinite(a) || a === 0) return NaN;
  return a > 0 ? 1 + a / 100 : 1 + 100 / -a;
}

export function toAmerican(decimal) {
  if (!Number.isFinite(decimal) || decimal <= 1) return NaN;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

export const fmtAmerican = (a) => (!Number.isFinite(a) ? "—" : a > 0 ? `+${a}` : `${a}`);
export const impliedProb = (american) => 1 / toDecimal(american);

/** Remove the bookmaker's margin from a two-way market. */
export function noVig(americanA, americanB) {
  const a = impliedProb(americanA), b = impliedProb(americanB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [a, b];
  return [a / (a + b), b / (a + b)];
}

// ---------- distributions ----------
export function normCdf(z) {
  // Abramowitz-Stegun 7.1.26 approximation of erf
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** P(X >= k) for Poisson(lambda). */
export function poissonAtLeast(k, lambda) {
  if (k <= 0) return 1;
  let term = Math.exp(-lambda), cdf = term;
  for (let i = 1; i < k; i++) { term *= lambda / i; cdf += term; }
  return Math.max(0, 1 - cdf);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

// ---------- game model ----------
/** Team strength in points per game vs. average, shrunk toward 0 early in the season. */
export function teamRating(t) {
  const gp = t.wins + t.losses;
  return gp ? (t.ppg - t.opp) * gp / (gp + 8) : 0;
}

/**
 * Projects a game from season scoring and injuries.
 * home/away: {wins, losses, ppg, opp}; injury penalties are points of margin lost.
 */
export function projectGame(home, away, { homeInjury = 0, awayInjury = 0 } = {}) {
  const margin = teamRating(home) - teamRating(away) + HOME_COURT - homeInjury + awayInjury;
  const homePts = (home.ppg + away.opp) / 2 - homeInjury / 2;
  const awayPts = (away.ppg + home.opp) / 2 - awayInjury / 2;
  const total = homePts + awayPts;
  return {
    margin,                               // expected home minus away
    total,
    homePts: total / 2 + margin / 2,
    awayPts: total / 2 - margin / 2,
    pHome: normCdf(margin / SD_MARGIN),
  };
}

/** Probability the side covers. line is that side's spread (e.g. -4.5); marginForSide is expected margin for that side. */
export const pCover = (marginForSide, line) => normCdf((marginForSide + line) / SD_MARGIN);
export const pOver = (projTotal, line) => normCdf((projTotal - line) / SD_TOTAL);

/** Rough margin cost of losing a player, from his scoring and minutes. Capped so one player can't swing a game more than ~6 pts. */
export function injuryImpact({ ppg = 0, rpg = 0, apg = 0, mpg = 0 }) {
  if (mpg < 12) return 0;
  return clamp(0.14 * ppg + 0.06 * rpg + 0.1 * apg - 0.8, 0, 6);
}

/**
 * Blend the stats model with the sportsbook's no-vig probability. The market already prices in
 * things our stats can't see (rest, rotations, late news), so it anchors the estimate and the
 * stats model nudges it. wMarket = weight on the market.
 */
export function blend(pStats, pMarket, wMarket = 0.6) {
  if (!Number.isFinite(pMarket)) return pStats;
  if (!Number.isFinite(pStats)) return pMarket;
  return clamp((1 - wMarket) * pStats + wMarket * pMarket, 0.01, 0.99);
}

/** One-sided prop prices carry ~5% vig; strip it roughly so a ladder rung can be compared fairly. */
export const fairOneSided = (american) => clamp(impliedProb(american) / 1.05, 0.005, 0.99);

// ---------- player props ----------
/**
 * Probability a player records at least `threshold` of a stat.
 * values: stat per game, most recent first. oppFactor scales the mean for matchup (1 = neutral).
 */
export function propProb(values, threshold, oppFactor = 1) {
  const n = values.length;
  if (!n) return null;
  const weights = values.map((_, i) => Math.pow(0.93, i));
  const wSum = weights.reduce((s, w) => s + w, 0);
  const mu = values.reduce((s, v, i) => s + v * weights[i], 0) / wSum * oppFactor;
  const m = mean(values);
  const sd = Math.max(Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1)), Math.sqrt(Math.max(mu, 0.5)) * 0.9, 1);

  // Poisson for low-count stats (3PM, assists for bigs), normal otherwise
  const pDist = mu < 6 ? poissonAtLeast(threshold, Math.max(mu, 0.05)) : 1 - normCdf((threshold - 0.5 - mu) / sd);
  const hit = (xs) => (xs.length ? xs.filter((v) => v >= threshold).length / xs.length : null);
  const hitSeason = hit(values), hitL10 = hit(values.slice(0, 10)), hitL5 = hit(values.slice(0, 5));

  // Empirical rates get more weight the more games we have
  const wEmp = clamp(n / 20, 0, 0.5);
  const emp = 0.5 * hitSeason + 0.5 * hitL10;
  const p = clamp((1 - wEmp) * pDist + wEmp * emp, 0.02, 0.98);
  return { p, mean: mu, sd, n, hitSeason, hitL10, hitL5, confidence: n >= 15 ? "high" : n >= 8 ? "medium" : "low" };
}

/** Double/triple-double probability from game logs: rows of {pts, reb, ast, stl, blk}. */
export function multiDoubleProb(rows, cats = 2) {
  if (!rows.length) return null;
  const isHit = (r) => ["pts", "reb", "ast", "stl", "blk"].filter((k) => r[k] >= 10).length >= cats;
  const k = rows.filter(isHit).length, k10 = rows.slice(0, 10).filter(isHit).length;
  const season = (k + 0.5) / (rows.length + 1), l10 = (k10 + 0.5) / (Math.min(10, rows.length) + 1);
  return { p: clamp(0.6 * season + 0.4 * l10, 0.01, 0.97), n: rows.length, hitSeason: k / rows.length, hitL10: k10 / Math.min(10, rows.length) };
}

// ---------- parlays ----------
export function parlayMath(legs) {
  const dec = legs.reduce((d, l) => d * toDecimal(l.american), 1);
  const pModel = legs.reduce((p, l) => p * l.pModel, 1);
  const pBook = 1 / dec;
  return {
    decimal: dec,
    american: toAmerican(dec),
    pModel,
    pBook,
    ev: pModel * dec - 1,                     // expected profit per $1
    sameGame: new Set(legs.map((l) => l.eventId)).size < legs.length,
  };
}

/** Compare one parlay vs. splitting the same total stake across straight bets. */
export function compareStraightVsParlay(legs, stake = 10) {
  const parlay = parlayMath(legs);
  const each = stake / legs.length;
  const straights = legs.map((l) => {
    const d = toDecimal(l.american);
    return { label: l.label, stake: each, toWin: each * (d - 1), p: l.pModel, ev: each * (l.pModel * d - 1) };
  });
  return {
    parlay: { stake, toWin: stake * (parlay.decimal - 1), p: parlay.pModel, ev: stake * parlay.ev, american: parlay.american },
    straights,
    straightsEv: straights.reduce((s, x) => s + x.ev, 0),
    straightsPAllWin: parlay.pModel,
    straightsPAnyWin: 1 - legs.reduce((q, l) => q * (1 - l.pModel), 1),
  };
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc.slice(); return; }
  for (let i = start; i < arr.length; i++) { acc.push(arr[i]); yield* combos(arr, k, i + 1, acc); acc.pop(); }
}

/**
 * Suggest parlays: for each size, the leg combination with the highest model hit probability
 * that still pays at least `minAmerican`. One leg per player, and one game-line leg per game.
 */
export function suggestParlays(candidates, { sizes = [2, 3, 4], minAmerican = 100, pool = 24, maxSameGame = 2 } = {}) {
  const minDec = toDecimal(minAmerican);
  const top = candidates
    .filter((c) => Number.isFinite(c.pModel) && Number.isFinite(toDecimal(c.american)) && c.pModel > 0.3)
    .sort((a, b) => b.pModel * (1 + Math.max(0, b.pModel - impliedProb(b.american))) - a.pModel * (1 + Math.max(0, a.pModel - impliedProb(a.american))))
    .slice(0, pool);
  const out = [];
  for (const k of sizes) {
    let best = null;
    for (const c of combos(top, k)) {
      const players = c.filter((l) => l.athleteId).map((l) => l.athleteId);
      if (new Set(players).size !== players.length) continue;
      const lines = c.filter((l) => !l.athleteId).map((l) => l.eventId);
      if (new Set(lines).size !== lines.length) continue;
      const perGame = {};
      if (c.some((l) => (perGame[l.eventId] = (perGame[l.eventId] || 0) + 1) > maxSameGame)) continue;
      const m = parlayMath(c);
      if (m.decimal < minDec) continue;
      if (!best || m.pModel > best.math.pModel) best = { legs: c, math: m };
    }
    if (best) out.push(best);
  }
  return out;
}

// ---------- grading ----------
/**
 * Grade one leg against a final result.
 * result: {completed, home:{id,score}, away:{id,score}, players:{[athleteId]: {pts,reb,ast,tpm,stl,blk,dnp}}}
 */
export function gradeLeg(leg, result) {
  if (!result || !result.completed) return "pending";
  const hs = result.home.score, as = result.away.score;
  const forSide = (side) => (side === "home" ? hs - as : as - hs);
  switch (leg.kind) {
    case "ml": return forSide(leg.side) > 0 ? "win" : "loss";
    case "spread": {
      const v = forSide(leg.side) + leg.line;
      return v > 0 ? "win" : v < 0 ? "loss" : "push";
    }
    case "total": {
      const t = hs + as;
      if (t === leg.line) return "push";
      return (leg.side === "over") === (t > leg.line) ? "win" : "loss";
    }
    case "prop": case "dd": case "td": {
      const p = result.players[leg.athleteId];
      if (!p || p.dnp) return "void";
      if (leg.kind === "prop") return leg.stats.reduce((s, k) => s + (p[k] || 0), 0) >= leg.threshold ? "win" : "loss";
      const cats = ["pts", "reb", "ast", "stl", "blk"].filter((k) => p[k] >= 10).length;
      return cats >= (leg.kind === "dd" ? 2 : 3) ? "win" : "loss";
    }
    default: return "pending";
  }
}

/** Settle a bet from its graded legs. Returns {status, profit}. Push/void legs drop out of a parlay. */
export function settleBet(bet) {
  const r = bet.legs.map((l) => l.result || "pending");
  if (bet.type === "parlay") {
    if (r.includes("loss")) return { status: "loss", profit: -bet.stake };
    if (r.includes("pending")) return { status: "pending", profit: 0 };
    const live = bet.legs.filter((l) => l.result === "win");
    if (!live.length) return { status: "push", profit: 0 };
    const dec = live.reduce((d, l) => d * toDecimal(l.american), 1);
    return { status: "win", profit: bet.stake * (dec - 1) };
  }
  const [res] = r, leg = bet.legs[0];
  if (res === "win") return { status: "win", profit: bet.stake * (toDecimal(leg.american) - 1) };
  if (res === "loss") return { status: "loss", profit: -bet.stake };
  if (res === "push" || res === "void") return { status: "push", profit: 0 };
  return { status: "pending", profit: 0 };
}

/** Summary stats for the tracker, including calibration (does a 60% leg hit 60% of the time?). */
export function trackerStats(bets) {
  const settled = bets.filter((b) => b.status && b.status !== "pending");
  const staked = settled.reduce((s, b) => s + (b.status === "push" ? 0 : b.stake), 0);
  const profit = settled.reduce((s, b) => s + (b.profit || 0), 0);
  const legs = bets.flatMap((b) => b.legs).filter((l) => l.result === "win" || l.result === "loss");
  const byKind = {};
  for (const l of legs) {
    const k = l.kind === "prop" ? "Player props" : l.kind === "ml" ? "Moneyline" : l.kind === "spread" ? "Spread" : l.kind === "total" ? "Totals" : "Double/Triple-double";
    byKind[k] = byKind[k] || { hits: 0, total: 0 };
    byKind[k].total++; if (l.result === "win") byKind[k].hits++;
  }
  const buckets = [[0, 0.4], [0.4, 0.55], [0.55, 0.7], [0.7, 0.85], [0.85, 1.01]].map(([lo, hi]) => {
    const xs = legs.filter((l) => l.pModel >= lo && l.pModel < hi);
    return { lo, hi, n: xs.length, predicted: xs.length ? mean(xs.map((l) => l.pModel)) : null, actual: xs.length ? xs.filter((l) => l.result === "win").length / xs.length : null };
  });
  const count = (type, status) => settled.filter((b) => b.type === type && b.status === status).length;
  return {
    wins: settled.filter((b) => b.status === "win").length,
    losses: settled.filter((b) => b.status === "loss").length,
    pushes: settled.filter((b) => b.status === "push").length,
    pending: bets.length - settled.length,
    staked, profit, roi: staked ? profit / staked : 0,
    parlay: { wins: count("parlay", "win"), losses: count("parlay", "loss") },
    straight: { wins: count("straight", "win"), losses: count("straight", "loss") },
    legHits: legs.filter((l) => l.result === "win").length, legTotal: legs.length,
    byKind, buckets,
  };
}
