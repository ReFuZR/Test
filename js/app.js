import * as D from "./data.js";
import * as M from "./model.js";

// ---------------- state & storage ----------------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

const S = {
  tab: "games",
  dayOffset: 0,
  games: [], standings: null, injuries: {}, transactions: [],
  injuryImpact: {},          // teamId -> {total, players:[{name,status,impact}]}
  rosters: {},               // teamId -> {athleteId: info}
  gamelogs: {},              // athleteId -> rows
  propLegs: {},              // eventId -> legs
  propGame: null, propStat: "All", propSort: "likely",
  slip: store.get("cp.slip", []),
  bets: store.get("cp.bets", []),
  stake: store.get("cp.stake", 10),
  risk: "balanced", scope: "both",
  suggestions: null, building: null,
  newsFilter: "today",
  loading: true, error: null,
};

const RISK = { safer: { label: "Safer", min: 100 }, balanced: { label: "Balanced", min: 250 }, long: { label: "Long shot", min: 600 } };

// ---------------- helpers ----------------
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? esc(u) : "");
const pct = (p, d = 0) => (Number.isFinite(p) ? `${(p * 100).toFixed(d)}%` : "—");
const money = (x) => { const r = Math.round(x * 100) / 100; return `${r < 0 ? "-" : ""}$${Math.abs(r).toFixed(2)}`; };
const signed = (x, d = 1) => (x > 0 ? `+${x.toFixed(d)}` : x.toFixed(d));
const fmtLine = (x) => (x > 0 ? `+${x}` : `${x}`);
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const dayDate = () => { const d = new Date(); d.setDate(d.getDate() + S.dayOffset); return d; };
const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const ago = (iso) => { const h = (Date.now() - new Date(iso)) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
const statusClass = (s) => (/out|suspen/i.test(s) ? "out" : /doubt|quest|day-to-day|gtd/i.test(s) ? "q" : "info");
const seasonYear = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() + 1 : d.getFullYear(); };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}
const saveSlip = () => { store.set("cp.slip", S.slip); const c = $("#slipCount"); c.textContent = S.slip.length; c.hidden = !S.slip.length; };
const saveBets = () => store.set("cp.bets", S.bets);
const inSlip = (id) => S.slip.some((l) => l.id === id);

function toggleLeg(leg) {
  if (!leg) return;
  if (inSlip(leg.id)) S.slip = S.slip.filter((l) => l.id !== leg.id);
  else {
    if (leg.kind !== "prop" && leg.kind !== "dd" && leg.kind !== "td") S.slip = S.slip.filter((l) => !(l.eventId === leg.eventId && l.kind === leg.kind));
    S.slip.push(leg); toast(`Added ${leg.label}`);
  }
  saveSlip(); render();
}

// ---------------- data loading ----------------
async function gamelog(athleteId) {
  if (S.gamelogs[athleteId]) return S.gamelogs[athleteId];
  const key = `cp.gl.${athleteId}`, cached = store.get(key, null);
  if (cached && Date.now() - cached.t < 3 * 36e5) return (S.gamelogs[athleteId] = cached.rows);
  let rows = D.parseGamelog(await D.getJSON(D.URLS.gamelog(athleteId), 36e5));
  if (rows.length < 8) {   // early season: lean on last season too
    try { rows = rows.concat(D.parseGamelog(await D.getJSON(D.URLS.gamelog(athleteId, seasonYear() - 1), 864e5)).slice(0, 25)); } catch { /* rookie */ }
  }
  store.set(key, { t: Date.now(), rows: rows.slice(0, 40) });
  return (S.gamelogs[athleteId] = rows);
}

const avg = (rows, k) => (rows.length ? rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length : 0);

async function loadDay() {
  S.loading = true; S.error = null; S.propLegs = {}; S.suggestions = null; render();
  try {
    const [sb, st, inj] = await Promise.all([
      D.getJSON(D.URLS.scoreboard(ymd(dayDate())), 30_000),
      D.getJSON(D.URLS.standings(), 600_000),
      D.getJSON(D.URLS.injuries(), 300_000),
    ]);
    S.games = D.parseScoreboard(sb).sort((a, b) => new Date(a.date) - new Date(b.date));
    S.standings = D.parseStandings(st);
    S.injuries = D.parseInjuries(inj);
    S.propGame = S.games.find((g) => g.state === "pre")?.id || S.games[0]?.id || null;
    S.loading = false; render();
    await computeInjuryImpacts();
    render();
  } catch (e) {
    S.loading = false; S.error = e.message || "Couldn't reach ESPN."; render();
  }
}

/** Estimate how many points of margin each team loses to injuries, scaled by how much the player has actually played. */
async function computeInjuryImpacts() {
  const teamIds = new Set(S.games.flatMap((g) => [g.home.id, g.away.id]));
  const jobs = [];
  for (const id of teamIds) for (const p of S.injuries[id] || []) if (p.athleteId && /out|doubt|quest|day/i.test(p.status)) jobs.push({ teamId: id, p });
  const res = await D.pool(jobs, 6, async ({ teamId, p }) => {
    const all = await gamelog(p.athleteId);
    const seasonStart = new Date(seasonYear() - 1, 8, 1);
    const thisSeason = all.filter((r) => new Date(r.date) >= seasonStart);
    // Averages from recent games (last season if he hasn't played this year); share = how much of this season he's been part of
    const rows = thisSeason.length >= 3 ? thisSeason : all.slice(0, 20);
    const t = S.standings.teams[teamId], gp = t ? t.wins + t.losses : 0;
    // A team's record already reflects games he missed, so only charge for the part of the season he played
    const share = gp ? Math.min(1, thisSeason.length / gp) : 0;
    const weight = /out/i.test(p.status) ? 1 : /doubt/i.test(p.status) ? 0.8 : 0.4;
    const base = M.injuryImpact({ ppg: avg(rows, "pts"), rpg: avg(rows, "reb"), apg: avg(rows, "ast"), mpg: avg(rows, "min") });
    return { teamId, name: p.name, status: p.status, ppg: avg(rows, "pts"), impact: base * share * weight };
  });
  S.injuryImpact = {};
  for (const r of res) {
    if (!r) continue;
    const t = (S.injuryImpact[r.teamId] ||= { total: 0, players: [] });
    t.total += r.impact; t.players.push(r);
  }
}

