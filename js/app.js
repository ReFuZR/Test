import * as D from "./data.js";
import * as M from "./model.js";

// ---------------- storage (defensive: corrupted or foreign data is ignored, never fatal) ----------------
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch { try { for (const key of Object.keys(localStorage)) if (key.startsWith("cp.gl.")) localStorage.removeItem(key); localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  },
};

const finite = (x) => typeof x === "number" && Number.isFinite(x);
const RESULTS = new Set(["pending", "win", "loss", "push", "void"]);
const KINDS = new Set(["ml", "spread", "total", "prop", "dd", "td"]);

/** Keep only well-formed legs; anything else (old versions, hand-edited backups) is dropped. */
function cleanLeg(l) {
  if (!l || typeof l !== "object" || !KINDS.has(l.kind) || typeof l.eventId !== "string" || !finite(M.toDecimal(l.american))) return null;
  return {
    id: String(l.id || `${l.eventId}|${l.kind}|${l.side || ""}|${l.athleteId || ""}|${(l.stats || []).join("+")}|${l.threshold ?? ""}`),
    eventId: l.eventId, kind: l.kind, side: l.side, line: finite(l.line) ? l.line : undefined,
    athleteId: l.athleteId ? String(l.athleteId) : undefined, teamId: l.teamId,
    stats: Array.isArray(l.stats) ? l.stats.filter((s) => ["pts", "reb", "ast", "tpm", "stl", "blk"].includes(s)) : [],
    threshold: finite(l.threshold) ? l.threshold : undefined,
    label: String(l.label || "Bet").slice(0, 120), game: String(l.game || "").slice(0, 40), start: l.start,
    american: M.parseAmerican(l.american), pModel: finite(l.pModel) ? l.pModel : 0.5, pBook: finite(l.pBook) ? l.pBook : undefined,
    pA: finite(l.pA) ? l.pA : undefined, pB: finite(l.pB) ? l.pB : undefined, verified: typeof l.verified === "boolean" ? l.verified : undefined,
    statLabel: l.statLabel, detail: l.detail && typeof l.detail === "object" ? l.detail : undefined, injury: l.injury,
    result: RESULTS.has(l.result) ? l.result : undefined, actual: l.actual,
  };
}
function cleanBet(b) {
  if (!b || typeof b !== "object" || !Array.isArray(b.legs)) return null;
  const legs = b.legs.map(cleanLeg).filter(Boolean).map((l) => ({ ...l, result: l.result || "pending" }));
  if (!legs.length || (b.type !== "parlay" && b.type !== "straight")) return null;
  const stake = finite(b.stake) && b.stake > 0 ? Math.min(b.stake, 1e6) : null;
  if (!stake) return null;
  const bet = { id: String(b.id || `b${Date.now()}${Math.random()}`), created: finite(b.created) ? b.created : Date.now(), type: b.type, stake, toWin: finite(b.toWin) ? b.toWin : 0, legs };
  return { ...bet, ...M.settleBet(bet) };
}

// ---------------- state ----------------
const S = {
  tab: "games",
  dayOffset: 0,
  games: [], standings: null, injuries: {}, transactions: null,
  injuryImpact: {},          // teamId -> {total, form, players}
  forms: {},                 // teamId -> recent-form rating (algorithm B)
  rosters: {}, gamelogs: {}, propLegs: {},
  propGame: null, propStat: "All", propSort: "likely",
  slip: Array.isArray(store.get("cp.slip", [])) ? store.get("cp.slip", []).map(cleanLeg).filter(Boolean) : [],
  bets: Array.isArray(store.get("cp.bets", [])) ? store.get("cp.bets", []).map(cleanBet).filter(Boolean) : [],
  stake: finite(store.get("cp.stake", 10)) ? store.get("cp.stake", 10) : 10,
  risk: "balanced", scope: "both", verifiedOnly: true,
  suggestions: null, building: null, buildNote: "",
  newsFilter: "today",
  loading: true, error: null, loadToken: 0,
  expanded: new Set(),
};

const RISK = { safer: { label: "Safer", min: 100, sizes: [2, 3] }, balanced: { label: "Balanced", min: 250, sizes: [2, 3, 4] }, long: { label: "Long shot", min: 600, sizes: [3, 4, 5] } };
const MAX_STAKE = 100000;

