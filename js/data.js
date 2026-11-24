// Data sources and parsers. ESPN public endpoints (all send Access-Control-Allow-Origin: *) for NBA, NFL,
// MLB and tennis; a same-origin JSON file (built by a scheduled GitHub Action from PandaScore) for esports.
// Parsers are pure and defensive: malformed or partial responses yield empty results, never exceptions.

import { parseAmerican } from "./model.js";
import { SPORTS, marketFor } from "./sports.js";

const NBA = SPORTS.nba;
const enc = encodeURIComponent;
const site = (s) => `https://site.api.espn.com/apis/site/v2/sports/${s.path}`;

/** URL builders. Every builder takes the sport last and defaults to NBA. */
export const URLS = {
  scoreboard: (yyyymmdd, s = NBA) => `${site(s)}/scoreboard${yyyymmdd ? `?dates=${enc(yyyymmdd)}` : ""}`,
  standings: (s = NBA) => `https://site.api.espn.com/apis/v2/sports/${s.path}/standings`,
  injuries: (s = NBA) => `${site(s)}/injuries`,
  transactions: (s = NBA) => `${site(s)}/transactions?limit=100`,
  roster: (teamId, s = NBA) => `${site(s)}/teams/${enc(teamId)}/roster`,
  schedule: (teamId, s = NBA) => `${site(s)}/teams/${enc(teamId)}/schedule`,
  summary: (eventId, s = NBA) => `${site(s)}/summary?event=${enc(eventId)}`,
  gamelog: (athleteId, season, s = NBA) => `https://site.web.api.espn.com/apis/common/v3/sports/${s.path}/athletes/${enc(athleteId)}/gamelog${season ? `?season=${enc(season)}` : ""}`,
  props: (eventId, s = NBA) => {
    const [sport, league] = s.path.split("/");
    return `https://sports.core.api.espn.com/v2/sports/${sport}/leagues/${league}/events/${enc(eventId)}/competitions/${enc(eventId)}/odds/100/propBets?limit=1000`;
  },
  tennisScoreboard: (tour, yyyymmdd) => `https://site.api.espn.com/apis/site/v2/sports/tennis/${enc(tour)}/scoreboard${yyyymmdd ? `?dates=${enc(yyyymmdd)}` : ""}`,
  tennisRankings: (tour) => `https://site.api.espn.com/apis/site/v2/sports/tennis/${enc(tour)}/rankings`,
};

// ---------- fetching ----------
export class FetchError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

const memo = new Map();
/** Fetch JSON with a cache, a timeout and readable errors (offline, timeout, HTTP status, bad JSON). */
export async function getJSON(url, ttlMs = 60_000, { timeoutMs = 15_000, fetchImpl = globalThis.fetch, source = "ESPN" } = {}) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const what = url.split("?")[0].split("/").slice(-1)[0] || "data";
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
  } catch (e) {
    if (hit) return hit.data;                       // serve stale data rather than nothing
    throw new FetchError(e?.name === "AbortError" ? `${source} took too long to answer (${what}).` : `Can't reach ${source}. Check your connection.`, e?.name === "AbortError" ? "timeout" : "network");
  } finally { if (timer) clearTimeout(timer); }
  if (!res.ok) {
    if (hit) return hit.data;
    throw new FetchError(res.status === 404 ? `${source} has no ${what} for this yet.` : `${source} returned an error (${res.status}) for ${what}.`, res.status === 404 ? "notfound" : "http");
  }
  let data;
  try { data = await res.json(); } catch { throw new FetchError(`${source} sent an unreadable ${what} response.`, "parse"); }
  if (data === null || typeof data !== "object") throw new FetchError(`${source} sent an empty ${what} response.`, "parse");
  memo.set(url, { t: Date.now(), data });
  return data;
}
export const clearCache = () => memo.clear();

/** Run async jobs with limited parallelism; a failed job yields null instead of sinking the batch. */
export async function pool(items, limit, fn) {
  const list = items || [];
  const out = new Array(list.length).fill(null);
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(0, Math.min(limit, list.length)) }, async () => {
    while (i < list.length) { const k = i++; try { out[k] = await fn(list[k]); } catch { out[k] = null; } }
  }));
  return out;
}