function projection(g) {
  const T = S.standings?.teams || {};
  const h = T[g.home.id], a = T[g.away.id];
  if (!h || !a || !Number.isFinite(h.ppg)) return null;
  return M.projectGame(h, a, { homeInjury: S.injuryImpact[g.home.id]?.total || 0, awayInjury: S.injuryImpact[g.away.id]?.total || 0 });
}

function gameLegs(g) {
  const o = g.odds, p = projection(g);
  if (!o || !p) return {};
  const base = { eventId: g.id, game: `${g.away.abbr} @ ${g.home.abbr}`, start: g.date };
  const legs = {};
  const [nvH, nvA] = M.noVig(o.homeML, o.awayML);
  if (Number.isFinite(o.homeML)) legs.mlHome = { ...base, id: `${g.id}|ml|home`, kind: "ml", side: "home", teamId: g.home.id, label: `${g.home.abbr} ML`, american: o.homeML, pModel: p.pHome, pBook: nvH };
  if (Number.isFinite(o.awayML)) legs.mlAway = { ...base, id: `${g.id}|ml|away`, kind: "ml", side: "away", teamId: g.away.id, label: `${g.away.abbr} ML`, american: o.awayML, pModel: 1 - p.pHome, pBook: nvA };
  const [nsH, nsA] = M.noVig(o.homeSpreadOdds, o.awaySpreadOdds);
  if (Number.isFinite(o.homeSpread)) legs.spHome = { ...base, id: `${g.id}|spread|home`, kind: "spread", side: "home", line: o.homeSpread, label: `${g.home.abbr} ${fmtLine(o.homeSpread)}`, american: o.homeSpreadOdds, pModel: M.pCover(p.margin, o.homeSpread), pBook: nsH };
  if (Number.isFinite(o.awaySpread)) legs.spAway = { ...base, id: `${g.id}|spread|away`, kind: "spread", side: "away", line: o.awaySpread, label: `${g.away.abbr} ${fmtLine(o.awaySpread)}`, american: o.awaySpreadOdds, pModel: M.pCover(-p.margin, o.awaySpread), pBook: nsA };
  const [nO, nU] = M.noVig(o.overOdds, o.underOdds);
  if (Number.isFinite(o.total)) {
    legs.over = { ...base, id: `${g.id}|total|over`, kind: "total", side: "over", line: o.total, label: `Over ${o.total} ${base.game}`, american: o.overOdds, pModel: M.pOver(p.total, o.total), pBook: nO };
    legs.under = { ...base, id: `${g.id}|total|under`, kind: "total", side: "under", line: o.total, label: `Under ${o.total} ${base.game}`, american: o.underOdds, pModel: 1 - M.pOver(p.total, o.total), pBook: nU };
  }
  for (const k of Object.keys(legs)) {
    const l = legs[k];
    if (!Number.isFinite(l.american)) { delete legs[k]; continue; }
    l.pStats = l.pModel;
    l.pModel = M.blend(l.pStats, l.pBook, 0.6);
  }
  return legs;
}

async function loadProps(eventId, onProgress) {
  if (S.propLegs[eventId]) return S.propLegs[eventId];
  const g = S.games.find((x) => x.id === eventId);
  const [propsJson, rh, ra] = await Promise.all([
    D.getJSON(D.URLS.props(eventId), 120_000),
    S.rosters[g.home.id] ? null : D.getJSON(D.URLS.roster(g.home.id), 36e5),
    S.rosters[g.away.id] ? null : D.getJSON(D.URLS.roster(g.away.id), 36e5),
  ]);
  if (rh) S.rosters[g.home.id] = D.parseRoster(rh);
  if (ra) S.rosters[g.away.id] = D.parseRoster(ra);
  const props = D.parseProps(propsJson);
  const ids = [...new Set(props.map((p) => p.athleteId))];
  let done = 0;
  await D.pool(ids, 6, async (id) => { await gamelog(id); onProgress?.(++done / ids.length); });

  const T = S.standings.teams, league = S.standings.leagueOpp;
  const legs = [];
  for (const pr of props) {
    const info = S.rosters[g.home.id]?.[pr.athleteId] || S.rosters[g.away.id]?.[pr.athleteId];
    const rows = S.gamelogs[pr.athleteId] || [];
    if (!info || !rows.length) continue;
    const oppId = info.teamId === g.home.id ? g.away.id : g.home.id;
    const injury = (S.injuries[info.teamId] || []).find((i) => i.athleteId === pr.athleteId);
    let res;
    if (pr.kind === "prop") {
      const ratio = T[oppId]?.opp ? T[oppId].opp / league : 1;
      const oppFactor = pr.stats.includes("pts") ? 1 + 0.7 * (ratio - 1) : 1;
      res = M.propProb(rows.map((r) => pr.stats.reduce((s, k) => s + (r[k] || 0), 0)), pr.threshold, oppFactor);
    } else res = M.multiDoubleProb(rows, pr.kind === "dd" ? 2 : 3);
    if (!res) continue;
    const statKey = pr.stats.join("+") || pr.kind;
    legs.push({
      id: `${eventId}|${pr.kind}|${pr.athleteId}|${statKey}|${pr.threshold}`, eventId, kind: pr.kind, athleteId: pr.athleteId, teamId: info.teamId,
      stats: pr.stats, threshold: pr.threshold, statLabel: pr.label, american: pr.american,
      label: pr.kind === "prop" ? `${info.short || info.name} ${pr.threshold}+ ${pr.label}` : `${info.short || info.name} ${pr.label}`,
      game: `${g.away.abbr} @ ${g.home.abbr}`, start: g.date,
      pStats: res.p,
      pModel: injury && /out/i.test(injury.status) ? 0 : M.blend(res.p, M.fairOneSided(pr.american), 0.35),
      pBook: M.impliedProb(pr.american),
      detail: { mean: res.mean, n: res.n, hitSeason: res.hitSeason, hitL10: res.hitL10, hitL5: res.hitL5, confidence: res.confidence || (res.n >= 15 ? "high" : "medium") },
      injury: injury?.status || "",
    });
  }
  return (S.propLegs[eventId] = legs);
}

