// Browser tests for multi-sport, the Prop Finder, tennis and esports.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, hasBrowser, fixture, esportsData, noHorizontalScroll } from "./harness.js";

const opts = { skip: !hasBrowser && "Playwright not installed", timeout: 120_000 };

async function withApp(cfg, fn) {
  const app = await startApp(cfg);
  try { await fn(app); assert.deepEqual(app.errors, [], `uncaught page errors: ${app.errors.join(" | ")}`); }
  finally { await app.close(); }
}
const ready = (page) => page.waitForSelector(".game .pick[data-leg], .card.empty", { timeout: 30_000 });
const go = async (page, sport) => { await page.click(`[data-sport=${sport}]`); await page.waitForFunction(() => !document.querySelector(".skel"), null, { timeout: 30_000 }); await ready(page); };
const finder = async (page) => { await page.click(".tabs [data-tab=finder]"); await page.waitForSelector(".ftable, .card.empty", { timeout: 90_000 }); };
const cells = (page, n) => page.$$eval(`.frow td:nth-child(${n})`, (e) => e.map((x) => x.textContent.trim()));
const pctOf = (s) => (s.startsWith("—") ? null : parseFloat(s) / 100);

describe("sport switcher", opts, () => {
  test("each sport loads its own slate, and the choice survives a reload", () => withApp({}, async ({ page }) => {
    await ready(page);
    await go(page, "nfl");
    assert.match(await page.textContent(".page-head"), /NFL/);
    assert.ok(await page.$(".pick[data-leg]"));
    await page.reload(); await ready(page);
    assert.equal(await page.getAttribute("[data-sport=nfl]", "aria-pressed"), "true");
    assert.match(await page.textContent(".page-head"), /NFL/);
  }));

  test("switching sport mid-load never shows the other sport's games", () => withApp({ espn: async (u) => { if (u.includes("basketball") && u.includes("scoreboard")) await new Promise((r) => setTimeout(r, 800)); } }, async ({ page }) => {
    await page.click("[data-sport=mlb]");
    await ready(page);
    await page.waitForTimeout(1200);
    assert.match(await page.textContent(".page-head"), /MLB/);
    assert.doesNotMatch(await page.textContent("main"), /Pistons|Magic/);
  }));

  test("MLB offseason message when there are no games", () => withApp({ espn: (u) => (u.includes("baseball") && u.includes("scoreboard") ? { events: [] } : undefined) }, async ({ page }) => {
    await go(page, "mlb");
    assert.match(await page.textContent(".card.empty"), /offseason/);
  }));
});