// ---------------- helpers ----------------
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (typeof u === "string" && u.startsWith("https://") ? esc(u) : "");
const pct = (p, d = 0) => (finite(p) ? `${(p * 100).toFixed(d)}%` : "—");
const money = (x) => { if (!finite(x)) return "—"; const r = Math.round(x * 100) / 100; return `${r < 0 ? "−" : ""}$${Math.abs(r).toFixed(2)}`; };
const signed = (x, d = 1) => (!finite(x) ? "—" : x > 0 ? `+${x.toFixed(d)}` : x.toFixed(d));
const fmtLine = (x) => (!finite(x) ? "" : x > 0 ? `+${x}` : `${x}`);
const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const dayDate = () => { const d = new Date(); d.setDate(d.getDate() + S.dayOffset); return d; };
const validDate = (iso) => iso && !Number.isNaN(new Date(iso).getTime());
const timeOf = (iso) => (validDate(iso) ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "TBD");
const shortDate = (iso) => (validDate(iso) ? new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }) : "");
const ago = (iso) => { if (!validDate(iso)) return ""; const h = (Date.now() - new Date(iso)) / 36e5; return h < 1 ? "just now" : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`; };
const statusClass = (s) => (/out|suspen/i.test(s) ? "out" : /doubt|quest|day-to-day|gtd/i.test(s) ? "q" : "info");
const seasonYear = () => { const d = new Date(); return d.getMonth() >= 7 ? d.getFullYear() + 1 : d.getFullYear(); };
const lastName = (n) => String(n || "").trim().split(/\s+/).slice(-1)[0];
const avg = (rows, k) => { const xs = (rows || []).map((r) => r[k]).filter(finite); return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; };

function toast(msg, kind = "") {
  const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.className = `toast ${kind}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
const saveSlip = () => { store.set("cp.slip", S.slip); const c = $("#slipCount"); if (c) { c.textContent = S.slip.length; c.hidden = !S.slip.length; } };
const saveBets = () => { if (!store.set("cp.bets", S.bets)) toast("Couldn't save. Your phone's storage is full or blocked.", "bad"); };
const inSlip = (id) => S.slip.some((l) => l.id === id);

const legIndex = new Map();
function remember(legs) { for (const l of legs) if (l) legIndex.set(l.id, l); }

function toggleLeg(leg) {
  if (!leg) return toast("That line isn't available any more. Pull to refresh.", "bad");
  if (inSlip(leg.id)) S.slip = S.slip.filter((l) => l.id !== leg.id);
  else {
    if (S.slip.length >= 12) return toast("A slip holds up to 12 legs", "bad");
    if (leg.start && validDate(leg.start) && new Date(leg.start) < new Date()) return toast("That game has already started", "bad");
    // Can't hold both sides of one market
    S.slip = S.slip.filter((l) => !(l.eventId === leg.eventId && l.kind === leg.kind && !leg.athleteId));
    S.slip.push(leg); toast(`Added ${leg.label}`);
  }
  saveSlip(); render();
}

// ---------------- data loading ----------------
async function gamelog(athleteId) {
  if (S.gamelogs[athleteId]) return S.gamelogs[athleteId];
  const key = `cp.gl.${athleteId}`, cached = store.get(key, null);
  if (cached && finite(cached.t) && Array.isArray(cached.rows) && Date.now() - cached.t < 3 * 36e5) return (S.gamelogs[athleteId] = cached.rows);
  let rows = D.parseGamelog(await D.getJSON(D.URLS.gamelog(athleteId), 36e5));
  if (rows.length < 8) {   // early season or rookie: lean on last season too
    try { rows = rows.concat(D.parseGamelog(await D.getJSON(D.URLS.gamelog(athleteId, seasonYear() - 1), 864e5)).slice(0, 25)); } catch { /* no history */ }
  }
  store.set(key, { t: Date.now(), rows: rows.slice(0, 40) });
  return (S.gamelogs[athleteId] = rows);
}

async function loadDay() {
  const token = ++S.loadToken;
  S.loading = true; S.error = null; S.propLegs = {}; S.suggestions = null; S.forms = {}; S.injuryImpact = {}; render();
  try {
    const [sb, st, inj] = await Promise.all([
      D.getJSON(D.URLS.scoreboard(ymd(dayDate())), 30_000),
      D.getJSON(D.URLS.standings(), 600_000),
      D.getJSON(D.URLS.injuries(), 300_000).catch(() => ({})),   // injuries are nice-to-have
    ]);
    if (token !== S.loadToken) return;                 // user changed day meanwhile
    S.games = D.parseScoreboard(sb).sort((a, b) => new Date(a.date) - new Date(b.date));
    S.standings = D.parseStandings(st);
    S.injuries = D.parseInjuries(inj);
    S.propGame = S.games.find((g) => g.state === "pre")?.id || S.games[0]?.id || null;
    S.loading = false; render();
    await Promise.all([computeForms(token), computeInjuryImpacts(token)]);
    if (token === S.loadToken) render();
  } catch (e) {
    if (token !== S.loadToken) return;
    S.loading = false; S.error = e?.message || "Couldn't reach ESPN."; render();
  }
}

/** Algorithm B input: each team's last-10 opponent-adjusted form, from its schedule. */
async function computeForms(token) {
  const ids = [...new Set(S.games.flatMap((g) => [g.home.id, g.away.id]))];
  const ratings = Object.fromEntries(Object.values(S.standings?.teams || {}).map((t) => [t.id, M.teamRating(t)]));
  const res = await D.pool(ids, 6, async (id) => [id, D.parseSchedule(await D.getJSON(D.URLS.schedule(id), 36e5), id)]);
  if (token !== S.loadToken) return;
  for (const r of res) if (r) { S.forms[r[0]] = M.formRating(r[1], ratings); S.forms[r[0]] && (S.forms[r[0]].games = r[1].slice(0, 10).map((g) => g.eventId)); }
}

/** Estimated margin lost to injuries. Season model: scaled by share of season played. Form model: by share of last 10. */
async function computeInjuryImpacts(token) {
  const teamIds = new Set(S.games.flatMap((g) => [g.home.id, g.away.id]));
  const jobs = [];
  for (const id of teamIds) for (const p of S.injuries[id] || []) if (p.athleteId && /out|doubt|quest|day/i.test(p.status)) jobs.push({ teamId: id, p });
  const res = await D.pool(jobs, 6, async ({ teamId, p }) => {
    const all = await gamelog(p.athleteId);
    const seasonStart = new Date(seasonYear() - 1, 8, 1);
    const thisSeason = all.filter((r) => validDate(r.date) && new Date(r.date) >= seasonStart);
    const rows = thisSeason.length >= 3 ? thisSeason : all.slice(0, 20);
    const t = S.standings?.teams?.[teamId], gp = t && finite(t.wins) ? t.wins + t.losses : 0;
    const weight = /out/i.test(p.status) ? 1 : /doubt/i.test(p.status) ? 0.8 : 0.4;
    const base = M.injuryImpact({ ppg: avg(rows, "pts"), rpg: avg(rows, "reb"), apg: avg(rows, "ast"), mpg: avg(rows, "min") });
    return { teamId, base, weight, eventIds: new Set(thisSeason.map((r) => r.eventId)), seasonShare: gp ? Math.min(1, thisSeason.length / gp) : 0, name: p.name, status: p.status };
  });
  if (token !== S.loadToken) return;
  S.injuryImpact = {};
  for (const r of res) {
    if (!r) continue;
    const t = (S.injuryImpact[r.teamId] ||= { total: 0, form: 0, players: [] });
    t.total += r.base * r.weight * r.seasonShare;
    const recent = S.forms[r.teamId]?.games || [];
    const formShare = recent.length ? recent.filter((id) => r.eventIds.has(id)).length / recent.length : r.seasonShare;
    t.form += r.base * r.weight * formShare;
    t.players.push(r);
  }
}

function projections(g) {
  const T = S.standings?.teams || {};
  const inj = { h: S.injuryImpact[g.home.id] || {}, a: S.injuryImpact[g.away.id] || {} };
  return {
    A: M.projectGame(T[g.home.id], T[g.away.id], { homeInjury: inj.h.total, awayInjury: inj.a.total }),
    B: M.projectGameForm(S.forms[g.home.id], S.forms[g.away.id], { homeInjury: inj.h.form, awayInjury: inj.a.form }),
  };
}

/** Attach both algorithms' estimates, the cross-check, and the final market-blended probability. */
function finalize(leg, pA, pB, pMarket, wMarket) {
  const c = M.consensus(pA, pB);
  return { ...leg, pA, pB, gap: c.gap, verified: c.verified, check: c.status, pModel: M.blend(c.p, pMarket, wMarket) };
}

function gameLegs(g) {
  const o = g.odds, { A, B } = projections(g);
  if (!o || (!A && !B)) return {};
  const base = { eventId: g.id, game: `${g.away.abbr} @ ${g.home.abbr}`, start: g.date };
  const legs = {};
  const add = (key, leg, pA, pB, pBook) => { if (finite(leg.american)) legs[key] = finalize({ ...leg, pBook }, pA, pB, pBook, 0.6); };
  const [nvH, nvA] = M.noVig(o.homeML, o.awayML);
  add("mlHome", { ...base, id: `${g.id}|ml|home`, kind: "ml", side: "home", teamId: g.home.id, label: `${g.home.abbr} ML`, american: o.homeML, open: o.homeMLOpen }, A?.pHome, B?.pHome, nvH);
  add("mlAway", { ...base, id: `${g.id}|ml|away`, kind: "ml", side: "away", teamId: g.away.id, label: `${g.away.abbr} ML`, american: o.awayML, open: o.awayMLOpen }, A && 1 - A.pHome, B && 1 - B.pHome, nvA);
  const [nsH, nsA] = M.noVig(o.homeSpreadOdds, o.awaySpreadOdds);
  if (finite(o.homeSpread)) add("spHome", { ...base, id: `${g.id}|spread|home`, kind: "spread", side: "home", line: o.homeSpread, label: `${g.home.abbr} ${fmtLine(o.homeSpread)}`, american: o.homeSpreadOdds }, A && M.pCover(A.margin, o.homeSpread), B && M.pCover(B.margin, o.homeSpread), nsH);
  if (finite(o.awaySpread)) add("spAway", { ...base, id: `${g.id}|spread|away`, kind: "spread", side: "away", line: o.awaySpread, label: `${g.away.abbr} ${fmtLine(o.awaySpread)}`, american: o.awaySpreadOdds }, A && M.pCover(-A.margin, o.awaySpread), B && M.pCover(-B.margin, o.awaySpread), nsA);
  const [nO, nU] = M.noVig(o.overOdds, o.underOdds);
  if (finite(o.total)) {
    add("over", { ...base, id: `${g.id}|total|over`, kind: "total", side: "over", line: o.total, label: `Over ${o.total} · ${base.game}`, american: o.overOdds }, A && M.pOver(A.total, o.total), B && M.pOver(B.total, o.total), nO);
    add("under", { ...base, id: `${g.id}|total|under`, kind: "total", side: "under", line: o.total, label: `Under ${o.total} · ${base.game}`, american: o.underOdds }, A && 1 - M.pOver(A.total, o.total), B && 1 - M.pOver(B.total, o.total), nU);
  }
  return legs;
}

async function loadProps(eventId, onProgress) {
  if (S.propLegs[eventId]) return S.propLegs[eventId];
  const g = S.games.find((x) => x.id === eventId);
  if (!g) return [];
  const [propsJson, rh, ra] = await Promise.all([
    D.getJSON(D.URLS.props(eventId), 120_000),
    S.rosters[g.home.id] ? null : D.getJSON(D.URLS.roster(g.home.id), 36e5).catch(() => null),
    S.rosters[g.away.id] ? null : D.getJSON(D.URLS.roster(g.away.id), 36e5).catch(() => null),
  ]);
  if (rh) S.rosters[g.home.id] = Object.fromEntries(Object.entries(D.parseRoster(rh)).map(([k, v]) => [k, { ...v, teamId: v.teamId || g.home.id }]));
  if (ra) S.rosters[g.away.id] = Object.fromEntries(Object.entries(D.parseRoster(ra)).map(([k, v]) => [k, { ...v, teamId: v.teamId || g.away.id }]));
  const props = D.parseProps(propsJson);
  const ids = [...new Set(props.map((p) => p.athleteId))];
  let done = 0;
  await D.pool(ids, 6, async (id) => { try { await gamelog(id); } finally { onProgress?.(++done / Math.max(1, ids.length)); } });

  const T = S.standings?.teams || {}, league = S.standings?.leagueOpp || 114;
  const legs = [];
  for (const pr of props) {
    const info = S.rosters[g.home.id]?.[pr.athleteId] || S.rosters[g.away.id]?.[pr.athleteId];
    const rows = S.gamelogs[pr.athleteId] || [];
    if (!info || !rows.length) continue;                 // traded away / not on either roster / no history
    const oppId = info.teamId === g.home.id ? g.away.id : g.home.id;
    const injury = (S.injuries[info.teamId] || []).find((i) => i.athleteId === pr.athleteId);
    let a, b;
    if (pr.kind === "prop") {
      const ratio = T[oppId]?.opp ? T[oppId].opp / league : 1;
      const oppFactor = pr.stats.includes("pts") ? 1 + 0.7 * (ratio - 1) : 1;
      const statOf = (r) => pr.stats.reduce((s, k) => s + (finite(r[k]) ? r[k] : NaN), 0);
      a = M.propProb(rows.map(statOf), pr.threshold, oppFactor);
      b = M.perMinuteProp(rows, pr.threshold, statOf, oppFactor);
    } else {
      a = M.multiDoubleProb(rows, pr.kind === "dd" ? 2 : 3);
      b = M.perMinuteMultiDouble(rows, pr.kind === "dd" ? 2 : 3);
    }
    if (!a && !b) continue;
    const out = injury && /out/i.test(injury.status);
    const leg = finalize({
      id: `${eventId}|${pr.kind}|${pr.athleteId}|${pr.stats.join("+") || pr.kind}|${pr.threshold}`, eventId, kind: pr.kind, athleteId: pr.athleteId, teamId: info.teamId,
      stats: pr.stats, threshold: pr.threshold, statLabel: pr.label, american: pr.american,
      label: pr.kind === "prop" ? `${info.short} ${pr.threshold}+ ${pr.label}` : `${info.short} ${pr.label}`,
      game: `${g.away.abbr} @ ${g.home.abbr}`, start: g.date, pBook: M.impliedProb(pr.american),
      detail: { mean: a?.mean ?? b?.mean, projMin: b?.projMin, n: a?.n ?? b?.n ?? rows.length, hitSeason: a?.hitSeason, hitL10: a?.hitL10, confidence: a?.confidence || "medium" },
      injury: injury?.status || "",
    }, a?.p, b?.p, M.fairOneSided(pr.american), 0.35);
    if (out) leg.pModel = 0;
    legs.push(leg);
  }
  return (S.propLegs[eventId] = legs);
}

// ---------------- grading ----------------
let grading = false;
async function gradePending({ quiet = true } = {}) {
  if (grading) return;
  const pending = S.bets.filter((b) => b.status === "pending");
  const events = [...new Set(pending.flatMap((b) => b.legs.filter((l) => !l.result || l.result === "pending").map((l) => l.eventId)))];
  if (!events.length) { if (!quiet) toast("Nothing waiting on results"); return; }
  grading = true;
  try {
    const results = {};
    await D.pool(events, 4, async (id) => { results[id] = D.parseSummary(await D.getJSON(D.URLS.summary(id), 0)); });
    let changed = 0;
    for (const b of pending) {
      for (const l of b.legs) {
        if (l.result && l.result !== "pending") continue;
        const res = results[l.eventId];
        const r = M.gradeLeg(l, res);
        if (r !== "pending") { l.result = r; changed++; }
        if (res?.completed && l.athleteId) {
          const p = res.players[l.athleteId];
          if (p && !p.dnp) l.actual = l.kind === "prop" ? l.stats.reduce((s, k) => s + (p[k] || 0), 0) : `${p.pts}/${p.reb}/${p.ast}`;
        }
      }
      Object.assign(b, M.settleBet(b));
    }
    saveBets();
    if (changed || !quiet) toast(changed ? `Graded ${changed} leg${changed > 1 ? "s" : ""}` : "No final scores yet");
    if (S.tab === "tracker") render();
  } finally { grading = false; }
}

// ---------------- views ----------------
const view = () => $("#view");
let renderSeq = 0;

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === S.tab));
  const d = dayDate();
  $("#dayLabel").textContent = S.dayOffset === 0 ? "Today" : S.dayOffset === 1 ? "Tomorrow" : S.dayOffset === -1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  saveSlip();
  const seq = ++renderSeq;
  const fn = { games: renderGames, props: renderProps, slip: renderSlip, tracker: renderTracker, news: renderNews }[S.tab] || renderGames;
  // A bug in one screen must never blank the app
  Promise.resolve().then(fn).catch((e) => {
    console.error(e);
    if (seq === renderSeq) view().innerHTML = `<div class="card empty"><strong>Something went wrong</strong>This screen hit an error. Your bets are safe.<br><br><button class="btn" data-act="reload">Reload data</button></div>`;
  });
}