// ---------------- grading ----------------
let grading = false;
async function gradePending({ quiet = true } = {}) {
  if (grading) return;
  const pending = S.bets.filter((b) => b.status === "pending");
  const events = [...new Set(pending.flatMap((b) => b.legs.filter((l) => !l.result || l.result === "pending").map((l) => l.eventId)))];
  if (!events.length) { if (!quiet) toast("Nothing pending to grade"); return; }
  grading = true;
  const results = {};
  await D.pool(events, 4, async (id) => { results[id] = D.parseSummary(await D.getJSON(D.URLS.summary(id), 0)); });
  let changed = 0;
  for (const b of pending) {
    for (const l of b.legs) {
      if (l.result && l.result !== "pending") continue;
      const r = M.gradeLeg(l, results[l.eventId]);
      if (r !== "pending") { l.result = r; changed++; }
      if (results[l.eventId] && l.kind !== "ml" && l.kind !== "spread" && l.kind !== "total") {
        const p = results[l.eventId].players[l.athleteId];
        if (p && !p.dnp) l.actual = l.kind === "prop" ? l.stats.reduce((s, k) => s + (p[k] || 0), 0) : `${p.pts}/${p.reb}/${p.ast}`;
      }
    }
    Object.assign(b, M.settleBet(b));
  }
  grading = false;
  saveBets();
  if (changed || !quiet) toast(changed ? `Graded ${changed} leg${changed > 1 ? "s" : ""}` : "No new results yet");
  if (S.tab === "tracker") render();
}

// ---------------- views ----------------
const view = () => $("#view");

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.tab));
  const d = dayDate();
  $("#dayLabel").textContent = S.dayOffset === 0 ? "Today" : S.dayOffset === 1 ? "Tomorrow" : S.dayOffset === -1 ? "Yesterday" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  saveSlip();
  ({ games: renderGames, props: renderProps, slip: renderSlip, tracker: renderTracker, news: renderNews })[S.tab]();
}

const loadingHtml = (msg, p) => `<div class="loading"><div class="spinner"></div><div>${esc(msg)}</div>${p !== undefined ? `<div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div>` : ""}</div>`;
const errorHtml = () => `<div class="card empty"><strong>No connection to ESPN</strong>${esc(S.error)}<br><br><button class="btn" data-act="reload">Try again</button></div>`;

function pickBtn(leg, line) {
  if (!leg) return `<button class="pick" disabled><span class="od">—</span></button>`;
  const value = leg.pModel - leg.pBook > 0.03;
  return `<button class="pick${inSlip(leg.id) ? " in" : ""}${value ? " value" : ""}" data-leg="${esc(leg.id)}" aria-label="${esc(leg.label)} ${M.fmtAmerican(leg.american)}">
    ${line !== undefined ? `<span class="ln">${esc(line)}</span>` : ""}<span class="od num">${M.fmtAmerican(leg.american)}</span><span class="pm num">${pct(leg.pModel)}</span></button>`;
}

const legIndex = new Map();
function remember(legs) { for (const l of legs) if (l) legIndex.set(l.id, l); }

function injuryLine(team) {
  const list = (S.injuries[team.id] || []).filter((p) => !/active/i.test(p.status));
  if (!list.length) return "";
  const impact = S.injuryImpact[team.id]?.total || 0;
  return `<div class="inj-line"><b>${esc(team.abbr)}</b>${list.slice(0, 6).map((p) => `<span class="tag ${statusClass(p.status)}">${esc(p.name.split(" ").slice(-1)[0])} · ${esc(p.status)}</span>`).join("")}${list.length > 6 ? `<span class="muted">+${list.length - 6}</span>` : ""}${impact >= 0.5 ? `<span class="muted small">≈ −${impact.toFixed(1)} pts</span>` : ""}</div>`;
}