describe("Prop Finder", opts, () => {
  test("lists every prop with hit rates and opens a chart", () => withApp({}, async ({ page }) => {
    await ready(page); await finder(page);
    assert.ok((await page.$$(".frow")).length >= 20);
    await page.click(".frow");
    await page.waitForSelector(".fchart .fcol");
    assert.ok(await page.$(".fline"));
    assert.ok(await noHorizontalScroll(page), "the table scrolls inside its box, not the page");
  }));

  test("default sort is L10 high to low, tapping again flips it", () => withApp({}, async ({ page }) => {
    await ready(page); await finder(page);
    const isDesc = (xs) => xs.every((x, i) => i === 0 || x <= xs[i - 1]);
    const l10 = (await cells(page, 4)).map(pctOf).filter((x) => x !== null);
    assert.ok(isDesc(l10), l10.join());
    await page.click("[data-fsort=l10]");
    const asc = (await cells(page, 4)).map(pctOf).filter((x) => x !== null);
    assert.ok(asc.every((x, i) => i === 0 || x >= asc[i - 1]), asc.join());
  }));

  test("filters: unders only, L10 80%+, stat, verified, search", () => withApp({}, async ({ page }) => {
    await ready(page); await finder(page);
    await page.click("[data-fside=under]");
    const props = await page.$$eval(".frow td.prop", (e) => e.map((x) => x.textContent));
    assert.ok(props.length && props.every((t) => t.startsWith("Under")), props.slice(0, 3).join());
    await page.click("[data-fside=all]");
    await page.click("[data-fmin='0.8']");
    const l10 = (await cells(page, 4)).map(pctOf);
    assert.ok(l10.every((x) => x !== null && x >= 0.8), l10.join());
    await page.click("[data-fmin='0']");
    await page.selectOption("#fstat", "Rebounds");
    assert.ok((await page.$$eval(".frow td.prop", (e) => e.map((x) => x.textContent))).every((t) => /Rebounds/.test(t)));
    await page.click("#fverified + span");
    assert.ok((await page.$$(".frow .chk.split")).length === 0);
    const name = (await page.textContent(".frow td.who b")).trim();
    await page.fill("#fq", name.split(" ").slice(-1)[0]);
    await page.waitForTimeout(500);
    assert.ok((await page.$$eval(".frow td.who b", (e) => e.map((x) => x.textContent))).every((t) => t.includes(name.split(" ").slice(-1)[0])));
    assert.equal(await page.evaluate(() => document.activeElement?.id), "fq", "keyboard stays open while typing");
    await page.fill("#fq", "zzzz nobody"); await page.waitForTimeout(500);
    await page.waitForSelector("text=Loosen a filter");
  }));

  test("add to slip from the chart", () => withApp({}, async ({ page }) => {
    await ready(page); await finder(page);
    await page.click(".frow");
    await page.click(".fdetail [data-leg]");
    assert.equal(await page.textContent("#slipCount"), "1");
    assert.match(await page.textContent(".fdetail [data-leg]"), /Remove/);
  }));

  test("MLB finder shows head-to-head records", () => withApp({}, async ({ page }) => {
    await go(page, "mlb"); await finder(page);
    await page.click("[data-fsort=h2h]");
    assert.match((await cells(page, 7))[0], /\d+%\d+g/);
  }));

  test("NFL props the book hasn't priced show the model's fair price", () => withApp({}, async ({ page }) => {
    await go(page, "nfl"); await finder(page);
    assert.ok((await page.$$eval(".frow td.odds", (e) => e.map((x) => x.textContent))).every((t) => /fair/.test(t)));
    await page.click(".frow"); await page.click(".fdetail [data-leg]");
    await page.click(".tabs [data-tab=slip]");
    await page.waitForSelector("text=no sportsbook price");
  }));

  test("Finder explains itself for tennis and esports", () => withApp({}, async ({ page }) => {
    await go(page, "tennis"); await finder(page);
    assert.match(await page.textContent(".card.empty"), /match winners/);
  }));

  test("props endpoint down: Finder still shows what it could load", () => withApp({ espn: (u) => (u.includes("propBets") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await ready(page); await finder(page);
    assert.match(await page.textContent("main"), /Nothing matches|0 props/);
  }));
});

describe("tennis", opts, () => {
  test("ranked matches get two picks; unranked-vs-unranked gets none", () => withApp({}, async ({ page }) => {
    await go(page, "tennis");
    assert.ok((await page.$$(".pick[data-leg]")).length >= 2);
    const text = await page.textContent("main");
    if ((await page.$$(".game")).length * 2 > (await page.$$(".pick[data-leg]")).length) assert.match(text, /neither player is in the top-150/);
    assert.doesNotMatch(text, /NaN|undefined/);
  }));

  test("a tennis pick grades from ESPN's result", async () => {
    const sb = fixture("tennis/scoreboard.json");
    const done = sb.events[0].groupings.find((g) => /singles/i.test(g.grouping.displayName)).competitions.find((c) => c.status.type.completed);
    const winner = done.competitors.find((c) => c.winner);
    const bet = { id: "t1", created: Date.now(), type: "straight", stake: 10, toWin: 10, status: "pending", profit: 0,
      legs: [{ id: `tennis|${done.id}|win|${winner.id}`, sport: "tennis", tour: "atp", eventId: String(done.id), kind: "win", pickId: String(winner.id), label: "Winner to win", american: 100, pModel: 0.6, start: done.date }] };
    await withApp({ storage: { "cp.bets": [bet] }, espn: (u) => (u.includes("tennis") && u.includes("scoreboard") ? sb : undefined) }, async ({ page }) => {
      await page.click(".tabs [data-tab=tracker]");
      await page.waitForSelector(".pill.win", { timeout: 20_000 });
    });
  });
});

describe("esports", opts, () => {
  test("matches, title filter, live scores", () => withApp({}, async ({ page }) => {
    await go(page, "esports");
    const all = (await page.$$(".game")).length;
    assert.ok(all > 5);
    await page.click("[data-egame='Valorant']");
    const titles = await page.$$eval(".game .status + span", (e) => e.map((x) => x.textContent));
    assert.ok(titles.length < all && titles.every((t) => t.startsWith("Valorant")), titles.join("|"));
    assert.ok(await noHorizontalScroll(page));
  }));

  test("missing data file explains the GitHub setup", () => withApp({ esports: () => ({ status: 404, body: "" }) }, async ({ page }) => {
    await page.click("[data-sport=esports]");
    await page.waitForSelector(".card.empty");
    assert.match(await page.textContent(".card.empty"), /PANDASCORE_TOKEN/);
  }));

  test("file built without a key shows the setup message", () => withApp({ esports: () => ({ updated: new Date().toISOString(), error: "PANDASCORE_TOKEN is not set", games: [], matches: [], teams: {} }) }, async ({ page }) => {
    await page.click("[data-sport=esports]");
    await page.waitForSelector("text=isn't set up yet");
  }));

  test("an esports pick grades from the published results", async () => {
    const d = esportsData();
    const m = d.matches.find((x) => x.status === "finished" && x.winnerId);
    const loser = m.teams.find((t) => t.id !== m.winnerId);
    const bet = { id: "e1", created: Date.now(), type: "straight", stake: 10, toWin: 10, status: "pending", profit: 0,
      legs: [{ id: `esports|${m.id}|win|${loser.id}`, sport: "esports", eventId: String(m.id), kind: "win", pickId: String(loser.id), label: "Loser to win", american: 120, pModel: 0.5, start: m.begin_at }] };
    await withApp({ storage: { "cp.bets": [bet] } }, async ({ page }) => {
      await page.click(".tabs [data-tab=tracker]");
      await page.waitForSelector(".pill.loss", { timeout: 20_000 });
    });
  });
});

describe("cross-sport slip and tracker", opts, () => {
  test("a parlay mixing esports and tennis saves, warns about model prices, and keeps each leg's sport", () => withApp({}, async ({ page }) => {
    await ready(page);
    await (await page.$$(".pick[data-leg]"))[0].click();                    // NBA
    await go(page, "esports"); await page.click(".pick[data-leg]");
    await go(page, "tennis"); await page.click(".pick[data-leg]");
    assert.equal(await page.textContent("#slipCount"), "3");
    await page.click(".tabs [data-tab=slip]");
    await page.waitForSelector("text=no sportsbook price");
    await page.click("[data-save=parlay]");
    await page.waitForSelector(".bet");
    const sports = await page.evaluate(() => JSON.parse(localStorage.getItem("cp.bets"))[0].legs.map((l) => l.sport));
    assert.deepEqual(sports.sort(), ["esports", "nba", "tennis"]);
  }));

  test("tracker breaks hit rate down by sport", async () => {
    const leg = (o) => ({ eventId: "x", kind: "ml", side: "home", american: 100, pModel: 0.5, ...o });
    const bets = [
      { id: "a", created: 1, type: "straight", stake: 10, status: "win", profit: 10, legs: [leg({ id: "a1", sport: "nfl", result: "win" })] },
      { id: "b", created: 2, type: "straight", stake: 10, status: "loss", profit: -10, legs: [leg({ id: "b1", sport: "nba", result: "loss" })] },
    ];
    await withApp({ storage: { "cp.bets": bets } }, async ({ page }) => {
      await page.click(".tabs [data-tab=tracker]");
      await page.waitForSelector("text=Hit rate by sport");
      assert.match(await page.textContent("main"), /NFL/);
    });
  });
});