const head = (title, sub = "") => `<header class="page-head"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</header>`;
const loadingHtml = (msg, p) => `<div class="loading"><div class="spinner"></div><div>${esc(msg)}</div>${p !== undefined ? `<div class="bar"><i style="width:${Math.round(p * 100)}%"></i></div>` : ""}</div>`;
const skeleton = (n = 3) => Array.from({ length: n }, () => `<div class="card skel"><i></i><i></i><i></i></div>`).join("");
const errorHtml = () => `<div class="card empty"><strong>Can't load games</strong>${esc(S.error)}<br><br><button class="btn primary" data-act="reload">Try again</button></div>`;

/** Verified / Split chip. */
function checkChip(l, compact = false) {
  if (!l || !finite(l.pA) || !finite(l.pB)) return "";
  const title = `Season model ${pct(l.pA)} · Form model ${pct(l.pB)}`;
  return l.verified
    ? `<span class="chk ok" title="${title}">${compact ? "✓" : "✓ Verified"}</span>`
    : `<span class="chk split" title="${title}">${compact ? "≠" : `Split ${pct(l.pA)}/${pct(l.pB)}`}</span>`;
}

function pickBtn(leg, line) {
  if (!leg) return `<button class="pick" disabled><span class="od">—</span></button>`;
  const value = leg.pModel - leg.pBook > 0.03;
  return `<button class="pick${inSlip(leg.id) ? " in" : ""}" data-leg="${esc(leg.id)}" aria-pressed="${inSlip(leg.id)}" aria-label="${esc(leg.label)} ${M.fmtAmerican(leg.american)}, model ${pct(leg.pModel)}">
    ${line ? `<span class="ln">${esc(line)}</span>` : ""}<span class="od num">${M.fmtAmerican(leg.american)}</span>
    <span class="pm num">${pct(leg.pModel)}${value ? '<em class="up">▲</em>' : ""}${checkChip(leg, true)}</span>
    <span class="pbar"><i style="width:${Math.round((leg.pModel || 0) * 100)}%"></i></span></button>`;
}