function renderGames() {
  if (S.loading) return (view().innerHTML = loadingHtml("Loading games, odds and injuries…"));
  if (S.error) return (view().innerHTML = errorHtml());
  if (!S.games.length) return (view().innerHTML = `<div class="card empty"><strong>No games</strong>No NBA games on this date. Try the arrows up top.</div>`);
  const html = S.games.map((g) => {
    const legs = gameLegs(g), p = projection(g);
    remember(Object.values(legs));
    const live = g.state === "in", post = g.state === "post";
    const team = (t, other) => `<div class="team${post && !t.winner ? " lost" : ""}"><img src="${safeUrl(t.logo)}" alt="" loading="lazy"><div class="nm">${esc(t.short)}<span class="rec">${esc(t.record)}</span></div><div class="sc num">${g.state === "pre" ? "" : esc(t.score)}</div></div>`;
    const markets = g.odds && g.state === "pre" ? `
      <div class="markets">
        <div></div><div class="hd">Money</div><div class="hd">Spread</div><div class="hd">Total</div>
        <div class="tm">${esc(g.away.abbr)}</div>${pickBtn(legs.mlAway)}${pickBtn(legs.spAway, legs.spAway && fmtLine(legs.spAway.line))}${pickBtn(legs.over, legs.over && `O ${legs.over.line}`)}
        <div class="tm">${esc(g.home.abbr)}</div>${pickBtn(legs.mlHome)}${pickBtn(legs.spHome, legs.spHome && fmtLine(legs.spHome.line))}${pickBtn(legs.under, legs.under && `U ${legs.under.line}`)}
      </div>` : "";
    const projHtml = p ? `<div class="proj">Model: <b>${esc(g.away.abbr)} ${p.awayPts.toFixed(0)} – ${esc(g.home.abbr)} ${p.homePts.toFixed(0)}</b> · ${esc(p.margin >= 0 ? g.home.abbr : g.away.abbr)} by ${Math.abs(p.margin).toFixed(1)} · total ${p.total.toFixed(1)}${g.odds?.provider ? ` · lines: ${esc(g.odds.provider)}` : ""}</div>` : "";
    const inj = [injuryLine(g.away), injuryLine(g.home)].join("");
    return `<article class="card game">
      <div class="row between"><span class="status${live ? " live" : ""}">${live ? "● " : ""}${esc(g.state === "pre" ? timeOf(g.date) : g.detail)}</span>
        ${g.state === "pre" ? `<button class="link-btn" data-props="${esc(g.id)}">Player props ›</button>` : ""}</div>
      <div class="teams" style="margin-top:8px">${team(g.away)}${team(g.home)}</div>
      ${markets}${projHtml}${inj ? `<div class="inj">${inj}</div>` : ""}
    </article>`;
  }).join("");
  view().innerHTML = `<p class="small muted" style="margin:0">Tap a price to add it to your slip. Teal % = model's chance it hits (stats blended with the market). ▲ = model rates it higher than the book.</p>${html}<p class="disclaimer">For entertainment. 21+. Gambling problem? Call 1-800-GAMBLER.</p>`;
}

