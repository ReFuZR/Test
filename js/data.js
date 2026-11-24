// ESPN public NBA endpoints (all send Access-Control-Allow-Origin: *) and parsers for them.
// Parsers are pure and defensive: malformed or partial responses yield empty results, never exceptions.

import { parseAmerican } from "./model.js";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";

const enc = encodeURIComponent;
export const URLS = {
  scoreboard: (yyyymmdd) => `${SITE}/scoreboard${yyyymmdd ? `?dates=${enc(yyyymmdd)}` : ""}`,
  standings: () => "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings",
  injuries: () => `${SITE}/injuries`,
  transactions: () => `${SITE}/transactions?limit=100`,
  roster: (teamId) => `${SITE}/teams/${enc(teamId)}/roster`,
  schedule: (teamId) => `${SITE}/teams/${enc(teamId)}/schedule`,
  summary: (eventId) => `${SITE}/summary?event=${enc(eventId)}`,
  gamelog: (athleteId, season) => `${WEB}/athletes/${enc(athleteId)}/gamelog${season ? `?season=${enc(season)}` : ""}`,
  props: (eventId) => `${CORE}/events/${enc(eventId)}/competitions/${enc(eventId)}/odds/100/propBets?limit=1000`,
};

// ---------- fetching ----------
export class FetchError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