function injuryLine(team) {
  const list = (S.injuries[team.id] || []).filter((p) => !/active/i.test(p.status));
  if (!list.length) return "";
  const impact = S.injuryImpact[team.id]?.total || 0;
  return `<div class="inj-line"><b>${esc(team.abbr)}</b>${list.slice(0, 5).map((p) => `<span class="tag ${statusClass(p.status)}">${esc(lastName(p.name))} · ${esc(p.status)}</span>`).join("")}${list.length > 5 ? `<span class="muted small">+${list.length - 5}</span>` : ""}${impact >= 0.5 ? `<span class="muted small">≈ −${impact.toFixed(1)} pts</span>` : ""}</div>`;
}

function renderGames() {
  if (S.loading) return (view().innerHTML = head("Tonight's slate", "Loading games, odds and injuries…") + skeleton());
  if (S.error) return (view().innerHTML = head("Tonight's slate") + errorHtml());
  if (!S.games.length) return (view().innerHTML = head("No games") + `<div class="card empty"><strong>Nothing on this date</strong>No NBA games scheduled. Use the arrows up top to change day.</div>`);
  const upcoming = S.games.filter((g) => g.state === "pre").length;
  const html = S.games.map((g) => {
    const legs = gameLegs(g), { A, B } = projections(g);
    remember(Object.values(legs));
    const live = g.state === "in", post = g.state === "post";
    const pHome = legs.mlHome?.pModel ?? A?.pHome;
    const color = (t, fb) => (t.color ? `#${t.color}` : fb);
    const team = (t) => `<div class="team${post && !t.winner ? " lost" : ""}"><span class="logo" style="--tc:${esc(color(t, "#666"))}"><img src="${safeUrl(t.logo)}" alt="" loading="lazy" onerror="this.remove()"></span><div class="nm">${esc(t.short)}<span class="rec">${esc(t.record)}</span></div><div class="sc num">${g.state === "pre" || !finite(t.score) ? "" : esc(t.score)}</div></div>`;
    const winBar = finite(pHome) && g.state === "pre" ? `<div class="winbar" style="--a:${esc(color(g.away, "#8a93a8"))};--h:${esc(color(g.home, "#ff7a1a"))}"><i style="width:${(1 - pHome) * 100}%"></i><i style="width:${pHome * 100}%"></i></div>
      <div class="row between small muted num"><span>${esc(g.away.abbr)} ${pct(1 - pHome)}</span><span>win chance</span><span>${esc(g.home.abbr)} ${pct(pHome)}</span></div>` : "";
    const markets = g.odds && g.state === "pre" ? `
      <div class="markets">
        <div></div><div class="hd">Money</div><div class="hd">Spread</div><div class="hd">Total</div>
        <div class="tm">${esc(g.away.abbr)}</div>${pickBtn(legs.mlAway)}${pickBtn(legs.spAway, legs.spAway && fmtLine(legs.spAway.line))}${pickBtn(legs.over, legs.over && `O ${legs.over.line}`)}
        <div class="tm">${esc(g.home.abbr)}</div>${pickBtn(legs.mlHome)}${pickBtn(legs.spHome, legs.spHome && fmtLine(legs.spHome.line))}${pickBtn(legs.under, legs.under && `U ${legs.under.line}`)}
      </div>` : g.state === "pre" ? `<div class="small muted" style="margin-top:10px">Lines aren't posted yet.</div>` : "";
    const fav = (p) => (p.margin >= 0 ? g.home.abbr : g.away.abbr);
    const algo = (A || B) && g.state === "pre" ? `
      <details class="algo"${S.expanded.has(g.id) ? " open" : ""} data-exp="${esc(g.id)}"><summary><span>Double-check</span>${checkChip(legs.mlHome)}</summary>
        <div class="algo-grid num">
          <span class="muted">Season model</span><span>${A ? `${esc(fav(A))} by ${Math.abs(A.margin).toFixed(1)} · total ${A.total.toFixed(0)}` : "not enough data"}</span>
          <span class="muted">Form model (last 10)</span><span>${B ? `${esc(fav(B))} by ${Math.abs(B.margin).toFixed(1)} · total ${B.total.toFixed(0)}` : "loading…"}</span>
          <span class="muted">Book</span><span>${g.odds ? `${esc(g.odds.provider)} ${esc(g.away.abbr)} ${fmtLine(g.odds.awaySpread)} · o/u ${g.odds.total ?? "—"}` : "—"}</span>
          ${legs.mlHome && finite(legs.mlHome.open) && legs.mlHome.open !== legs.mlHome.american ? `<span class="muted">Line move</span><span>${esc(g.home.abbr)} ML ${M.fmtAmerican(legs.mlHome.open)} → ${M.fmtAmerican(legs.mlHome.american)}</span>` : ""}
        </div></details>` : "";
    const inj = [injuryLine(g.away), injuryLine(g.home)].join("");
    return `<article class="card game">
      <div class="row between"><span class="status${live ? " live" : ""}">${live ? '<i class="pulse"></i>' : ""}${esc(g.state === "pre" ? timeOf(g.date) : g.detail)}</span>
        ${g.state === "pre" ? `<button class="ghost-pill" data-props="${esc(g.id)}">Props →</button>` : ""}</div>
      <div class="teams">${team(g.away)}${team(g.home)}</div>
      ${winBar}${markets}${algo}${inj ? `<div class="inj">${inj}</div>` : ""}
    </article>`;
  }).join("");
  view().innerHTML = head(S.dayOffset === 0 ? "Tonight's slate" : "Slate", `${S.games.length} game${S.games.length > 1 ? "s" : ""}${upcoming ? ` · ${upcoming} still to play` : ""}`)
    + `<div class="legend"><span><b class="dot-model"></b>model %</span><span><span class="chk ok">✓</span> both algorithms agree</span><span><span class="chk split">≠</span> they disagree</span></div>`
    + html + `<p class="disclaimer">For entertainment. 21+. Gambling problem? Call 1-800-GAMBLER.</p>`;
}