async function renderProps() {
  if (S.loading) return (view().innerHTML = loadingHtml("Loading games…"));
  if (S.error) return (view().innerHTML = errorHtml());
  const upcoming = S.games.filter((g) => g.state === "pre");
  if (!upcoming.length) return (view().innerHTML = `<div class="card empty"><strong>No props right now</strong>Props show for games that haven't started. Try tomorrow with the arrows up top.</div>`);
  if (!upcoming.some((g) => g.id === S.propGame)) S.propGame = upcoming[0].id;
  const chips = `<div class="chips">${upcoming.map((g) => `<button class="chip${g.id === S.propGame ? " on" : ""}" data-pgame="${esc(g.id)}">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</button>`).join("")}</div>`;
  const id = S.propGame;
  if (!S.propLegs[id]) {
    view().innerHTML = chips + loadingHtml("Pulling prop lines and player game logs…", 0);
    try {
      await loadProps(id, (p) => { const b = $(".bar i"); if (b && S.propGame === id) b.style.width = `${Math.round(p * 100)}%`; });
    } catch (e) {
      if (S.tab === "props" && S.propGame === id) view().innerHTML = chips + `<div class="card empty"><strong>Props unavailable</strong>${esc(e.message)}</div>`;
      return;
    }
    if (S.tab !== "props" || S.propGame !== id) return;
  }
  const all = S.propLegs[id];
  remember(all);
  if (!all.length) return (view().innerHTML = chips + `<div class="card empty"><strong>No props posted yet</strong>The book hasn't posted player props for this game. Check back closer to tip-off.</div>`);
  const statNames = ["All", ...new Set(all.map((l) => l.statLabel))];
  let legs = S.propStat === "All" ? all : all.filter((l) => l.statLabel === S.propStat);
  legs = legs.filter((l) => l.pModel > 0 && l.american >= -600 && M.toDecimal(l.american) < 30);   // skip near-locks

  const byPlayer = new Map();
  for (const l of legs) { if (!byPlayer.has(l.athleteId)) byPlayer.set(l.athleteId, []); byPlayer.get(l.athleteId).push(l); }
  const score = (l) => (S.propSort === "likely" ? l.pModel : l.pModel - l.pBook);
  const players = [...byPlayer.entries()].map(([aid, ls]) => ({ aid, ls: ls.sort((a, b) => score(b) - score(a)).slice(0, S.propStat === "All" ? 4 : 6), best: Math.max(...ls.map(score)) }))
    .sort((a, b) => b.best - a.best);
  const g = S.games.find((x) => x.id === id);

  const cards = players.map(({ aid, ls }) => {
    const info = S.rosters[g.home.id]?.[aid] || S.rosters[g.away.id]?.[aid];
    const rows = S.gamelogs[aid] || [];
    const teamAbbr = info.teamId === g.home.id ? g.home.abbr : g.away.abbr;
    const inj = ls[0].injury;
    const l10 = rows.slice(0, 10).reverse();
    const firstProp = ls.find((l) => l.kind === "prop");
    const vals = firstProp ? l10.map((r) => firstProp.stats.reduce((s, k) => s + (r[k] || 0), 0)) : [];
    const maxV = Math.max(1, ...vals);
    const spark = firstProp ? `<div class="row small muted"><div class="spark" title="Last 10 games: ${esc(firstProp.statLabel)}">${vals.map((v) => `<i class="${v >= firstProp.threshold ? "hit" : ""}" style="height:${Math.max(8, (v / maxV) * 100)}%"></i>`).join("")}</div>last ${vals.length} · ${esc(firstProp.statLabel)} vs ${firstProp.threshold}</div>` : "";
    const teammatesOut = (S.injuries[info.teamId] || []).filter((p) => /out/i.test(p.status) && p.athleteId !== aid).map((p) => p.name.split(" ").slice(-1)[0]);
    return `<article class="card player">
      <div class="player-hd"><img src="${safeUrl(info.headshot)}" alt="" loading="lazy">
        <div style="min-width:0"><div class="nm">${esc(info.name)} <span class="muted small">${esc(teamAbbr)} · ${esc(info.pos)}</span> ${inj ? `<span class="tag ${statusClass(inj)}">${esc(inj)}</span>` : ""}</div>
        <div class="avgs"><span><b>${avg(rows.slice(0, 10), "pts").toFixed(1)}</b> pts</span><span><b>${avg(rows.slice(0, 10), "reb").toFixed(1)}</b> reb</span><span><b>${avg(rows.slice(0, 10), "ast").toFixed(1)}</b> ast</span><span><b>${avg(rows.slice(0, 10), "tpm").toFixed(1)}</b> 3pm</span><span>L10 · ${avg(rows.slice(0, 10), "min").toFixed(0)} min</span></div></div></div>
      ${spark}
      ${teammatesOut.length ? `<div class="small muted">Teammates out: ${esc(teammatesOut.join(", "))}</div>` : ""}
      <div class="rungs">${ls.map((l) => `
        <div class="rung"><div class="what"><b>${l.kind === "prop" ? `${l.threshold}+ ${esc(l.statLabel)}` : esc(l.statLabel)}</b>
          <div class="small muted">${l.detail.hitL10 !== null && l.detail.hitL10 !== undefined ? `L10 ${pct(l.detail.hitL10)} · season ${pct(l.detail.hitSeason)}` : ""}${l.detail.mean ? ` · proj ${l.detail.mean.toFixed(1)}` : ""}${l.detail.confidence === "low" ? " · small sample" : ""}</div></div>
          <div class="od num">${M.fmtAmerican(l.american)}</div>
          <div class="pm num"><b>${pct(l.pModel)}</b><span class="small muted">book ${pct(l.pBook)}</span></div>
          <button class="add${inSlip(l.id) ? " in" : ""}" data-leg="${esc(l.id)}" aria-label="Add ${esc(l.label)}">${inSlip(l.id) ? "✓" : "+"}</button></div>`).join("")}</div>
    </article>`;
  }).join("");

  view().innerHTML = `${chips}
    <div class="row between wrap">
      <select id="propStat" aria-label="Stat">${statNames.map((s) => `<option${s === S.propStat ? " selected" : ""}>${esc(s)}</option>`).join("")}</select>
      <div class="chips"><button class="chip${S.propSort === "likely" ? " on" : ""}" data-sort="likely">Most likely</button><button class="chip${S.propSort === "value" ? " on" : ""}" data-sort="value">Best vs. book</button></div>
    </div>
    ${cards || `<div class="card empty"><strong>Nothing matches</strong>Try another stat.</div>`}
    <p class="disclaimer">Lines: DraftKings via ESPN. Model %: recency-weighted game logs and opponent defense, blended with the book price.</p>`;
}