const num = (x) => {
  if (x === undefined || x === null || x === "") return NaN;
  if (typeof x === "object") return num(x.value ?? x.displayValue);
  return Number(String(x).replace(/^[ou]/i, ""));
};
const odds = (x) => parseAmerican(typeof x === "number" ? x : String(x ?? ""));
const arr = (x) => (Array.isArray(x) ? x : []);
const idFromHref = (links) => { for (const l of arr(links)) { const m = /\/id\/(\d+)/.exec(l?.href || ""); if (m) return m[1]; } return null; };

// ---------- generic stat rows ----------
/**
 * Turn ESPN's parallel (names, values) arrays into {name: number}. Compound names split on the same
 * separator as their values: "hits-atBats" + "1-3", "completions/passingAttempts" + "30/44",
 * "fullInnings.partInnings" + "5.1".
 */
export function statRow(names, values, prefix = "") {
  const row = {};
  arr(names).forEach((name, i) => {
    const v = values?.[i];
    const sep = /^[A-Za-z]+([-/.])[A-Za-z]+/.exec(String(name))?.[1];
    if (sep) {
      const ks = String(name).split(sep), vs = String(v ?? "").split(sep);
      ks.forEach((k, j) => { row[prefix + k] = num(vs[j]); });
    } else row[prefix + name] = num(v);
  });
  return row;
}

/** Add a sport's short aliases (pts, reb...) and derived stats (pitcher outs). */
function finishRow(row, sport) {
  for (const [short, names] of Object.entries(sport.alias || {})) {
    if (row[short] !== undefined) continue;
    const hit = names.find((n) => Number.isFinite(row[n]));
    row[short] = hit ? row[hit] : NaN;
  }
  if (sport.pitcherPrefix) {
    const p = sport.pitcherPrefix;
    if (Number.isFinite(row[`${p}fullInnings`])) row[`${p}outs`] = row[`${p}fullInnings`] * 3 + (row[`${p}partInnings`] || 0);
    else if (Number.isFinite(row[`${p}innings`])) { const w = Math.trunc(row[`${p}innings`]); row[`${p}outs`] = w * 3 + Math.round((row[`${p}innings`] - w) * 10); }
  }
  return row;
}

// ---------- ESPN team sports ----------
export function parseScoreboard(json) {
  const games = [];
  for (const e of arr(json?.events)) {
    const c = e?.competitions?.[0];
    const comps = arr(c?.competitors);
    const raw = { home: comps.find((x) => x?.homeAway === "home"), away: comps.find((x) => x?.homeAway === "away") };
    if (!e?.id || !raw.home?.team || !raw.away?.team) continue;   // skip malformed events
    const side = (t) => ({
      id: String(t.team.id), abbr: t.team.abbreviation || "?", name: t.team.displayName || t.team.abbreviation || "Team",
      short: t.team.shortDisplayName || t.team.name || t.team.abbreviation || "Team",
      logo: t.team.logo || "", color: /^[0-9a-f]{6}$/i.test(t.team.color || "") ? t.team.color : "",
      score: num(t.score), record: arr(t.records).find((r) => r?.type === "total")?.summary || arr(t.records)[0]?.summary || "",
      winner: !!t.winner,
      probable: arr(t.probables)[0]?.athlete?.displayName || "",
    });
    const o = arr(c?.odds)[0];
    let lines = null;
    if (o) {
      lines = {
        provider: o.provider?.name || "Sportsbook",
        homeML: odds(o.moneyline?.home?.close?.odds), awayML: odds(o.moneyline?.away?.close?.odds),
        homeMLOpen: odds(o.moneyline?.home?.open?.odds), awayMLOpen: odds(o.moneyline?.away?.open?.odds),
        homeSpread: num(o.pointSpread?.home?.close?.line), homeSpreadOdds: odds(o.pointSpread?.home?.close?.odds),
        awaySpread: num(o.pointSpread?.away?.close?.line), awaySpreadOdds: odds(o.pointSpread?.away?.close?.odds),
        total: num(o.total?.over?.close?.line), overOdds: odds(o.total?.over?.close?.odds), underOdds: odds(o.total?.under?.close?.odds),
      };
      if (!Number.isFinite(lines.total)) lines.total = num(o.overUnder);
      if (!Number.isFinite(lines.homeSpread) && Number.isFinite(lines.awaySpread)) lines.homeSpread = -lines.awaySpread;
      if (!Number.isFinite(lines.awaySpread) && Number.isFinite(lines.homeSpread)) lines.awaySpread = -lines.homeSpread;
    }
    const st = e.status?.type || {};
    games.push({
      id: String(e.id), date: e.date || "", name: e.shortName || e.name || "",
      state: st.state || "pre", completed: !!st.completed, detail: st.shortDetail || st.detail || "",
      home: side(raw.home), away: side(raw.away), odds: lines,
    });
  }
  return games;
}

