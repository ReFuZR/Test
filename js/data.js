// ESPN public NBA endpoints (all send Access-Control-Allow-Origin: *) and parsers for them.
// Parsers are pure so they can be tested against saved responses.

const SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba";

export const URLS = {
  scoreboard: (yyyymmdd) => `${SITE}/scoreboard${yyyymmdd ? `?dates=${yyyymmdd}` : ""}`,
  standings: () => "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings",
  injuries: () => `${SITE}/injuries`,
  transactions: () => `${SITE}/transactions?limit=100`,
  roster: (teamId) => `${SITE}/teams/${teamId}/roster`,
  summary: (eventId) => `${SITE}/summary?event=${eventId}`,
  gamelog: (athleteId, season) => `${WEB}/athletes/${athleteId}/gamelog${season ? `?season=${season}` : ""}`,
  props: (eventId) => `${CORE}/events/${eventId}/competitions/${eventId}/odds/100/propBets?limit=1000`,
};

// ---------- fetching with a small cache ----------
const memo = new Map();
export async function getJSON(url, ttlMs = 60_000) {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.t < ttlMs) return hit.data;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN returned ${res.status} for ${url.split("?")[0].split("/").slice(-2).join("/")}`);
  const data = await res.json();
  memo.set(url, { t: Date.now(), data });
  return data;
}

/** Run async jobs with limited parallelism so we don't hammer ESPN. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}

const num = (x) => (x === undefined || x === null || x === "" ? NaN : Number(String(x).replace(/^[ou]/i, "")));
const idFromHref = (links = []) => { for (const l of links) { const m = /\/id\/(\d+)/.exec(l.href || ""); if (m) return m[1]; } return null; };

// ---------- parsers ----------
export function parseScoreboard(json) {
  return (json.events || []).map((e) => {
    const c = e.competitions[0];
    const side = (ha) => {
      const t = c.competitors.find((x) => x.homeAway === ha);
      return {
        id: t.team.id, abbr: t.team.abbreviation, name: t.team.displayName, short: t.team.shortDisplayName || t.team.name,
        logo: t.team.logo, score: num(t.score), record: (t.records || []).find((r) => r.type === "total" || r.name === "overall")?.summary || t.records?.[0]?.summary || "",
        winner: !!t.winner,
      };
    };
    const o = (c.odds || [])[0];
    let odds = null;
    if (o) {
      odds = {
        provider: o.provider?.name || "Sportsbook",
        homeML: num(o.moneyline?.home?.close?.odds), awayML: num(o.moneyline?.away?.close?.odds),
        homeSpread: num(o.pointSpread?.home?.close?.line), homeSpreadOdds: num(o.pointSpread?.home?.close?.odds),
        awaySpread: num(o.pointSpread?.away?.close?.line), awaySpreadOdds: num(o.pointSpread?.away?.close?.odds),
        total: num(o.total?.over?.close?.line ?? o.overUnder), overOdds: num(o.total?.over?.close?.odds), underOdds: num(o.total?.under?.close?.odds),
      };
      if (!Number.isFinite(odds.total)) odds.total = num(o.overUnder);
    }
    return {
      id: e.id, date: e.date, name: e.shortName || e.name,
      state: e.status.type.state, completed: e.status.type.completed, detail: e.status.type.shortDetail || e.status.type.detail,
      home: side("home"), away: side("away"), odds,
    };
  });
}

export function parseStandings(json) {
  const teams = {};
  for (const conf of json.children || []) {
    for (const e of conf.standings?.entries || []) {
      const s = Object.fromEntries(e.stats.map((x) => [x.name || x.type, x]));
      const v = (k) => num(s[k]?.value ?? s[k]?.displayValue);
      teams[e.team.id] = {
        id: e.team.id, abbr: e.team.abbreviation, name: e.team.displayName, conf: conf.abbreviation || conf.name,
        wins: v("wins"), losses: v("losses"), ppg: v("avgPointsFor"), opp: v("avgPointsAgainst"),
        streak: s.streak?.displayValue || "", last10: (e.stats.find((x) => /last ten/i.test(x.name || x.displayName || "") || x.type === "lasttengames") || {}).displayValue || "",
        seed: v("playoffSeed"),
      };
    }
  }
  const list = Object.values(teams).filter((t) => Number.isFinite(t.opp));
  const leagueOpp = list.length ? list.reduce((s, t) => s + t.opp, 0) / list.length : 114;
  return { teams, leagueOpp };
}

export function parseInjuries(json) {
  const byTeam = {};
  for (const t of json.injuries || []) {
    byTeam[t.id] = (t.injuries || []).map((i) => ({
      athleteId: idFromHref(i.athlete?.links), name: i.athlete?.displayName || "", pos: i.athlete?.position?.abbreviation || "",
      status: i.status || i.type?.description || "", comment: i.shortComment || "", detail: i.details ? [i.details.side !== "Not Specified" ? i.details.side : "", i.details.type, i.details.detail].filter(Boolean).join(" ") : "",
      returnDate: i.details?.returnDate || "", date: i.date, team: t.displayName,
    }));
  }
  return byTeam;
}

export function parseTransactions(json) {
  return (json.transactions || []).map((t) => ({
    date: t.date, description: t.description, team: t.team?.displayName || "", abbr: t.team?.abbreviation || "", logo: t.team?.logos?.[0]?.href || "",
    isTrade: /\btrade|acquired\b/i.test(t.description),
  }));
}

export function parseRoster(json) {
  const out = {};
  for (const a of json.athletes || []) {
    out[a.id] = { id: a.id, name: a.displayName, short: a.shortName, pos: a.position?.abbreviation || "", jersey: a.jersey || "", headshot: a.headshot?.href || "", teamId: json.team?.id, injury: a.injuries?.[0]?.status || "" };
  }
  return out;
}

/** Game rows, most recent first: {date, opp, min, pts, reb, ast, tpm, stl, blk}. Preseason excluded. */
export function parseGamelog(json) {
  const names = json.names || [];
  const ix = (n) => names.indexOf(n);
  const I = { min: ix("minutes"), pts: ix("points"), reb: ix("totalRebounds"), ast: ix("assists"), stl: ix("steals"), blk: ix("blocks"), tpm: ix("threePointFieldGoalsMade-threePointFieldGoalsAttempted") };
  const rows = [];
  for (const st of json.seasonTypes || []) {
    if (/preseason/i.test(st.displayName)) continue;
    for (const cat of st.categories || []) {
      if (cat.type !== "event") continue;
      for (const ev of cat.events || []) {
        const meta = json.events?.[ev.eventId] || {};
        const s = ev.stats;
        const g = (k) => num(String(s[I[k]] ?? "").split("-")[0]);
        rows.push({ eventId: ev.eventId, date: meta.gameDate, opp: meta.opponent?.abbreviation || "", atVs: meta.atVs || "", result: meta.gameResult || "",
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

/** Sportsbook player-prop ladders ("N+") plus double/triple-double prices. */
export function parseProps(json) {
  const out = [];
  for (const it of json.items || []) {
    const athleteId = /athletes\/(\d+)/.exec(it.athlete?.$ref || "")?.[1];
    const american = num(it.odds?.american?.value);
    if (!athleteId || !Number.isFinite(american)) continue;
    const name = it.type?.name || "";
    if (PROP_TYPES[name]) {
      const threshold = num(it.current?.target?.value ?? it.odds?.total?.value);
      if (Number.isFinite(threshold)) out.push({ athleteId, kind: "prop", ...PROP_TYPES[name], threshold, american });
    } else if (/double double/i.test(name)) out.push({ athleteId, kind: "dd", label: "Double-double", stats: [], threshold: 1, american });
    else if (/triple double/i.test(name)) out.push({ athleteId, kind: "td", label: "Triple-double", stats: [], threshold: 1, american });
  }
  return out;
}

/** Final result for grading bets. */
export function parseSummary(json) {
  const comp = json.header?.competitions?.[0];
  if (!comp) return null;
  const side = (ha) => { const t = comp.competitors.find((c) => c.homeAway === ha); return { id: t.team?.id || t.id, score: num(t.score) }; };
  const players = {};
  for (const team of json.boxscore?.players || []) {
    for (const st of team.statistics || []) {
      const L = st.labels || [];
      const at = (s, lab) => { const i = L.indexOf(lab); return i < 0 ? NaN : num(String(s[i]).split("-")[0]); };
      for (const a of st.athletes || []) {
        const s = a.stats || [];
        const dnp = a.didNotPlay || !s.length || !(at(s, "MIN") > 0);
        players[a.athlete.id] = { dnp, pts: at(s, "PTS"), reb: at(s, "REB"), ast: at(s, "AST"), tpm: at(s, "3PT"), stl: at(s, "STL"), blk: at(s, "BLK") };
      }
    }
  }
  return { completed: !!comp.status?.type?.completed, detail: comp.status?.type?.shortDetail || "", home: side("home"), away: side("away"), players };
}