function renderSlip() {
  const legs = S.slip;
  const builder = `<section class="card" style="display:grid;gap:10px">
    <div class="row between"><b style="font:600 18px var(--display);text-transform:uppercase">Auto-parlay</b><span class="small muted">picks the most likely combos</span></div>
    <div class="chips">${Object.entries(RISK).map(([k, r]) => `<button class="chip${S.risk === k ? " on" : ""}" data-risk="${k}">${r.label} · ${M.fmtAmerican(r.min)}+</button>`).join("")}</div>
    <div class="chips">${[["both", "Lines + props"], ["props", "Props only"], ["lines", "Game lines only"]].map(([k, t]) => `<button class="chip${S.scope === k ? " on" : ""}" data-scope="${k}">${t}</button>`).join("")}</div>
    <button class="btn primary" data-act="build" ${S.building !== null ? "disabled" : ""}>${S.building !== null ? `Scanning games… ${Math.round(S.building * 100)}%` : "Build parlays for today's slate"}</button>
    ${S.suggestions ? (S.suggestions.length ? S.suggestions.map((s, i) => `
      <div class="sugg card" style="background:var(--surface-2)">
        <div class="hd"><span><b>${s.legs.length}-leg</b> <span class="muted small">${s.math.sameGame ? "includes same-game legs" : ""}</span></span><span class="big num">${M.fmtAmerican(s.math.american)}</span></div>
        ${s.legs.map((l) => `<div class="row between small"><span>${esc(l.label)} <span class="muted">${esc(l.game)}</span></span><span class="num">${M.fmtAmerican(l.american)} · <span style="color:var(--model)">${pct(l.pModel)}</span></span></div>`).join("")}
        <div class="row between small"><span>Model hit chance <b style="color:var(--model)">${pct(s.math.pModel, 1)}</b> · book ${pct(s.math.pBook, 1)}</span><button class="btn" data-use="${i}">Use</button></div>
      </div>`).join("") : `<div class="small muted">No combo reached that payout. Try a lower risk level or wait for more lines to post.</div>`) : ""}
  </section>`;

  if (!legs.length) {
    view().innerHTML = `<div class="card empty"><strong>Your slip is empty</strong>Tap prices on Games or + on Props, or let Auto-parlay build one.</div>${builder}`;
    return;
  }
  const cmp = M.compareStraightVsParlay(legs, S.stake);
  const math = M.parlayMath(legs);
  const warn = [];
  if (math.sameGame) warn.push("Same-game legs are often correlated, so true odds differ from the multiplied price. Books usually price same-game parlays differently.");
  if (legs.some((l) => l.detail?.confidence === "low")) warn.push("Some legs rest on few games, so treat those percentages loosely.");
  if (legs.some((l) => l.start && new Date(l.start) < new Date())) warn.push("A game in this slip has already started.");
  const evCls = (x) => (x >= 0 ? "pos" : "neg");

  view().innerHTML = `
    <section class="card">
      <div class="row between"><b style="font:600 18px var(--display);text-transform:uppercase">Slip · ${legs.length} leg${legs.length > 1 ? "s" : ""}</b><button class="link-btn" data-act="clear">Clear</button></div>
      <div style="margin-top:6px">${legs.map((l, i) => `
        <div class="leg"><div style="min-width:0"><div>${esc(l.label)}</div><div class="small muted">${esc(l.game || "")} · model <span style="color:var(--model)">${pct(l.pModel)}</span></div></div>
          <input type="number" inputmode="numeric" id="odds-${i}" data-odds="${i}" value="${l.american}" aria-label="Odds for ${esc(l.label)}">
          <button class="x" data-remove="${i}" aria-label="Remove">×</button></div>`).join("")}</div>
      <div class="small muted">Edit odds to match your sportsbook's price.</div>
    </section>

    <section class="card" style="display:grid;gap:10px">
      <div class="row between"><label for="stake"><b>Total stake</b></label><input type="number" id="stake" inputmode="decimal" min="1" value="${S.stake}" style="width:100px;text-align:right"></div>
      <div style="overflow-x:auto"><table class="compare num">
        <thead><tr><th></th><th>Pays</th><th>Hit chance</th><th>Exp. value</th></tr></thead>
        <tbody>
          <tr><td><b>Parlay</b> ${M.fmtAmerican(math.american)}</td><td>${money(cmp.parlay.toWin)}</td><td style="color:var(--model)">${pct(cmp.parlay.p, 1)}</td><td class="${evCls(cmp.parlay.ev)}">${money(cmp.parlay.ev)}</td></tr>
          ${legs.length > 1 ? `<tr><td><b>Straights</b> ${money(S.stake / legs.length)} each</td><td>${money(cmp.straights.reduce((s, x) => s + x.toWin, 0))} max</td><td style="color:var(--model)">${pct(cmp.straightsPAnyWin, 0)} ≥1 wins</td><td class="${evCls(cmp.straightsEv)}">${money(cmp.straightsEv)}</td></tr>` : ""}
        </tbody></table></div>
      <div class="small muted">Book's implied chance for the parlay: ${pct(math.pBook, 1)}. Expected value is the model's average profit per bet over many tries; it's an estimate, not a promise.</div>
      ${warn.map((w) => `<div class="note">${esc(w)}</div>`).join("")}
      <div class="row wrap">
        ${legs.length > 1 ? `<button class="btn primary" data-save="parlay" style="flex:1">Track as parlay</button><button class="btn" data-save="straight" style="flex:1">Track as straights</button>` : `<button class="btn primary" data-save="straight" style="flex:1">Track this bet</button>`}
      </div>
      <div class="small muted">Place the bet at your sportsbook, then track it here. Results grade automatically when games end.</div>
    </section>
    ${builder}`;
}

async function buildSuggestions() {
  S.building = 0; S.suggestions = null; render();
  const upcoming = S.games.filter((g) => g.state === "pre");
  let cands = [];
  if (S.scope !== "props") for (const g of upcoming) cands.push(...Object.values(gameLegs(g)));
  if (S.scope !== "lines") {
    let done = 0;
    for (const g of upcoming) {
      try { cands.push(...(await loadProps(g.id))); } catch { /* skip game without props */ }
      S.building = ++done / upcoming.length; if (S.tab === "slip") render();
    }
  }
  cands = cands.filter((l) => l.pModel > 0 && !(l.injury && /out|doubt/i.test(l.injury)) && l.american >= -500 && M.toDecimal(l.american) < 6);
  remember(cands);
  S.suggestions = M.suggestParlays(cands, { minAmerican: RISK[S.risk].min, sizes: S.risk === "safer" ? [2, 3] : S.risk === "balanced" ? [2, 3, 4] : [3, 4, 5] });
  S.building = null;
  if (S.tab === "slip") render();
}