const memo = new Map();
/** Fetch JSON with a cache, a timeout and readable errors (offline, timeout, HTTP status, bad JSON). */
export async function getJSON(url, ttlMs = 60_000, { timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
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
    throw new FetchError(e?.name === "AbortError" ? `ESPN took too long to answer (${what}).` : "Can't reach ESPN. Check your connection.", e?.name === "AbortError" ? "timeout" : "network");
  } finally { if (timer) clearTimeout(timer); }
  if (!res.ok) {
    if (hit) return hit.data;
    throw new FetchError(res.status === 404 ? `ESPN has no ${what} for this yet.` : `ESPN returned an error (${res.status}) for ${what}.`, res.status === 404 ? "notfound" : "http");
  }
  let data;
  try { data = await res.json(); } catch { throw new FetchError(`ESPN sent an unreadable ${what} response.`, "parse"); }
  if (data === null || typeof data !== "object") throw new FetchError(`ESPN sent an empty ${what} response.`, "parse");
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

// ---------- parsers ----------
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

export function parseStandings(json) {
  const teams = {};
  for (const conf of arr(json?.children)) {
    for (const e of arr(conf?.standings?.entries)) {
      if (!e?.team?.id) continue;
      const s = Object.fromEntries(arr(e.stats).filter(Boolean).map((x) => [x.name || x.type, x]));
      const v = (k) => num(s[k]?.value ?? s[k]?.displayValue);
      const rec = (k) => { const m = /^(\d+)-(\d+)$/.exec(s[k]?.displayValue || s[k]?.summary || ""); return m ? { w: +m[1], l: +m[2] } : null; };
      teams[e.team.id] = {
        id: String(e.team.id), abbr: e.team.abbreviation || "", name: e.team.displayName || "", conf: conf.abbreviation || conf.name || "",
        wins: v("wins"), losses: v("losses"), ppg: v("avgPointsFor"), opp: v("avgPointsAgainst"),
        streak: s.streak?.displayValue || "", last10: s["Last Ten Games"]?.displayValue || "",
        home: rec("Home"), road: rec("Road"), seed: v("playoffSeed"),
      };
    }
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
    byTeam[t.id] = arr(t.injuries).filter((i) => i?.athlete).map((i) => ({
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

export function parseRoster(json) {
  const out = {};
  const teamId = json?.team?.id ? String(json.team.id) : null;
  for (const a of arr(json?.athletes)) {
    if (!a?.id) continue;
    out[a.id] = { id: String(a.id), name: a.displayName || a.fullName || "Player", short: a.shortName || a.displayName || "Player", pos: a.position?.abbreviation || "",
      jersey: a.jersey || "", headshot: a.headshot?.href || "", teamId, injury: arr(a.injuries)[0]?.status || "" };
  }
  return out;
}

/** Game rows, most recent first: {date, opp, min, pts, reb, ast, tpm, stl, blk}. Preseason and DNPs excluded. */
export function parseGamelog(json) {
  const names = arr(json?.names);
  const ix = (n) => names.indexOf(n);
  const I = { min: ix("minutes"), pts: ix("points"), reb: ix("totalRebounds"), ast: ix("assists"), stl: ix("steals"), blk: ix("blocks"), tpm: ix("threePointFieldGoalsMade-threePointFieldGoalsAttempted") };
  if (I.pts < 0) return [];
  const rows = [];
  for (const st of arr(json?.seasonTypes)) {
    if (/preseason/i.test(st?.displayName || "")) continue;
    for (const cat of arr(st?.categories)) {
      if (cat?.type !== "event") continue;
      for (const ev of arr(cat.events)) {
        if (!ev?.eventId || !Array.isArray(ev.stats)) continue;
        const meta = json.events?.[ev.eventId] || {};
        const g = (k) => (I[k] < 0 ? NaN : num(String(ev.stats[I[k]] ?? "").split("-")[0]));
        rows.push({ eventId: String(ev.eventId), date: meta.gameDate || "", opp: meta.opponent?.abbreviation || "", atVs: meta.atVs || "", result: meta.gameResult || "",
          min: g("min"), pts: g("pts"), reb: g("reb"), ast: g("ast"), stl: g("stl"), blk: g("blk"), tpm: g("tpm") });
      }
    }
  }
  const seen = new Set();
  return rows.filter((r) => !seen.has(r.eventId) && seen.add(r.eventId) && Number.isFinite(r.pts) && r.min > 0)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

export const PROP_TYPES = {
  "Points Milestones": { stats: ["pts"], label: "Points" },
  "Rebounds Milestones": { stats: ["reb"], label: "Rebounds" },
  "Assists Milestones": { stats: ["ast"], label: "Assists" },
  "3-Point Field Goals Milestones": { stats: ["tpm"], label: "3-Pointers" },
  "Points + Rebounds Milestones": { stats: ["pts", "reb"], label: "Pts + Reb" },
  "Points + Assists Milestones": { stats: ["pts", "ast"], label: "Pts + Ast" },
  "Rebounds + Assists Milestones": { stats: ["reb", "ast"], label: "Reb + Ast" },
  "Points + Assists + Rebounds Milestones": { stats: ["pts", "reb", "ast"], label: "PRA" },
};

/** Sportsbook player-prop ladders ("N+") plus double/triple-double prices. Duplicates keep the latest. */
export function parseProps(json) {
  const out = new Map();
  for (const it of arr(json?.items)) {
    const athleteId = /athletes\/(\d+)/.exec(it?.athlete?.$ref || "")?.[1];
    const american = odds(it?.odds?.american?.value);
    if (!athleteId || !Number.isFinite(american)) continue;
    const name = it.type?.name || "";
    let p = null;
    if (PROP_TYPES[name]) {
      const threshold = num(it.current?.target?.value ?? String(it.odds?.total?.value ?? "").replace("+", ""));
      if (Number.isFinite(threshold) && threshold > 0) p = { athleteId, kind: "prop", ...PROP_TYPES[name], threshold, american };
    } else if (/double double/i.test(name)) p = { athleteId, kind: "dd", label: "Double-double", stats: [], threshold: 1, american };
    else if (/triple double/i.test(name)) p = { athleteId, kind: "td", label: "Triple-double", stats: [], threshold: 1, american };
    if (p) out.set(`${p.athleteId}|${p.kind}|${p.stats.join("+")}|${p.threshold}`, p);
  }
  return [...out.values()];
}

/** Final result for grading bets. */
export function parseSummary(json) {
  const comp = json?.header?.competitions?.[0];
  const comps = arr(comp?.competitors);
  const h = comps.find((c) => c?.homeAway === "home"), a = comps.find((c) => c?.homeAway === "away");
  if (!comp || !h || !a) return null;
  const side = (t) => ({ id: String(t.team?.id ?? t.id ?? ""), score: num(t.score) });
  const players = {};
  for (const team of arr(json?.boxscore?.players)) {
    for (const st of arr(team?.statistics)) {
      const L = arr(st?.labels);
      const at = (s, lab) => { const i = L.indexOf(lab); return i < 0 ? NaN : num(String(s[i] ?? "").split("-")[0]); };
      for (const ath of arr(st?.athletes)) {
        if (!ath?.athlete?.id) continue;
        const s = arr(ath.stats);
        const dnp = !!ath.didNotPlay || !s.length || !(at(s, "MIN") > 0);
        players[ath.athlete.id] = { dnp, pts: at(s, "PTS"), reb: at(s, "REB"), ast: at(s, "AST"), tpm: at(s, "3PT"), stl: at(s, "STL"), blk: at(s, "BLK") };
      }
    }
  }
  return { completed: !!comp.status?.type?.completed, detail: comp.status?.type?.shortDetail || "", home: side(h), away: side(a), players };
}