/** Standings entries may sit under conferences (NBA/NFL) or leagues and divisions (MLB): walk the tree. */
function standingEntries(node) {
  const own = arr(node?.standings?.entries).map((e) => ({ e, conf: node.abbreviation || node.name || "" }));
  return own.concat(arr(node?.children).flatMap(standingEntries));
}

export function parseStandings(json) {
  const teams = {};
  for (const { e, conf } of standingEntries(json)) {
    if (!e?.team?.id) continue;
    const s = Object.fromEntries(arr(e.stats).filter(Boolean).map((x) => [x.name || x.type, x]));
    const v = (k) => num(s[k]?.value ?? s[k]?.displayValue);
    const rec = (k) => { const m = /^(\d+)-(\d+)/.exec(s[k]?.displayValue || s[k]?.summary || ""); return m ? { w: +m[1], l: +m[2] } : null; };
    const wins = v("wins"), losses = v("losses"), ties = Number.isFinite(v("ties")) ? v("ties") : 0;
    const gp = Number.isFinite(v("gamesPlayed")) ? v("gamesPlayed") : wins + losses + ties;
    // NBA/MLB publish per-game averages; NFL only season totals
    const ppg = Number.isFinite(v("avgPointsFor")) ? v("avgPointsFor") : gp > 0 ? v("pointsFor") / gp : NaN;
    const opp = Number.isFinite(v("avgPointsAgainst")) ? v("avgPointsAgainst") : gp > 0 ? v("pointsAgainst") / gp : NaN;
    teams[e.team.id] = {
      id: String(e.team.id), abbr: e.team.abbreviation || "", name: e.team.displayName || "", conf,
      wins, losses, ties, ppg, opp,
      streak: s.streak?.displayValue || "", last10: s["Last Ten Games"]?.displayValue || "",
      home: rec("Home"), road: rec("Road"), seed: v("playoffSeed"),
    };
  }
  const list = Object.values(teams).filter((t) => Number.isFinite(t.opp));
  const leagueOpp = list.length ? list.reduce((s, t) => s + t.opp, 0) / list.length : 114;
  return { teams, leagueOpp };
}