async function renderProps() {
  if (S.loading) return (view().innerHTML = head("Player props") + skeleton(2));
  if (S.error) return (view().innerHTML = head("Player props") + errorHtml());
  const upcoming = S.games.filter((g) => g.state === "pre");
  if (!upcoming.length) return (view().innerHTML = head("Player props") + `<div class="card empty"><strong>No props right now</strong>Props show for games that haven't started. Try tomorrow with the arrows up top.</div>`);
  if (!upcoming.some((g) => g.id === S.propGame)) S.propGame = upcoming[0].id;
  const chips = `<div class="seg scroll">${upcoming.map((g) => `<button class="${g.id === S.propGame ? "on" : ""}" data-pgame="${esc(g.id)}">${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</button>`).join("")}</div>`;
  const id = S.propGame;
  const top = head("Player props", "DraftKings ladders, scored by both algorithms") + chips;
  if (!S.propLegs[id]) {
    view().innerHTML = top + loadingHtml("Pulling prop lines and player game logs…", 0);
    try {
      await loadProps(id, (p) => { const b = $(".bar i"); if (b && S.propGame === id) b.style.width = `${Math.round(p * 100)}%`; });
    } catch (e) {
      if (S.tab === "props" && S.propGame === id) view().innerHTML = top + `<div class="card empty"><strong>Props unavailable</strong>${esc(e?.message || "Couldn't load props.")}<br><br><button class="btn" data-act="retryProps">Try again</button></div>`;
      return;
    }
    if (S.tab !== "props" || S.propGame !== id) return;
  }
  const all = S.propLegs[id] || [];
  remember(all);
  if (!all.length) return (view().innerHTML = top + `<div class="card empty"><strong>No props posted yet</strong>The book hasn't posted player props for this game. Check back closer to tip-off.</div>`);
  const statNames = ["All", ...new Set(all.map((l) => l.statLabel))];
  if (!statNames.includes(S.propStat)) S.propStat = "All";
  let legs = S.propStat === "All" ? all : all.filter((l) => l.statLabel === S.propStat);
  legs = legs.filter((l) => l.pModel > 0 && l.american >= -600 && M.toDecimal(l.american) < 30);   // skip near-locks and moonshots

  const byPlayer = new Map();
  for (const l of legs) { if (!byPlayer.has(l.athleteId)) byPlayer.set(l.athleteId, []); byPlayer.get(l.athleteId).push(l); }
  const score = (l) => (S.propSort === "likely" ? l.pModel : S.propSort === "value" ? l.pModel - l.pBook : (l.verified ? 1 : 0) + l.pModel);
  const players = [...byPlayer.entries()].map(([aid, ls]) => ({ aid, ls: ls.sort((a, b) => score(b) - score(a)).slice(0, S.propStat === "All" ? 4 : 6), best: Math.max(...ls.map(score)) }))
    .sort((a, b) => b.best - a.best);
  const g = S.games.find((x) => x.id === id);

  const cards = players.map(({ aid, ls }) => {
    const info = S.rosters[g.home.id]?.[aid] || S.rosters[g.away.id]?.[aid];
    if (!info) return "";
    const rows = S.gamelogs[aid] || [];
    const teamAbbr = info.teamId === g.home.id ? g.home.abbr : g.away.abbr;
    const inj = ls[0].injury;
    const l10 = rows.slice(0, 10).reverse();
    const firstProp = ls.find((l) => l.kind === "prop");
    const vals = firstProp ? l10.map((r) => firstProp.stats.reduce((s, k) => s + (r[k] || 0), 0)) : [];
    const maxV = Math.max(1, ...vals);
    const spark = firstProp && vals.length ? `<div class="spark-row"><div class="spark" role="img" aria-label="Last ${vals.length} games of ${esc(firstProp.statLabel)}">${vals.map((v) => `<i class="${v >= firstProp.threshold ? "hit" : ""}" style="height:${Math.max(10, (v / maxV) * 100)}%"></i>`).join("")}</div><span class="small muted">last ${vals.length} · ${esc(firstProp.statLabel)} vs ${firstProp.threshold}</span></div>` : "";
    const teammatesOut = (S.injuries[info.teamId] || []).filter((p) => /out/i.test(p.status) && p.athleteId !== aid).map((p) => lastName(p.name));
    const l10r = rows.slice(0, 10);
    return `<article class="card player">
      <div class="player-hd"><span class="avatar">${info.headshot ? `<img src="${safeUrl(info.headshot)}" alt="" loading="lazy" onerror="this.remove()">` : ""}<b>${esc((info.name || "?")[0])}</b></span>
        <div style="min-width:0"><div class="nm">${esc(info.name)} ${inj ? `<span class="tag ${statusClass(inj)}">${esc(inj)}</span>` : ""}</div>
        <div class="small muted">${esc(teamAbbr)} · ${esc(info.pos)}${info.jersey ? ` · #${esc(info.jersey)}` : ""}</div></div></div>
      <div class="stat-strip num"><span><b>${avg(l10r, "pts").toFixed(1)}</b>PTS</span><span><b>${avg(l10r, "reb").toFixed(1)}</b>REB</span><span><b>${avg(l10r, "ast").toFixed(1)}</b>AST</span><span><b>${avg(l10r, "tpm").toFixed(1)}</b>3PM</span><span><b>${avg(l10r, "min").toFixed(0)}</b>MIN</span></div>
      ${spark}
      ${teammatesOut.length ? `<div class="small muted">Teammates out: ${esc(teammatesOut.join(", "))}</div>` : ""}
      <div class="rungs">${ls.map((l) => `
        <div class="rung"><div class="what"><b>${l.kind === "prop" ? `${l.threshold}+ ${esc(l.statLabel)}` : esc(l.statLabel)}</b>
          <div class="small muted">${finite(l.detail?.hitL10) ? `L10 ${pct(l.detail.hitL10)} · ` : ""}${finite(l.detail?.mean) ? `proj ${l.detail.mean.toFixed(1)}` : ""}${l.detail?.confidence === "low" ? " · small sample" : ""}</div>
          <div class="chk-row">${checkChip(l)}</div></div>
          <div class="od num">${M.fmtAmerican(l.american)}</div>
          <div class="pm num"><b>${pct(l.pModel)}</b><span class="small muted">book ${pct(l.pBook)}</span></div>
          <button class="add${inSlip(l.id) ? " in" : ""}" data-leg="${esc(l.id)}" aria-pressed="${inSlip(l.id)}" aria-label="${inSlip(l.id) ? "Remove" : "Add"} ${esc(l.label)}">${inSlip(l.id) ? "✓" : "+"}</button></div>`).join("")}</div>
    </article>`;
  }).join("");

  view().innerHTML = `${top}
    <div class="toolbar">
      <label class="select"><span class="sr">Stat</span><select id="propStat">${statNames.map((s) => `<option${s === S.propStat ? " selected" : ""}>${esc(s)}</option>`).join("")}</select></label>
      <div class="seg">${[["likely", "Likely"], ["verified", "Verified"], ["value", "Vs book"]].map(([k, t]) => `<button class="${S.propSort === k ? "on" : ""}" data-sort="${k}">${t}</button>`).join("")}</div>
    </div>
    ${cards || `<div class="card empty"><strong>Nothing matches</strong>Try another stat.</div>`}
    <p class="disclaimer">Season model: recency-weighted game logs + opponent defense. Form model: per-minute rate × current minutes. Final % blends both with the book price.</p>`;
}

function renderSlip() {
  const legs = S.slip;
  const sugg = S.suggestions;
  const builder = `<section class="card builder">
    <div class="row between"><h2>Auto-parlay</h2><span class="small muted">most likely combos</span></div>
    <div class="seg">${Object.entries(RISK).map(([k, r]) => `<button class="${S.risk === k ? "on" : ""}" data-risk="${k}">${r.label}<small>${M.fmtAmerican(r.min)}+</small></button>`).join("")}</div>
    <div class="seg">${[["both", "Lines + props"], ["props", "Props"], ["lines", "Game lines"]].map(([k, t]) => `<button class="${S.scope === k ? "on" : ""}" data-scope="${k}">${t}</button>`).join("")}</div>
    <label class="switch"><input type="checkbox" id="verifiedOnly" ${S.verifiedOnly ? "checked" : ""}><span></span>Only legs both algorithms agree on</label>
    <button class="btn primary block" data-act="build" ${S.building !== null ? "disabled" : ""}>${S.building !== null ? `Scanning games… ${Math.round(S.building * 100)}%` : "Build parlays"}</button>
    ${sugg ? (sugg.length ? sugg.map((s, i) => `
      <div class="sugg">
        <div class="row between"><span class="small muted">${s.legs.length}-leg${s.math.sameGame ? " · same-game legs" : ""}${s.math.verified ? ' · <span class="chk ok">✓ all verified</span>' : ""}</span><span class="big num">${M.fmtAmerican(s.math.american)}</span></div>
        ${s.legs.map((l) => `<div class="sleg"><span>${esc(l.label)}<small>${esc(l.game)}</small></span><span class="num">${M.fmtAmerican(l.american)} <b>${pct(l.pModel)}</b></span></div>`).join("")}
        <div class="row between"><span class="small">Hit chance <b class="model">${pct(s.math.pModel, 1)}</b> <span class="muted">· book ${pct(s.math.pBook, 1)}</span></span><button class="btn" data-use="${i}">Use</button></div>
      </div>`).join("") + (S.buildNote ? `<div class="small muted">${esc(S.buildNote)}</div>` : "") : `<div class="small muted">No combo reached that payout${S.verifiedOnly ? " with verified legs only" : ""}. Try a lower risk level${S.verifiedOnly ? " or allow split legs" : ""}.</div>`) : ""}
  </section>`;

  if (!legs.length) {
    view().innerHTML = head("Bet slip", "Empty for now") + `<div class="card empty"><strong>Your slip is empty</strong>Tap a price on Games, + on Props, or let Auto-parlay build one.</div>${builder}`;
    return;
  }
  const cmp = M.compareStraightVsParlay(legs, S.stake);
  const math = M.parlayMath(legs);
  const warn = [];
  if (math.sameGame) warn.push("Same-game legs are often correlated, so the real odds differ from the multiplied price. Books price same-game parlays differently.");
  if (legs.some((l) => l.verified === false)) warn.push("Some legs are Split: the two algorithms disagree, so their % is less reliable.");
  if (legs.some((l) => l.detail?.confidence === "low")) warn.push("Some legs rest on only a few games.");
  if (legs.some((l) => l.start && validDate(l.start) && new Date(l.start) < new Date())) warn.push("A game in this slip has already started.");
  const evCls = (x) => (x >= 0 ? "pos" : "neg");
  const multi = legs.length > 1;

  view().innerHTML = head("Bet slip", `${legs.length} leg${multi ? "s" : ""}`) + `
    <section class="card hero">
      <div class="hero-top"><div><div class="k">${multi ? "Parlay odds" : "Odds"}</div><div class="big num">${M.fmtAmerican(math.american)}</div></div>
        <div class="ring" style="--p:${Math.round((math.pModel || 0) * 100)}"><span class="num">${pct(math.pModel)}</span><small>hit chance</small></div></div>
      <div class="hero-row num"><span>Stake <input type="number" id="stake" inputmode="decimal" min="1" max="${MAX_STAKE}" step="1" value="${S.stake}" aria-label="Stake"></span><span>Pays <b>${money(cmp.parlay.toWin)}</b></span></div>
    </section>
    <section class="card">
      ${legs.map((l, i) => `
        <div class="leg"><div style="min-width:0"><div class="lbl">${esc(l.label)}</div><div class="small muted">${esc(l.game || "")} · <span class="model">${pct(l.pModel)}</span> ${checkChip(l)}</div></div>
          <input type="text" inputmode="numeric" id="odds-${i}" data-odds="${i}" value="${esc(M.fmtAmerican(l.american))}" aria-label="Odds for ${esc(l.label)}">
          <button class="x" data-remove="${i}" aria-label="Remove ${esc(l.label)}">×</button></div>`).join("")}
      <div class="row between small muted" style="margin-top:6px"><span>Edit odds to match your book.</span><button class="link-btn" data-act="clear">Clear all</button></div>
    </section>
    ${multi ? `<section class="card">
      <h2>Parlay or straights?</h2>
      <div class="cmp">
        <div class="opt"><div class="k">Parlay</div><div class="v num">${money(cmp.parlay.toWin)}</div><div class="small muted">if all ${legs.length} hit · ${pct(cmp.parlay.p, 1)}</div><div class="small ${evCls(cmp.parlay.ev)} num">EV ${money(cmp.parlay.ev)}</div></div>
        <div class="opt"><div class="k">Straights · ${money(S.stake / legs.length)} each</div><div class="v num">${money(cmp.straights.reduce((s, x) => s + x.toWin, 0))}</div><div class="small muted">max · ${pct(cmp.straightsPAnyWin)} chance ≥1 wins</div><div class="small ${evCls(cmp.straightsEv)} num">EV ${money(cmp.straightsEv)}</div></div>
      </div>
      <div class="small muted">EV = model's average profit per bet over many tries. An estimate, not a promise.</div>
    </section>` : ""}
    ${warn.map((w) => `<div class="note">${esc(w)}</div>`).join("")}
    <div class="row">${multi ? `<button class="btn primary block" data-save="parlay">Track parlay</button><button class="btn block" data-save="straight">Track straights</button>` : `<button class="btn primary block" data-save="straight">Track bet</button>`}</div>
    <p class="small muted" style="margin:0">Place it at your sportsbook, then track it here. Results grade automatically.</p>
    ${builder}`;
}

async function buildSuggestions() {
  S.building = 0; S.suggestions = null; S.buildNote = ""; render();
  try {
    const upcoming = S.games.filter((g) => g.state === "pre");
    let cands = [];
    if (S.scope !== "props") for (const g of upcoming) cands.push(...Object.values(gameLegs(g)));
    if (S.scope !== "lines") {
      let done = 0;
      for (const g of upcoming) {
        try { cands.push(...(await loadProps(g.id))); } catch { /* game without props */ }
        S.building = ++done / Math.max(1, upcoming.length); if (S.tab === "slip") render();
      }
    }
    cands = cands.filter((l) => l.pModel > 0 && !(l.injury && /out|doubt/i.test(l.injury)) && l.american >= -500 && M.toDecimal(l.american) < 6);
    remember(cands);
    const risk = RISK[S.risk];
    const exhaustive = M.suggestParlays(cands, { minAmerican: risk.min, sizes: risk.sizes, verifiedOnly: S.verifiedOnly });
    // Second, independent search (greedy) double-checks the first. Keep whichever finds the likelier parlay.
    const pool = S.verifiedOnly ? cands.filter((c) => c.verified) : cands;
    let swapped = 0;
    const checked = risk.sizes.map((k) => {
      const a = exhaustive.find((s) => s.legs.length === k), b = M.greedyParlay(pool, k, risk.min);
      if (b && (!a || b.math.pModel > a.math.pModel + 1e-9)) { swapped++; return b; }
      return a;
    }).filter(Boolean);
    S.suggestions = checked;
    S.buildNote = checked.length ? (swapped ? `Double-check: a second search found ${swapped} likelier combo${swapped > 1 ? "s" : ""}, shown instead.` : "Double-checked: a second, independent search found nothing likelier.") : "";
  } catch (e) {
    S.suggestions = []; toast(e?.message || "Couldn't build parlays", "bad");
  } finally {
    S.building = null;
    if (S.tab === "slip") render();
  }
}

function renderTracker() {
  const st = M.trackerStats(S.bets);
  const al = st.algo;
  const tiles = `<div class="tiles">
    <div class="tile"><div class="k">Record</div><div class="v num">${st.wins}-${st.losses}${st.pushes ? `-${st.pushes}` : ""}</div><div class="small muted">${st.pending} pending</div></div>
    <div class="tile"><div class="k">Profit</div><div class="v num ${st.profit > 0 ? "pos" : st.profit < 0 ? "neg" : ""}">${money(st.profit)}</div><div class="small muted">on ${money(st.staked)}</div></div>
    <div class="tile"><div class="k">ROI</div><div class="v num ${st.roi > 0 ? "pos" : st.roi < 0 ? "neg" : ""}">${signed(st.roi * 100)}%</div><div class="small muted">per $ bet</div></div>
    <div class="tile"><div class="k">Legs hit</div><div class="v num">${st.legTotal ? pct(st.legHits / st.legTotal) : "—"}</div><div class="small muted">${st.legHits}/${st.legTotal}</div></div>
  </div>`;
  const algoCard = al.n || al.verifiedN || al.splitN ? `<section class="card">
    <h2>Algorithm check</h2>
    <div class="small muted">Graded legs scored by each method. Lower error = sharper predictions.</div>
    <div class="algo-cmp num">
      <div><span class="k">Season model</span><b>${al.brierA !== null ? al.brierA.toFixed(3) : "—"}</b></div>
      <div><span class="k">Form model</span><b>${al.brierB !== null ? al.brierB.toFixed(3) : "—"}</b></div>
      <div><span class="k">Final (blended)</span><b>${al.brierFinal !== null ? al.brierFinal.toFixed(3) : "—"}</b></div>
    </div>
    <div class="row between small"><span><span class="chk ok">✓ Verified</span> legs hit</span><b class="num">${pct(al.verifiedHit)} <span class="muted">(${al.verifiedN})</span></b></div>
    <div class="row between small"><span><span class="chk split">Split</span> legs hit</span><b class="num">${pct(al.splitHit)} <span class="muted">(${al.splitN})</span></b></div>
  </section>` : "";
  const split = `<section class="card">
    <h2>Parlays vs straights</h2>
    <div class="row between"><span>Parlays</span><b class="num">${st.parlay.wins}-${st.parlay.losses}</b></div>
    <div class="row between"><span>Straight bets</span><b class="num">${st.straight.wins}-${st.straight.losses}</b></div>
    ${Object.keys(st.byKind).length ? `<h3>Hit rate by bet type</h3>${Object.entries(st.byKind).map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="track"><i style="width:${(v.hits / v.total) * 100}%"></i></div><span class="num small">${v.hits}/${v.total}</span></div>`).join("")}` : ""}
    ${st.buckets.some((b) => b.n) ? `<h3>Is the model honest?</h3><div class="small muted">Legs grouped by predicted chance vs how often they hit.</div>
      <div class="tbl"><table class="compare num"><thead><tr><th>Model said</th><th>Legs</th><th>Hit</th></tr></thead><tbody>
      ${st.buckets.filter((b) => b.n).map((b) => `<tr><td>${pct(b.lo)}–${pct(Math.min(1, b.hi))}</td><td>${b.n}</td><td>${pct(b.actual)} <span class="muted">vs ${pct(b.predicted)}</span></td></tr>`).join("")}</tbody></table></div>` : ""}
  </section>`;
  const list = S.bets.slice().sort((a, b) => b.created - a.created).map((b) => `
    <article class="card bet ${esc(b.status)}">
      <div class="row between"><span><b>${b.type === "parlay" ? `${b.legs.length}-leg parlay` : "Straight"}</b> <span class="muted small">${esc(shortDate(b.created))}</span></span><span class="pill ${esc(b.status)}">${esc(b.status)}</span></div>
      <div class="legs">${b.legs.map((l) => `<div><span class="dot ${esc(l.result || "")}"></span>${esc(l.label)} <span class="muted num">${M.fmtAmerican(l.american)}${l.actual !== undefined ? ` · got ${esc(l.actual)}` : ""}${l.result === "void" ? " · DNP, void" : ""}</span></div>`).join("")}</div>
      <div class="row between small"><span class="muted">Stake ${money(b.stake)} · model ${pct(b.type === "parlay" ? b.legs.reduce((p, l) => p * l.pModel, 1) : b.legs[0].pModel)}</span><span class="num ${b.profit > 0 ? "pos" : b.profit < 0 ? "neg" : ""}">${b.status === "pending" ? `to win ${money(b.toWin)}` : money(b.profit)}</span></div>
      <div class="row" style="justify-content:flex-end"><button class="link-btn small" data-del="${esc(b.id)}">${S.confirmDel === b.id ? "Tap again to delete" : "Delete"}</button></div>
    </article>`).join("");
  view().innerHTML = head("Tracker", "Grades itself from ESPN box scores") + tiles + `
    <div class="row"><button class="btn block" data-act="grade">Check results</button><button class="btn ghost" data-act="export">Back up</button><label class="btn ghost" for="importFile">Restore</label><input type="file" id="importFile" accept="application/json,.json" hidden></div>
    ${S.bets.length ? algoCard + split + list : `<div class="card empty"><strong>No bets tracked yet</strong>Save a slip and its legs grade themselves when the games end.</div>`}
    <p class="disclaimer">Saved on this phone only. Use Back up to keep a copy.</p>`;
}

async function renderNews() {
  if (S.transactions === null) {
    view().innerHTML = head("Injuries & trades") + loadingHtml("Loading injuries and trades…");
    try { S.transactions = D.parseTransactions(await D.getJSON(D.URLS.transactions(), 600_000)); } catch { S.transactions = []; }
    if (S.tab !== "news") return;
  }
  const playing = new Set(S.games.flatMap((g) => [g.home.id, g.away.id]));
  const teams = Object.entries(S.injuries).filter(([id, l]) => l.length && (S.newsFilter === "all" || playing.has(id)));
  const T = S.standings?.teams || {};
  const injHtml = teams.map(([id, list]) => `
    <section class="card"><div class="row between"><h2>${esc(list[0].team)}</h2><span class="small muted num">${T[id] ? `${T[id].wins}-${T[id].losses}` : ""}</span></div>
      ${list.map((p) => `<div class="news-item"><div class="row wrap"><b>${esc(p.name)}</b><span class="muted small">${esc(p.pos)}</span><span class="tag ${statusClass(p.status)}">${esc(p.status)}</span>${p.detail ? `<span class="small muted">${esc(p.detail)}</span>` : ""}</div>
        <div class="small muted">${esc(p.comment)}${p.returnDate && validDate(p.returnDate) ? ` Est. return ${esc(shortDate(p.returnDate))}.` : ""}${p.date ? ` · ${esc(ago(p.date))}` : ""}</div></div>`).join("")}
    </section>`).join("");
  const txItem = (t) => `<div class="news-item tx">${t.logo ? `<img src="${safeUrl(t.logo)}" alt="" loading="lazy" onerror="this.remove()">` : "<span></span>"}<div><div>${t.isTrade ? '<span class="tag q">Trade</span> ' : ""}${esc(t.description)}</div><div class="small muted">${esc(t.team)}${t.date ? ` · ${esc(shortDate(t.date))}` : ""}</div></div></div>`;
  view().innerHTML = head("Injuries & trades") + `
    <div class="seg"><button class="${S.newsFilter === "today" ? "on" : ""}" data-news="today">On this slate</button><button class="${S.newsFilter === "all" ? "on" : ""}" data-news="all">All teams</button></div>
    ${injHtml || `<div class="card empty"><strong>All clear</strong>No injuries listed${S.newsFilter === "today" ? " for teams on this slate" : ""}.</div>`}
    <h3 class="section">Trades & roster moves</h3>
    <section class="card">${S.transactions.length ? S.transactions.slice(0, 30).map(txItem).join("") : `<div class="small muted">No recent transactions from ESPN.</div>`}</section>`;
}

// ---------------- actions ----------------
let lastSave = 0;
function saveBet(type) {
  if (Date.now() - lastSave < 1500) return;          // double-tap guard
  const stake = Number(S.stake);
  if (!finite(stake) || stake <= 0) return toast("Enter a stake above $0", "bad");
  if (stake > MAX_STAKE) return toast(`Stake can't be more than ${money(MAX_STAKE)}`, "bad");
  if (!S.slip.length) return toast("Your slip is empty", "bad");
  if (S.slip.some((l) => !finite(M.toDecimal(l.american)))) return toast("Fix the odds on every leg first", "bad");
  lastSave = Date.now();
  const strip = (l) => ({ ...cleanLeg(l), result: "pending" });
  const now = Date.now();
  if (type === "parlay" && S.slip.length > 1) {
    const m = M.parlayMath(S.slip);
    S.bets.push({ id: `b${now}`, created: now, type: "parlay", stake, toWin: stake * (m.decimal - 1), legs: S.slip.map(strip), status: "pending", profit: 0 });
  } else {
    const each = stake / S.slip.length;
    S.slip.forEach((l, i) => S.bets.push({ id: `b${now}-${i}`, created: now, type: "straight", stake: each, toWin: each * (M.toDecimal(l.american) - 1), legs: [strip(l)], status: "pending", profit: 0 }));
  }
  saveBets(); S.slip = []; saveSlip();
  toast(type === "parlay" ? "Parlay tracked" : "Bets tracked", "good");
  S.tab = "tracker"; render();
}

function goTab(tab) { S.tab = tab; S.confirmDel = null; window.scrollTo(0, 0); render(); if (tab === "tracker") gradePending(); }

document.addEventListener("click", (e) => {
  const t = e.target.closest("button, [data-tab]");
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.tab) return goTab(d.tab);
  if (d.leg) return toggleLeg(legIndex.get(d.leg));
  if (d.props) { S.propGame = d.props; return goTab("props"); }
  if (d.pgame) { S.propGame = d.pgame; return render(); }
  if (d.sort) { S.propSort = d.sort; return render(); }
  if (d.risk) { S.risk = d.risk; S.suggestions = null; return render(); }
  if (d.scope) { S.scope = d.scope; S.suggestions = null; return render(); }
  if (d.news) { S.newsFilter = d.news; return render(); }
  if (d.remove !== undefined) { S.slip.splice(Number(d.remove), 1); return render(); }
  if (d.save) return saveBet(d.save);
  if (d.use !== undefined) { const s = S.suggestions?.[Number(d.use)]; if (!s) return; S.slip = s.legs.slice(); toast("Parlay loaded into slip", "good"); window.scrollTo(0, 0); return render(); }
  if (d.del) {
    if (S.confirmDel !== d.del) { S.confirmDel = d.del; return render(); }
    S.bets = S.bets.filter((b) => b.id !== d.del); S.confirmDel = null; saveBets(); return render();
  }
  switch (d.act) {
    case "reload": D.clearCache(); return loadDay();
    case "retryProps": delete S.propLegs[S.propGame]; return render();
    case "clear": S.slip = []; return render();
    case "build": return buildSuggestions();
    case "grade": return gradePending({ quiet: false });
    case "export": {
      if (!S.bets.length) return toast("No bets to back up yet");
      const text = JSON.stringify({ app: "courtside-parlays", v: 2, bets: S.bets }, null, 1);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = `parlay-tracker-${ymd(new Date())}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      return toast("Backup saved", "good");
    }
  }
});

document.addEventListener("toggle", (e) => {
  const id = e.target?.dataset?.exp; if (!id) return;
  e.target.open ? S.expanded.add(id) : S.expanded.delete(id);
}, true);

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.id === "propStat") { S.propStat = t.value; return render(); }
  if (t.id === "verifiedOnly") { S.verifiedOnly = t.checked; S.suggestions = null; return render(); }
  if (t.id === "stake") {
    const v = Number(t.value);
    if (!finite(v) || v <= 0) toast("Enter a stake above $0", "bad");
    else if (v > MAX_STAKE) toast(`Stake can't be more than ${money(MAX_STAKE)}`, "bad");
    else { S.stake = Math.round(v * 100) / 100; store.set("cp.stake", S.stake); }
    return render();
  }
  if (t.dataset.odds !== undefined) {
    const l = S.slip[Number(t.dataset.odds)]; if (!l) return;
    const v = M.parseAmerican(t.value);
    if (finite(v)) { l.american = v; l.pBook = M.impliedProb(v); } else toast("Odds look like -110, +150 or EVEN", "bad");
    return render();
  }
  if (t.id === "importFile" && t.files?.[0]) {
    const f = t.files[0];
    t.value = "";
    if (f.size > 5e6) return toast("That file is too big to be a backup", "bad");
    f.text().then((txt) => {
      let data; try { data = JSON.parse(txt); } catch { throw new Error("bad"); }
      const list = Array.isArray(data) ? data : data?.bets;
      if (!Array.isArray(list)) throw new Error("bad");
      const have = new Set(S.bets.map((b) => b.id));
      const added = list.map(cleanBet).filter((b) => b && !have.has(b.id));
      S.bets.push(...added); saveBets();
      toast(added.length ? `Restored ${added.length} bet${added.length > 1 ? "s" : ""}` : "Nothing new in that backup", added.length ? "good" : "");
      render();
    }).catch(() => toast("That file isn't a tracker backup", "bad"));
  }
});

$("#prevDay").onclick = () => { if (S.dayOffset > -30) { S.dayOffset--; loadDay(); } };
$("#nextDay").onclick = () => { if (S.dayOffset < 30) { S.dayOffset++; loadDay(); } };
$("#dayLabel").onclick = () => { if (S.dayOffset) { S.dayOffset = 0; loadDay(); } };

// Offline banner + background refresh
function netStatus() { const b = $("#offline"); if (b) b.hidden = navigator.onLine !== false; }
window.addEventListener("online", () => { netStatus(); if (S.error) loadDay(); });
window.addEventListener("offline", netStatus);
window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); e.preventDefault?.(); });
setInterval(() => { if (document.visibilityState === "visible") gradePending(); }, 120_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") gradePending(); });

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

netStatus();
saveSlip();
loadDay().then(() => gradePending());
