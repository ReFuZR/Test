#!/usr/bin/env node
// Builds data/esports.json from PandaScore for the app's Esports tab.
// Runs in a scheduled GitHub Action so the API key stays in GitHub's secret store and never reaches a phone
// (PandaScore also doesn't allow direct browser calls). Usage: PANDASCORE_TOKEN=... node scripts/esports.mjs
//
// For each title: upcoming + live matches (next 4 days), finished matches (last 7 days, for grading), and the
// last ~300 finished series to rate teams two ways (Elo, and last-10 form) for the app's two algorithms.
// PUBG is left out: it is a battle royale (many teams per match), so a head-to-head pick does not apply.

import { writeFileSync, mkdirSync } from "node:fs";

const TOKEN = process.env.PANDASCORE_TOKEN;
const OUT = process.env.ESPORTS_OUT || "data/esports.json";
const API = "https://api.pandascore.co";
const GAMES = [
  ["league-of-legends", "League of Legends"], ["cs-go", "Counter-Strike 2"], ["dota-2", "Dota 2"], ["valorant", "Valorant"],
  ["r6-siege", "Rainbow Six Siege"], ["rl", "Rocket League"], ["cod-mw", "Call of Duty"], ["ow", "Overwatch"],
  ["mlbb", "Mobile Legends"], ["kog", "Honor of Kings"], ["lol-wild-rift", "Wild Rift"],
  ["starcraft-2", "StarCraft II"], ["starcraft-brood-war", "StarCraft: Brood War"], ["fifa", "EA Sports FC"],
];
const DAY = 864e5;
const K = 32;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function get(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(350);                                    // PandaScore also limits requests per second
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${path} -> rate limited`);
}

const slim = (m, game, gameName) => ({
  id: m.id, game, gameName, league: m.league?.name || "", tournament: [m.serie?.full_name, m.tournament?.name].filter(Boolean).join(" · "),
  begin_at: m.begin_at || m.scheduled_at, status: m.status, bestOf: m.number_of_games, forfeit: !!m.forfeit,
  winnerId: m.winner_id || null, draw: !!m.draw,
  score: (m.results || []).map((r) => r.score),
  teams: (m.opponents || []).filter((o) => o.type === "Team" || o.opponent).map((o) => ({ id: o.opponent.id, name: o.opponent.name, acronym: o.opponent.acronym, image: o.opponent.image_url || "" })),
});

async function main() {
  if (!TOKEN) {
    // Keep the app working (it shows a setup message) instead of failing the deploy
    mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
    writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), error: "PANDASCORE_TOKEN is not set", games: [], matches: [], teams: {} }));
    console.log("No PANDASCORE_TOKEN: wrote an empty esports file.");
    return;
  }
  const now = Date.now();
  const matches = [], teams = {};
  for (const [slug, name] of GAMES) {
    try {
      // Generic endpoints filtered by title: PandaScore's per-title URL prefixes don't always match the slugs
      const f = { "filter[videogame]": slug };
      const upcoming = await get("/matches/upcoming", { ...f, per_page: 100, sort: "begin_at", "range[begin_at]": `${new Date(now - DAY).toISOString()},${new Date(now + 4 * DAY).toISOString()}` });
      const running = await get("/matches/running", { ...f, per_page: 50 });
      const pastPages = [];
      for (const page of [1, 2, 3]) {
        const batch = await get("/matches/past", { ...f, "filter[status]": "finished", per_page: 100, page, sort: "-begin_at" });
        pastPages.push(batch);
        if (batch.length < 100) break;
      }
      const past = pastPages.flat().filter((m) => m.status === "finished" && m.winner_id && m.opponents?.length === 2);

      // Ratings, oldest result first
      const elo = {}, recent = {};
      for (const m of past.slice().sort((a, b) => new Date(a.begin_at) - new Date(b.begin_at))) {
        const [a, b] = m.opponents.map((o) => o.opponent.id);
        const ra = elo[a] ?? 1500, rb = elo[b] ?? 1500;
        const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
        const sa = m.winner_id === a ? 1 : 0;
        elo[a] = ra + K * (sa - ea); elo[b] = rb + K * ((1 - sa) - (1 - ea));
        (recent[a] ||= []).unshift(sa); (recent[b] ||= []).unshift(1 - sa);
      }
      for (const m of past) for (const o of m.opponents) teams[o.opponent.id] ||= { name: o.opponent.name, game: slug };
      for (const id of Object.keys(elo)) {
        const r = (recent[id] || []).slice(0, 10);
        Object.assign(teams[id] ||= { game: slug }, { elo: Math.round(elo[id]), played: (recent[id] || []).length, wins10: r.reduce((s, x) => s + x, 0), games10: r.length });
      }
      const keep = (m) => m.opponents?.length === 2 && m.opponents.every((o) => o.opponent);
      for (const m of [...running, ...upcoming].filter(keep)) matches.push(slim(m, slug, name));
      for (const m of past.filter((m) => now - new Date(m.begin_at) < 7 * DAY)) matches.push(slim(m, slug, name));
      console.log(`${name}: ${upcoming.length} upcoming, ${running.length} live, ${past.length} recent results`);
    } catch (e) {
      console.warn(`${name}: skipped (${e.message})`);
    }
  }
  const seen = new Set();
  const out = {
    updated: new Date().toISOString(),
    games: GAMES.map(([slug, name]) => ({ slug, name })),
    matches: matches.filter((m) => !seen.has(m.id) && seen.add(m.id)).sort((a, b) => new Date(a.begin_at) - new Date(b.begin_at)),
    teams,
  };
  mkdirSync(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${out.matches.length} matches, ${Object.keys(teams).length} rated teams to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