/** Completed games for one team, most recent first: {eventId, date, home, oppId, pf, pa}. */
export function parseSchedule(json, teamId) {
  const id = String(teamId ?? json?.team?.id ?? "");
  const rows = [];
  for (const e of arr(json?.events)) {
    const c = e?.competitions?.[0];
    if (!c?.status?.type?.completed) continue;
    const me = arr(c.competitors).find((x) => String(x?.team?.id) === id);
    const them = arr(c.competitors).find((x) => x && String(x?.team?.id) !== id);
    if (!me || !them) continue;
    const pf = num(me.score), pa = num(them.score);
    if (!Number.isFinite(pf) || !Number.isFinite(pa)) continue;
    rows.push({ eventId: String(e.id), date: e.date, home: me.homeAway === "home", oppId: String(them.team.id), pf, pa });
  }
  return rows.sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function parseInjuries(json) {
  const byTeam = {};
  for (const t of arr(json?.injuries)) {
    if (!t?.id) continue;
    byTeam[t.id] = arr(t.injuries).filter((i) => i?.athlete && !/^active$/i.test(i.status || "")).map((i) => ({
      athleteId: idFromHref(i.athlete.links), name: i.athlete.displayName || "Unknown player", pos: i.athlete.position?.abbreviation || "",
      status: i.status || i.type?.description || "Unknown", comment: i.shortComment || "",
      detail: i.details ? [i.details.side && i.details.side !== "Not Specified" ? i.details.side : "", i.details.type, i.details.detail].filter(Boolean).join(" ") : "",
      returnDate: i.details?.returnDate || "", date: i.date || "", team: t.displayName || "",
    }));
  }
  return byTeam;
}

export function parseTransactions(json) {
  return arr(json?.transactions).filter((t) => t?.description).map((t) => ({
    date: t.date || "", description: t.description, team: t.team?.displayName || "", abbr: t.team?.abbreviation || "", logo: arr(t.team?.logos)[0]?.href || "",
    isTrade: /\btrade|acquired\b/i.test(t.description),
  })).sort((a, b) => (b.isTrade - a.isTrade) || (new Date(b.date) - new Date(a.date)));
}

/** Rosters come flat (NBA) or grouped by unit/position (NFL, MLB). */
export function parseRoster(json) {
  const out = {};
  const teamId = json?.team?.id ? String(json.team.id) : null;
  const list = arr(json?.athletes).flatMap((a) => (Array.isArray(a?.items) ? a.items : [a]));
  for (const a of list) {
    if (!a?.id) continue;
    out[a.id] = { id: String(a.id), name: a.displayName || a.fullName || "Player", short: a.shortName || a.displayName || "Player", pos: a.position?.abbreviation || "",
      jersey: a.jersey || "", headshot: a.headshot?.href || "", teamId, injury: arr(a.injuries)[0]?.status || "" };
  }
  return out;
}

/**
 * Game rows, most recent first. Each row has every stat ESPN lists (by its own name), the sport's short
 * aliases (NBA: pts, reb, ast, tpm, stl, blk, min) and {eventId, date, opp, atVs, result}.
 * Preseason and games without stats are dropped. MLB pitcher logs get the "p_" prefix.
 */
export function parseGamelog(json, sport = NBA) {
  const names = arr(json?.names);
  if (!names.length) return [];
  const pitcher = sport.pitcherPrefix && names.includes("earnedRuns") && names.includes("innings");
  const prefix = pitcher ? sport.pitcherPrefix : "";
  const rows = [];
  for (const st of arr(json?.seasonTypes)) {
    if (/preseason|spring/i.test(st?.displayName || "")) continue;
    for (const cat of arr(st?.categories)) {
      if (cat?.type !== "event") continue;
      for (const ev of arr(cat.events)) {
        if (!ev?.eventId || !Array.isArray(ev.stats)) continue;
        const meta = json.events?.[ev.eventId] || {};
        const row = finishRow(statRow(names, ev.stats, prefix), sport);
        rows.push({ ...row, eventId: String(ev.eventId), date: meta.gameDate || "", opp: meta.opponent?.abbreviation || "", oppId: meta.opponent?.id ? String(meta.opponent.id) : "", atVs: meta.atVs || "", result: meta.gameResult || "" });
      }
    }
  }
  const seen = new Set();
  const played = (r) => (Number.isFinite(r.min) ? r.min > 0 : Object.entries(r).some(([k, v]) => !["eventId", "date", "opp", "oppId", "atVs", "result"].includes(k) && Number.isFinite(v)));
  // NBA keeps its old rule: a row needs points
  const valid = sport === NBA || sport?.id === "nba" ? (r) => Number.isFinite(r.pts) && r.min > 0 : played;
  return rows.filter((r) => !seen.has(r.eventId) && seen.add(r.eventId) && valid(r))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

const implied = (a) => (a > 0 ? 100 / (a + 100) : -a / (-a + 100));

/**
 * Player props for one sport: ladders ("N+"), over/under lines, threshold "yes" markets (anytime TD) and
 * yes/no specials (double-double). An over at 24.5 is stored as threshold 25; an under as side "under".
 * ESPN doesn't label over/under sides: each pair is listed over first. Checked against ladders on live data,
 * the first item matched the over whenever the two prices differed meaningfully; when they're within 2.5% of
 * each other we can't be sure, so both sides get the lower (safer) payout and a 50/50 fair price.
 */
export function parseProps(json, sport = NBA) {
  const out = new Map();
  const put = (p) => out.set(`${p.athleteId}|${p.kind}|${p.side || "over"}|${p.stats.join("+")}|${p.threshold}`, p);
  const ouPairs = new Map();
  for (const it of arr(json?.items)) {
    const athleteId = /athletes\/(\d+)/.exec(it?.athlete?.$ref || "")?.[1];
    // No odds object at all = the book has posted the line but not priced it yet (seen on NFL days before
    // kickoff): keep it, price unknown. An odds object with a garbage price is bad data: skip it.
    const unpriced = !it?.odds;
    const american = unpriced ? NaN : odds(it?.odds?.american?.value);
    if (!athleteId || (!unpriced && !Number.isFinite(american))) continue;
    const m = marketFor(sport, it.type?.name);
    if (!m) continue;
    const def = { stats: m.stats || [], label: m.label, vol: m.vol };
    if (m.type === "ou") {
      const line = num(it.odds?.total?.value ?? it.current?.target?.value);
      if (!Number.isFinite(line) || line <= 0) continue;
      const k = `${athleteId}|${def.stats.join("+")}|${line}`;
      if (!ouPairs.has(k)) ouPairs.set(k, { athleteId, def, line, prices: [], raw: [] });
      const pair = ouPairs.get(k);
      const sig = JSON.stringify(it);
      // A pair is normally 2 items, which may be identical (-110/-110). Beyond 2, drop exact repeats.
      if (pair.prices.length >= 2 && pair.raw.includes(sig)) continue;
      pair.prices.push(american); pair.raw.push(sig);
    } else if (m.type === "ladder") {
      const threshold = num(it.current?.target?.value ?? String(it.odds?.total?.value ?? "").replace("+", ""));
      const key = `${athleteId}|prop|over|${def.stats.join("+")}|${threshold}`;
      if (Number.isFinite(threshold) && threshold > 0 && !out.has(key)) put({ athleteId, kind: "prop", ...def, threshold, american });
    } else if (m.type === "threshold") {
      put({ athleteId, kind: "prop", ...def, threshold: m.threshold, american });
    } else if (m.type === "yesno") {
      put({ athleteId, kind: m.kind, label: m.label, stats: [], threshold: 1, american });
    }
  }
  for (const { athleteId, def, line, prices } of ouPairs.values()) {
    const priced = prices.filter(Number.isFinite);
    let over, under, fairOver;
    if (!priced.length) { over = under = NaN; fairOver = NaN; }          // line posted, no prices yet: both sides exist
    else if (prices.length !== 2 || priced.length !== 2) continue;      // can't tell sides apart without the pair
    else {
      [over, under] = prices;
      fairOver = implied(over) / (implied(over) + implied(under));
      if (Math.abs(implied(over) - implied(under)) < 0.025) { over = under = Math.min(over, under); fairOver = 0.5; }
    }
    const threshold = Math.floor(line) + 1;                 // over 24.5 = 25 or more; under 24.5 = 24 or fewer
    const base = { athleteId, kind: "prop", ...def, threshold, line };
    put({ ...base, american: over, fair: fairOver });        // over replaces a ladder rung at the same threshold
    put({ ...base, side: "under", american: under, fair: 1 - fairOver });
  }
  return [...out.values()];
}

/** Final result for grading bets. Box-score stats are keyed like game logs, so prop legs grade the same way. */
export function parseSummary(json, sport = NBA) {
  const comp = json?.header?.competitions?.[0];
  const comps = arr(comp?.competitors);
  const h = comps.find((c) => c?.homeAway === "home"), a = comps.find((c) => c?.homeAway === "away");
  if (!comp || !h || !a) return null;
  const side = (t) => ({ id: String(t.team?.id ?? t.id ?? ""), score: num(t.score) });
  const players = {};
  for (const team of arr(json?.boxscore?.players)) {
    for (const st of arr(team?.statistics)) {
      const group = String(st?.name || st?.type || "");
      const prefix = sport.pitcherPrefix && /pitch/i.test(group) ? sport.pitcherPrefix : "";
      // Prefer ESPN's stat keys; fall back to display labels (older NBA payloads)
      const keys = arr(st?.keys).length ? st.keys : arr(st?.labels).map((l) => ({ MIN: "minutes", PTS: "points", REB: "rebounds", AST: "assists", "3PT": "threePointFieldGoalsMade-threePointFieldGoalsAttempted", STL: "steals", BLK: "blocks" }[l] || l));
      for (const ath of arr(st?.athletes)) {
        if (!ath?.athlete?.id) continue;
        const s = arr(ath.stats);
        const row = statRow(keys, s, prefix);
        const prev = players[ath.athlete.id] || { dnp: true };
        const merged = { ...prev, ...Object.fromEntries(Object.entries(row).filter(([, v]) => Number.isFinite(v))) };
        merged.dnp = prev.dnp && (!!ath.didNotPlay || !s.length);
        players[ath.athlete.id] = merged;
      }
    }
  }
  for (const [id, p] of Object.entries(players)) {
    finishRow(p, sport);
    if ("minutes" in p || sport.id === "nba") p.dnp = p.dnp || !(p.minutes > 0 || p.min > 0);
    players[id] = p;
  }
  const statusName = String(comp.status?.type?.name || "");
  return {
    completed: !!comp.status?.type?.completed, detail: comp.status?.type?.shortDetail || "",
    canceled: /POSTPONED|CANCEL|FORFEIT|SUSPENDED/i.test(statusName),   // sportsbooks void these bets
    home: side(h), away: side(a), players,
  };
}

// ---------- tennis ----------
/** Singles matches from an ESPN tennis scoreboard (doubles are skipped: no rankings model for pairs). */
export function parseTennis(json, tour) {
  const out = [];
  for (const e of arr(json?.events)) {
    for (const g of arr(e?.groupings)) {
      if (!/singles/i.test(g?.grouping?.displayName || "")) continue;
      for (const c of arr(g.competitions)) {
        const ps = arr(c?.competitors).filter((x) => x?.athlete && x.id);
        if (!c?.id || ps.length !== 2) continue;
        const st = c.status?.type || {};
        out.push({
          id: String(c.id), tour, date: c.date || c.startDate || "", tournament: e.name || "", event: g.grouping.displayName,
          round: c.round?.displayName || c.notes?.[0]?.text || "",
          state: st.state || "pre", completed: !!st.completed, detail: st.shortDetail || st.detail || "",
          canceled: /POSTPONED|CANCEL|WALKOVER|RETIRED|ABANDON/i.test(st.name || "") && !arr(c.competitors).some((x) => x.winner),
          players: ps.map((x) => ({ id: String(x.id), name: x.athlete.displayName || "Player", short: x.athlete.shortName || x.athlete.displayName || "Player",
            flag: x.athlete.flag?.href || "", winner: !!x.winner, sets: arr(x.linescores).map((l) => num(l.value)).filter(Number.isFinite) })),
          winnerId: String(ps.find((x) => x.winner)?.id ?? ""),
        });
      }
    }
  }
  return out;
}

export function parseRankings(json) {
  const out = {};
  for (const r of arr(arr(json?.rankings)[0]?.ranks)) {
    const id = r?.athlete?.id;
    if (!id) continue;
    out[id] = { rank: num(r.current), points: num(r.points), name: r.athlete.displayName || "" };
  }
  return out;
}

// ---------- esports ----------
/** The esports file the GitHub Action publishes (see scripts/esports.mjs). Validated so a bad file can't crash the app. */
export function parseEsports(json) {
  const teams = json?.teams && typeof json.teams === "object" ? json.teams : {};
  const matches = arr(json?.matches).filter((m) => m && m.id && arr(m.teams).length === 2 && m.teams.every((t) => t && t.id)).map((m) => ({
    id: String(m.id), game: String(m.game || ""), gameName: String(m.gameName || m.game || ""), league: String(m.league || ""), tournament: String(m.tournament || ""),
    date: m.begin_at || m.scheduled_at || "", state: m.status === "running" ? "in" : m.status === "finished" ? "post" : m.status === "canceled" ? "canceled" : "pre",
    completed: m.status === "finished", canceled: m.status === "canceled" || m.forfeit === true && !m.winnerId,
    bestOf: num(m.bestOf), winnerId: m.winnerId ? String(m.winnerId) : "",
    score: arr(m.score).map(num),
    teams: m.teams.map((t) => ({ id: String(t.id), name: String(t.name || "Team"), short: String(t.acronym || t.name || "Team"), logo: typeof t.image === "string" ? t.image : "" })),
  }));
  return { updated: json?.updated || "", games: arr(json?.games), matches, teams };
}
