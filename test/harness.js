// Browser test harness: serves the app from disk at https://app.test and answers ESPN calls with
// real saved responses (test/fixtures). Each test can override any endpoint to simulate failures.
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FX = join(ROOT, "test", "fixtures");

let playwright = null;
try { playwright = require("playwright"); } catch { /* browser tests are skipped without Playwright */ }
export const hasBrowser = !!playwright;

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json" };

export const fixture = (name) => JSON.parse(readFileSync(join(FX, name), "utf8"));

/** Scoreboard fixture with every game moved into the future so they're bettable whenever tests run. */
export function futureScoreboard(daysAhead = 1) {
  const sb = fixture("scoreboard.json");
  sb.events.forEach((e, i) => { e.date = new Date(Date.now() + daysAhead * 864e5 + i * 36e5).toISOString(); });
  return sb;
}

const soon = (i) => new Date(Date.now() + 2 * 60_000 + i * 60_000).toISOString();   // later today, in order

/** MLB fixture is a real past game: reopen it and give it lines so it's bettable. */
function mlbScoreboard() {
  const sb = fixture("mlb/scoreboard.json");
  const nbaOdds = fixture("scoreboard.json").events[0].competitions[0].odds;
  sb.events.forEach((e, i) => {
    e.date = new Date(Date.now() + 864e5 + i * 36e5).toISOString();
    e.status = { type: { state: "pre", completed: false, name: "STATUS_SCHEDULED", shortDetail: "7:05 PM" } };
    const c = e.competitions[0];
    c.competitors.forEach((t) => { t.score = "0"; t.winner = false; });
    const o = JSON.parse(JSON.stringify(nbaOdds));
    o[0].pointSpread.home.close.line = "-1.5"; o[0].pointSpread.away.close.line = "+1.5";
    o[0].total.over.close.line = "o8.5"; o[0].total.under.close.line = "u8.5"; o[0].overUnder = 8.5;
    c.odds = o;
  });
  return sb;
}

/** Tennis fixture is a finished tournament day: reopen six singles matches for later today. */
export function tennisScoreboard() {
  const sb = fixture("tennis/scoreboard.json");
  let n = 0;
  for (const e of sb.events) for (const g of e.groupings || []) {
    if (!/singles/i.test(g.grouping?.displayName || "")) continue;
    for (const c of g.competitions || []) {
      if (n >= 6) continue;
      c.date = soon(n++);
      c.status = { type: { state: "pre", completed: false, name: "STATUS_SCHEDULED", shortDetail: "Scheduled" } };
      c.competitors.forEach((x) => { x.winner = false; x.linescores = []; });
    }
  }
  return sb;
}

/** Esports fixture: upcoming matches moved to later today, finished ones kept for grading. */
export function esportsData() {
  const d = fixture("esports.json");
  let n = 0;
  for (const m of d.matches) if (m.status === "not_started") m.begin_at = soon(n++);
  d.updated = new Date().toISOString();
  return d;
}