function renderTracker() {
  const st = M.trackerStats(S.bets);
  const tiles = `<div class="tiles">
    <div class="tile"><div class="k">Record</div><div class="v num">${st.wins}-${st.losses}${st.pushes ? `-${st.pushes}` : ""}</div><div class="small muted">${st.pending} pending</div></div>
    <div class="tile"><div class="k">Profit</div><div class="v num ${st.profit >= 0 ? "pos" : "neg"}">${money(st.profit)}</div><div class="small muted">on ${money(st.staked)}</div></div>
    <div class="tile"><div class="k">ROI</div><div class="v num ${st.roi >= 0 ? "pos" : "neg"}">${signed(st.roi * 100)}%</div><div class="small muted">return per $ bet</div></div>
    <div class="tile"><div class="k">Legs hit</div><div class="v num">${st.legTotal ? pct(st.legHits / st.legTotal) : "—"}</div><div class="small muted">${st.legHits}/${st.legTotal} legs</div></div>
  </div>`;
  const split = `<section class="card" style="display:grid;gap:8px">
    <div class="section-title" style="margin:0">Parlays vs straights</div>
    <div class="row between"><span>Parlays</span><b class="num">${st.parlay.wins}-${st.parlay.losses}</b></div>
    <div class="row between"><span>Straight bets</span><b class="num">${st.straight.wins}-${st.straight.losses}</b></div>
    ${Object.keys(st.byKind).length ? `<div class="section-title">Hit rate by bet type</div>${Object.entries(st.byKind).map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="track"><i style="width:${(v.hits / v.total) * 100}%"></i></div><span class="num small">${v.hits}/${v.total}</span></div>`).join("")}` : ""}
    ${st.buckets.some((b) => b.n) ? `<div class="section-title">Is the model honest?</div><div class="small muted">Legs grouped by the model's predicted chance, next to how often they actually hit.</div>
      <table class="compare num"><thead><tr><th>Model said</th><th>Legs</th><th>Actually hit</th></tr></thead><tbody>
      ${st.buckets.filter((b) => b.n).map((b) => `<tr><td>${pct(b.lo)}–${pct(Math.min(1, b.hi))}</td><td>${b.n}</td><td>${pct(b.actual)} <span class="muted">(avg pred ${pct(b.predicted)})</span></td></tr>`).join("")}</tbody></table>` : ""}
  </section>`;
  const list = S.bets.slice().sort((a, b) => b.created - a.created).map((b) => `
    <article class="card bet">
      <div class="row between"><span><b>${b.type === "parlay" ? `${b.legs.length}-leg parlay` : "Straight"}</b> <span class="muted small">${new Date(b.created).toLocaleDateString([], { month: "short", day: "numeric" })}</span></span><span class="pill ${esc(b.status)}">${esc(b.status)}</span></div>
      <div class="legs">${b.legs.map((l) => `<div><span class="dot ${esc(l.result || "")}"></span>${esc(l.label)} <span class="muted num">${M.fmtAmerican(l.american)}${l.actual !== undefined ? ` · got ${esc(l.actual)}` : ""}${l.result === "void" ? " · DNP, void" : ""}</span></div>`).join("")}</div>
      <div class="row between small"><span class="muted">Stake ${money(b.stake)} · model ${pct(b.type === "parlay" ? b.legs.reduce((p, l) => p * l.pModel, 1) : b.legs[0].pModel)}</span><span class="num ${b.profit > 0 ? "pos" : b.profit < 0 ? "neg" : ""}">${b.status === "pending" ? `to win ${money(b.toWin)}` : money(b.profit)}</span></div>
      <div class="row" style="justify-content:flex-end"><button class="link-btn small" data-del="${esc(b.id)}">${S.confirmDel === b.id ? "Tap again to delete" : "Delete"}</button></div>
    </article>`).join("");
  view().innerHTML = `${tiles}
    <div class="row wrap"><button class="btn" data-act="grade" style="flex:1">Check results now</button><button class="btn ghost" data-act="export">Back up</button><label class="btn ghost" for="importFile">Restore</label><input type="file" id="importFile" accept="application/json" hidden></div>
    ${S.bets.length ? split + list : `<div class="card empty"><strong>No bets tracked yet</strong>Save a slip and its legs grade themselves from ESPN box scores when the games end.</div>`}
    <p class="disclaimer">Saved on this phone only. Use Back up to keep a copy.</p>`;
}

async function renderNews() {
  if (!S.transactions.length) {
    view().innerHTML = loadingHtml("Loading injuries and trades…");
    try { S.transactions = D.parseTransactions(await D.getJSON(D.URLS.transactions(), 600_000)); } catch (e) { S.transactions = []; }
    if (S.tab !== "news") return;
  }
  const playing = new Set(S.games.flatMap((g) => [g.home.id, g.away.id]));
  const teams = Object.entries(S.injuries).filter(([id]) => S.newsFilter === "all" || playing.has(id));
  const T = S.standings?.teams || {};
  const injHtml = teams.filter(([, l]) => l.length).map(([id, list]) => `
    <section class="card"><div class="row between"><b style="font:600 17px var(--display);text-transform:uppercase">${esc(list[0].team)}</b><span class="small muted">${T[id] ? `${T[id].wins}-${T[id].losses}` : ""}</span></div>
      ${list.map((p) => `<div class="news-item" style="grid-template-columns:1fr"><div><div class="row wrap"><b>${esc(p.name)}</b><span class="muted small">${esc(p.pos)}</span><span class="tag ${statusClass(p.status)}">${esc(p.status)}</span>${p.detail ? `<span class="small muted">${esc(p.detail)}</span>` : ""}</div>
        <div class="small muted">${esc(p.comment)}${p.returnDate ? ` Est. return ${esc(new Date(p.returnDate).toLocaleDateString([], { month: "short", day: "numeric" }))}.` : ""} · ${esc(ago(p.date))}</div></div></div>`).join("")}
    </section>`).join("");
  const trades = S.transactions.filter((t) => t.isTrade);
  const txItem = (t) => `<div class="news-item"><img src="${safeUrl(t.logo)}" alt="" loading="lazy"><div><div>${t.isTrade ? '<span class="tag q">Trade</span> ' : ""}${esc(t.description)}</div><div class="small muted">${esc(t.team)} · ${esc(new Date(t.date).toLocaleDateString([], { month: "short", day: "numeric" }))}</div></div></div>`;
  view().innerHTML = `
    <div class="chips"><button class="chip${S.newsFilter === "today" ? " on" : ""}" data-news="today">Teams on this slate</button><button class="chip${S.newsFilter === "all" ? " on" : ""}" data-news="all">All teams</button></div>
    <div class="section-title">Injury report</div>
    ${injHtml || `<div class="card empty"><strong>All clear</strong>No injuries listed for these teams.</div>`}
    <div class="section-title">Trades & roster moves</div>
    <section class="card">${trades.length ? trades.slice(0, 15).map(txItem).join("") : `<div class="small muted">No trades in ESPN's latest transactions.</div>`}
      ${S.transactions.filter((t) => !t.isTrade).slice(0, 20).map(txItem).join("")}</section>`;
}

// ---------------- actions ----------------
function saveBet(type) {
  const stake = Number(S.stake) || 0;
  if (stake <= 0) return toast("Enter a stake first");
  const strip = (l) => ({ id: l.id, eventId: l.eventId, kind: l.kind, side: l.side, line: l.line, athleteId: l.athleteId, stats: l.stats, threshold: l.threshold, label: l.label, game: l.game, american: Number(l.american), pModel: l.pModel, result: "pending" });
  const now = Date.now();
  if (type === "parlay") {
    const m = M.parlayMath(S.slip);
    S.bets.push({ id: `b${now}`, created: now, type, stake, toWin: stake * (m.decimal - 1), legs: S.slip.map(strip), status: "pending", profit: 0 });
  } else {
    const each = stake / S.slip.length;
    S.slip.forEach((l, i) => S.bets.push({ id: `b${now}-${i}`, created: now, type: "straight", stake: each, toWin: each * (M.toDecimal(l.american) - 1), legs: [strip(l)], status: "pending", profit: 0 }));
  }
  saveBets(); S.slip = []; saveSlip();
  toast(type === "parlay" ? "Parlay tracked" : "Bets tracked");
  S.tab = "tracker"; render();
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-tab]");
  if (!t) return;
  const d = t.dataset;
  if (d.tab) { S.tab = d.tab; S.confirmDel = null; window.scrollTo(0, 0); render(); if (d.tab === "tracker") gradePending(); return; }
  if (d.leg) return toggleLeg(legIndex.get(d.leg));
  if (d.props) { S.propGame = d.props; S.tab = "props"; window.scrollTo(0, 0); return render(); }
  if (d.pgame) { S.propGame = d.pgame; return render(); }
  if (d.sort) { S.propSort = d.sort; return render(); }
  if (d.risk) { S.risk = d.risk; S.suggestions = null; return render(); }
  if (d.scope) { S.scope = d.scope; S.suggestions = null; return render(); }
  if (d.news) { S.newsFilter = d.news; return render(); }
  if (d.remove) { S.slip.splice(Number(d.remove), 1); return render(); }
  if (d.save) return saveBet(d.save);
  if (d.use) { const s = S.suggestions[Number(d.use)]; S.slip = s.legs.slice(); toast("Parlay loaded into slip"); window.scrollTo(0, 0); return render(); }
  if (d.del) {
    if (S.confirmDel !== d.del) { S.confirmDel = d.del; return render(); }
    S.bets = S.bets.filter((b) => b.id !== d.del); S.confirmDel = null; saveBets(); return render();
  }
  switch (d.act) {
    case "reload": return loadDay();
    case "clear": S.slip = []; return render();
    case "build": return buildSuggestions();
    case "grade": return gradePending({ quiet: false });
    case "export": {
      const text = JSON.stringify({ app: "courtside-parlays", v: 1, bets: S.bets }, null, 1);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = `parlay-tracker-${ymd(new Date())}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return;
    }
  }
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "propStat") { S.propStat = t.value; render(); }
  if (t.id === "stake") { S.stake = Math.max(0, Number(t.value) || 0); store.set("cp.stake", S.stake); render(); }
  if (t.dataset.odds !== undefined) {
    const v = Number(t.value), l = S.slip[Number(t.dataset.odds)];
    if (Number.isFinite(M.toDecimal(v)) && Math.abs(v) >= 100) { l.american = v; l.pBook = M.impliedProb(v); } else toast("Odds look like -110 or +150");
    render();
  }
  if (t.id === "importFile" && t.files[0]) {
    t.files[0].text().then((txt) => {
      const data = JSON.parse(txt);
      if (!Array.isArray(data.bets)) throw new Error();
      const have = new Set(S.bets.map((b) => b.id));
      const added = data.bets.filter((b) => !have.has(b.id));
      S.bets.push(...added); saveBets(); toast(`Restored ${added.length} bets`); render();
    }).catch(() => toast("That file isn't a tracker backup"));
  }
});

$("#prevDay").onclick = () => { S.dayOffset--; loadDay(); };
$("#nextDay").onclick = () => { S.dayOffset++; loadDay(); };
$("#dayLabel").onclick = () => { if (S.dayOffset) { S.dayOffset = 0; loadDay(); } };

// Keep scores/grades fresh while the app is open
setInterval(() => { if (document.visibilityState === "visible") gradePending(); }, 120_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") gradePending(); });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

saveSlip();
loadDay().then(() => gradePending());