function defaultEspn(url) {
  const u = new URL(url);
  const p = u.pathname;
  const sport = /football|\/nfl\b/.test(p) ? "nfl" : /baseball|\/mlb\b/.test(p) ? "mlb" : /tennis/.test(p) ? "tennis" : "nba";
  const team = () => p.split("/teams/")[1]?.split("/")[0];
  const pick = (dir, name, fallback) => fixture(existsSync(join(FX, dir, name)) ? join(dir, name) : join(dir, fallback));
  if (sport === "tennis") {
    if (p.endsWith("/scoreboard")) return p.includes("/atp/") ? tennisScoreboard() : { events: [] };
    if (p.endsWith("/rankings")) return fixture(`tennis/rankings_${p.includes("/wta/") ? "wta" : "atp"}.json`);
    return null;
  }
  if (sport === "nfl" || sport === "mlb") {
    if (p.endsWith("/scoreboard")) {
      if (sport === "mlb") return mlbScoreboard();
      const sb = fixture("nfl/scoreboard.json");
      sb.events.forEach((e, i) => { e.date = new Date(Date.now() + 864e5 + i * 36e5).toISOString(); });
      return sb;
    }
    if (p.endsWith("/standings")) return fixture(`${sport}/standings.json`);
    if (p.endsWith("/injuries")) return sport === "nfl" ? fixture("nfl/injuries.json") : { injuries: [] };
    if (p.endsWith("/transactions")) return { transactions: [] };
    if (p.includes("/roster")) return pick(sport, `roster_${team()}.json`, sport === "nfl" ? "roster_23.json" : "roster_6.json");
    if (p.includes("/schedule")) return pick(sport, `schedule_${team()}.json`, sport === "nfl" ? "schedule_23.json" : "schedule_6.json");
    if (p.endsWith("/summary")) return fixture(`${sport}/summary.json`);
    if (p.endsWith("/gamelog")) return fixture(sport === "nfl" ? "nfl/gamelog.json" : "mlb/gamelog_hitter.json");
    if (p.endsWith("/propBets")) return fixture(`${sport}/props.json`);
    return null;
  }
  if (p.endsWith("/scoreboard")) return futureScoreboard();
  if (p.endsWith("/standings")) return fixture("standings.json");
  if (p.endsWith("/injuries")) return fixture("injuries.json");
  if (p.endsWith("/transactions")) return fixture("transactions.json");
  if (p.includes("/roster")) { const t = team(); return fixture(existsSync(join(FX, `roster_${t}.json`)) ? `roster_${t}.json` : "roster.json"); }
  if (p.includes("/schedule")) { const t = team(); return fixture(existsSync(join(FX, `schedule_${t}.json`)) ? `schedule_${t}.json` : "schedule_8.json"); }
  if (p.endsWith("/summary")) return fixture("summary.json");
  if (p.endsWith("/gamelog")) return fixture("gamelog.json");
  if (p.endsWith("/propBets")) return fixture("props.json");
  return null;
}

/**
 * Start the app.
 *  espn(url) may return: undefined (use default), an object (JSON body), {status, body} (raw response), or "abort".
 *  storage: localStorage entries to set before the app boots (values are written raw if strings).
 */
export async function startApp({ espn = () => undefined, esports = esportsData, storage = {}, viewport = { width: 390, height: 844 }, colorScheme = "dark" } = {}) {
  const browser = await playwright.chromium.launch();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: true, hasTouch: true, serviceWorkers: "block", colorScheme });
  const calls = [];
  await ctx.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("https://app.test/data/esports.json")) {
      calls.push(url);
      const body = await esports();
      if (body === "abort") return route.abort("failed");
      if (body && typeof body === "object" && "status" in body) return route.fulfill({ status: body.status, body: typeof body.body === "string" ? body.body : JSON.stringify(body.body ?? {}), contentType: "application/json" });
      return route.fulfill({ body: JSON.stringify(body), contentType: "application/json" });
    }
    if (url.startsWith("https://app.test/")) {
      let f = new URL(url).pathname; if (f === "/") f = "/index.html";
      const file = join(ROOT, f);
      return existsSync(file) ? route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] || "text/plain" }) : route.fulfill({ status: 404, body: "" });
    }
    if (/espn\.com\/apis|sports\.core\.api\.espn\.com/.test(url)) {
      calls.push(url);
      const custom = await espn(url);
      if (custom === "abort") return route.abort("failed");
      const headers = { "access-control-allow-origin": "*" };
      if (custom && typeof custom === "object" && "status" in custom) return route.fulfill({ status: custom.status, body: typeof custom.body === "string" ? custom.body : JSON.stringify(custom.body ?? {}), headers, contentType: "application/json" });
      const body = custom !== undefined ? custom : defaultEspn(url);
      if (body === null) return route.fulfill({ status: 404, body: "{}", headers });
      return route.fulfill({ body: JSON.stringify(body), contentType: "application/json", headers });
    }
    return route.abort();   // fonts, logos, headshots: not needed offline
  });
  if (Object.keys(storage).length) {
    await ctx.addInitScript((entries) => {
      if (sessionStorage.getItem("__seeded")) return;   // only seed on first load so reload tests see real persistence
      sessionStorage.setItem("__seeded", "1");
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
    }, storage);
  }
  const page = await ctx.newPage();
  const errors = [], dialogs = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto("https://app.test/");
  return { browser, ctx, page, errors, dialogs, calls, close: () => browser.close() };
}

export const toastText = async (page) => {
  await page.waitForSelector("#toast:not([hidden])", { timeout: 5000 });
  return page.textContent("#toast");
};

// Mobile browsers widen the layout viewport to fit overflowing content, so compare against the device width itself.
export const noHorizontalScroll = (page) => {
  const w = page.viewportSize().width;
  return page.evaluate((w) => window.innerWidth <= w + 1 && document.documentElement.scrollWidth <= w + 1, w);
};
