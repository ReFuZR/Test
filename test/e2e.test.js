// End-to-end tests in a phone-sized browser: every network failure, bad response and user mistake
// we could think of should end in a clear message, never a blank screen or a crash.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp, hasBrowser, fixture, futureScoreboard, toastText, noHorizontalScroll } from "./harness.js";

const opts = { skip: !hasBrowser && "Playwright not installed", timeout: 90_000 };
const isScoreboard = (u) => new URL(u).pathname.endsWith("/scoreboard");

async function withApp(cfg, fn) {
  const app = await startApp(cfg);
  try { await fn(app); assert.deepEqual(app.errors, [], `uncaught page errors: ${app.errors.join(" | ")}`); }
  finally { await app.close(); }
}
const gamesReady = (page) => page.waitForSelector(".game .pick[data-leg]", { timeout: 20_000 });
const pendingBet = (legOver = {}) => ({
  id: "seed1", created: Date.now(), type: "straight", stake: 10, toWin: 10, status: "pending", profit: 0,
  legs: [{ id: "401910036|ml|away", eventId: "401910036", kind: "ml", side: "away", label: "MEM ML", american: 100, pModel: 0.55, pA: 0.6, pB: 0.5, verified: false, result: "pending", ...legOver }],
});

describe("happy path", opts, () => {
  test("games render with odds, both algorithms and verified/split checks", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    assert.ok((await page.$$(".game")).length >= 1);
    assert.ok((await page.$$(".pick[data-leg]")).length >= 6);
    await page.waitForSelector(".pick .chk", { timeout: 10_000 });           // form model loaded and cross-checked
    await page.click(".algo summary");
    const algo = await page.textContent(".algo-grid");
    assert.match(algo, /Season model/); assert.match(algo, /Form model/);
    assert.ok(await noHorizontalScroll(page));
  }));

  test("tap a price, it lands in the slip and survives a reload", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click(".pick[data-leg]");
    assert.equal(await page.textContent("#slipCount"), "1");
    await page.reload(); await gamesReady(page);
    assert.equal(await page.textContent("#slipCount"), "1");
    await page.click("[data-tab=slip]");
    await page.waitForSelector(".hero .ring");
  }));

  test("props load with both algorithms and add to slip", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-props]");
    await page.waitForSelector(".player", { timeout: 30_000 });
    assert.ok((await page.$$(".rung")).length > 0);
    assert.ok((await page.$$(".rung .chk")).length > 0, "props show Verified/Split");
    await page.click(".add[data-leg]");
    assert.equal(await page.getAttribute(".add[data-leg]", "aria-pressed"), "true");
  }));

  test("auto-parlay builds and double-checks itself", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=slip]");
    await page.click("[data-risk=safer]");
    await page.click("#verifiedOnly + span");                              // allow split legs too
    await page.click("[data-act=build]");
    await page.waitForFunction(() => !document.querySelector("[data-act=build][disabled]"), null, { timeout: 60_000 });
    const text = await page.textContent(".builder");
    assert.match(text, /Double-check|No combo/);
    if (await page.$("[data-use]")) { await page.click("[data-use]"); await page.waitForSelector(".hero"); }
  }));

  test("works at 320px wide and in light mode", () => withApp({ viewport: { width: 320, height: 640 }, colorScheme: "light" }, async ({ page }) => {
    await gamesReady(page);
    assert.ok(await noHorizontalScroll(page));
    for (const tab of ["props", "slip", "tracker", "news"]) { await page.click(`[data-tab=${tab}]`); await page.waitForTimeout(400); assert.ok(await noHorizontalScroll(page), `overflow on ${tab}`); }
  }));
});

describe("network and server failures", opts, () => {
  test("ESPN server error shows a message, Try again recovers", async () => {
    let fail = true;
    await withApp({ espn: (u) => (fail && isScoreboard(u) ? { status: 500, body: "oops" } : undefined) }, async ({ page }) => {
      await page.waitForSelector(".empty");
      assert.match(await page.textContent(".empty"), /error \(500\)/);
      fail = false;
      await page.click("[data-act=reload]");
      await gamesReady(page);
    });
  });

  test("no network at all", () => withApp({ espn: () => "abort" }, async ({ page }) => {
    await page.waitForSelector(".empty");
    assert.match(await page.textContent(".empty"), /Can't reach ESPN/);
  }));

  test("garbage (non-JSON) response", () => withApp({ espn: (u) => (isScoreboard(u) ? { status: 200, body: "<html>maintenance</html>" } : undefined) }, async ({ page }) => {
    await page.waitForSelector(".empty");
    assert.match(await page.textContent(".empty"), /unreadable/);
  }));

  test("JSON with the wrong shape is treated as no games", () => withApp({ espn: (u) => (isScoreboard(u) ? { events: [{ nope: 1 }, null, "x"] } : undefined) }, async ({ page }) => {
    await page.waitForSelector(".empty");
    assert.match(await page.textContent(".empty"), /Nothing on this date/);
  }));

  test("injury feed down: games still load", () => withApp({ espn: (u) => (u.includes("/injuries") ? { status: 503, body: "" } : undefined) }, async ({ page }) => {
    await gamesReady(page);
  }));

  test("standings down: shows error instead of wrong numbers", () => withApp({ espn: (u) => (u.includes("/standings") ? "abort" : undefined) }, async ({ page }) => {
    await page.waitForSelector(".empty");
  }));

  test("team schedules down: season model still works, no checks shown", () => withApp({ espn: (u) => (u.includes("/schedule") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.waitForTimeout(800);
    assert.equal((await page.$$(".pick .chk")).length, 0);
  }));

  test("props endpoint 404 shows a retry", () => withApp({ espn: (u) => (u.includes("propBets") ? { status: 404, body: "{}" } : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=props]");
    await page.waitForSelector("[data-act=retryProps]", { timeout: 20_000 });
    assert.match(await page.textContent(".empty"), /Props unavailable/);
  }));

  test("props not posted yet", () => withApp({ espn: (u) => (u.includes("propBets") ? { items: [] } : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=props]");
    await page.waitForSelector(".empty", { timeout: 20_000 });
    assert.match(await page.textContent(".empty"), /No props posted/);
  }));

  test("player game logs fail: props screen still renders", () => withApp({ espn: (u) => (u.includes("/gamelog") ? "abort" : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=props]");
    await page.waitForSelector(".empty", { timeout: 30_000 });
  }));

  test("transactions down: injuries tab still works", () => withApp({ espn: (u) => (u.includes("/transactions") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=news]");
    await page.waitForSelector("text=No recent transactions");
  }));
});

describe("odd data from ESPN", opts, () => {
  test("empty slate", () => withApp({ espn: (u) => (isScoreboard(u) ? { events: [] } : undefined) }, async ({ page }) => {
    await page.waitForSelector(".empty");
    assert.match(await page.textContent(".empty"), /Nothing on this date/);
    await page.click("[data-tab=props]");
    await page.waitForSelector("text=No props right now");
  }));

  test("game without odds posted", () => withApp({ espn: (u) => { if (!isScoreboard(u)) return; const sb = futureScoreboard(); sb.events.forEach((e) => delete e.competitions[0].odds); return sb; } }, async ({ page }) => {
    await page.waitForSelector(".game");
    assert.match(await page.textContent(".game"), /Lines aren't posted yet/);
  }));

  test("EVEN and string odds parse", () => withApp({ espn: (u) => { if (!isScoreboard(u)) return; const sb = futureScoreboard(); sb.events[0].competitions[0].odds[0].moneyline.home.close.odds = "EVEN"; return sb; } }, async ({ page }) => {
    await gamesReady(page);
    assert.ok((await page.textContent(".game")).includes("+100"));
  }));

  test("hostile team names are shown as text, never run", () => withApp({ espn: (u) => { if (!isScoreboard(u)) return; const sb = futureScoreboard(); sb.events[0].competitions[0].competitors[0].team.shortDisplayName = '<img src=x onerror="alert(1)">'; return sb; } }, async ({ page, dialogs }) => {
    await gamesReady(page);
    assert.ok((await page.textContent(".game")).includes("<img"));
    assert.equal(await page.$(".game img[src=x]"), null);
    assert.deepEqual(dialogs, []);
  }));

  test("game that already started can't be added", () => withApp({ espn: (u) => { if (!isScoreboard(u)) return; const sb = futureScoreboard(); sb.events.forEach((e) => { e.date = new Date(Date.now() - 600_000).toISOString(); }); return sb; } }, async ({ page }) => {
    await gamesReady(page);
    await page.click(".pick[data-leg]");
    assert.match(await toastText(page), /already started/);
  }));
});

describe("saved data and backups", opts, () => {
  test("corrupted storage doesn't break the app", () => withApp({ storage: { "cp.bets": "{not json", "cp.slip": '{"a":1}', "cp.stake": '"lots"' } }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-tab=tracker]");
    await page.waitForSelector("text=No bets tracked yet");
  }));

  test("malformed bets are dropped, good ones kept", () => withApp({ storage: { "cp.bets": [pendingBet(), { id: "bad" }, { legs: "nope" }, null, { ...pendingBet(), id: "bad2", stake: -5 }] } }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.waitForSelector(".bet");
    assert.equal((await page.$$(".bet")).length, 1);
  }));

  test("finished games grade bets automatically", () => withApp({ storage: { "cp.bets": [pendingBet(), { ...pendingBet({ side: "home", label: "CHA ML", id: "401910036|ml|home" }), id: "seed2" }] } }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.waitForSelector(".pill.win", { timeout: 15_000 });
    await page.waitForSelector(".pill.loss");
    assert.match(await page.textContent(".tiles"), /1-1/);
    assert.match(await page.textContent("main"), /Algorithm check/);
  }));

  test("player who didn't play voids the leg", () => withApp({ storage: { "cp.bets": [pendingBet({ id: "x|prop", kind: "prop", side: undefined, athleteId: "999999", stats: ["pts"], threshold: 10, label: "Nobody 10+ Points" })] } }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.waitForSelector(".pill.push", { timeout: 15_000 });
    assert.match(await page.textContent(".bet"), /DNP, void/);
  }));

  test("grading survives the box-score feed being down", () => withApp({ storage: { "cp.bets": [pendingBet()] }, espn: (u) => (u.includes("/summary") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.click("[data-act=grade]");
    await page.waitForTimeout(800);
    assert.ok(await page.$(".pill.pending"));
  }));

  test("restore rejects junk and accepts a real backup", () => withApp({}, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.setInputFiles("#importFile", { name: "x.json", mimeType: "application/json", buffer: Buffer.from("this is not json") });
    assert.match(await toastText(page), /isn't a tracker backup/);
    await page.setInputFiles("#importFile", { name: "x.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ bets: [{ nope: 1 }] })) });
    assert.match(await toastText(page), /Nothing new/);
    await page.setInputFiles("#importFile", { name: "b.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ bets: [pendingBet()] })) });
    assert.match(await toastText(page), /Restored 1 bet/);
    await page.waitForSelector(".bet");
  }));
});

describe("regressions for bugs found in review", opts, () => {
  const ouOnly = (u) => (u.includes("propBets") ? (u.includes("401909315") ? fixture("props_ou.json") : { items: [] }) : undefined);
  const openBosWsh = async (page) => {
    await gamesReady(page);
    await page.click('[data-props="401909315"]');
    await page.waitForSelector(".player", { timeout: 30_000 });
  };

  test("games with only over/under props now show Over and Under picks", () => withApp({ espn: ouOnly }, async ({ page }) => {
    await openBosWsh(page);
    const labels = await page.$$eval(".rung .what b", (e) => e.map((x) => x.textContent));
    assert.ok(labels.some((t) => t.startsWith("Over ")), labels.join());
    assert.ok(labels.some((t) => t.startsWith("Under ")), labels.join());
    assert.doesNotMatch(await page.textContent("main"), /NaN|undefined/);
  }));

  test("over and under of the same line swap instead of stacking", () => withApp({ espn: ouOnly }, async ({ page }) => {
    await openBosWsh(page);
    const stat = await page.$eval("#propStat option:nth-child(2)", (o) => o.value);
    await page.selectOption("#propStat", stat);             // one stat: both sides of each line are listed
    await page.waitForSelector(".add[data-leg*='|o']");
    const over = await page.$eval(".add[data-leg*='|o']", (b) => b.dataset.leg);
    const under = over.replace(/\|o([\d.]+)$/, "|u$1");
    await page.click(`[data-leg="${over}"]`);
    await page.click(`[data-leg="${under}"]`);
    assert.match(await toastText(page), /Swapped/);
    assert.equal(await page.textContent("#slipCount"), "1");
  }));

  test("editing odds in the slip doesn't change the Props list", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-props]");
    await page.waitForSelector(".player", { timeout: 30_000 });
    const before = await page.textContent(".rung .od");
    await page.click(".add[data-leg]");
    await page.click("[data-tab=slip]");
    await page.fill("#odds-0", "+999"); await page.locator("#odds-0").blur();
    await page.waitForFunction(() => document.querySelector("#odds-0").value === "+999");
    await page.click("[data-tab=props]");
    await page.waitForSelector(".player");
    assert.equal(await page.textContent(".rung .od"), before);
  }));

  test("postponed game voids the bet", () => withApp({
    storage: { "cp.bets": [pendingBet()] },
    espn: (u) => { if (!u.includes("/summary")) return; const s = fixture("summary.json"); s.header.competitions[0].status.type = { name: "STATUS_POSTPONED", completed: false }; return s; },
  }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.waitForSelector(".pill.push", { timeout: 15_000 });
  }));

  test("background grading doesn't poll games that haven't started", () => withApp({
    storage: { "cp.bets": [pendingBet({ start: new Date(Date.now() + 5 * 36e5).toISOString() })] },
  }, async ({ page, calls }) => {
    await gamesReady(page);
    await page.click("[data-tab=tracker]");
    await page.waitForTimeout(800);
    assert.equal(calls.filter((u) => u.includes("/summary")).length, 0);
    await page.click("[data-act=grade]");                   // a manual check still asks
    await page.waitForTimeout(800);
    assert.ok(calls.some((u) => u.includes("/summary")));
  }));

  test("slip legs from games long gone are cleared on open", () => withApp({
    storage: { "cp.slip": [{ ...pendingBet().legs[0], start: new Date(Date.now() - 2 * 864e5).toISOString() }] },
  }, async ({ page }) => {
    assert.match(await toastText(page), /Removed 1 old leg/);
    assert.equal(await page.isHidden("#slipCount"), true);
  }));

  test("rosters down: props explain why instead of saying none are posted", () => withApp({ espn: (u) => (u.includes("/roster") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-props]");
    await page.waitForSelector(".card.empty", { timeout: 30_000 });
    assert.match(await page.textContent(".card.empty"), /rosters/);
  }));

  test("tapping Today refreshes the data", () => withApp({}, async ({ page, calls }) => {
    await gamesReady(page);
    const n = calls.filter(isScoreboard).length;
    await page.click("#dayLabel");
    await gamesReady(page);
    assert.ok(calls.filter(isScoreboard).length > n);
  }));

  test("several legs on one player get a correlation warning", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click("[data-props]");
    await page.waitForSelector(".player .add[data-leg]", { timeout: 30_000 });
    const adds = await page.$$(".player:first-of-type .add[data-leg]");
    await adds[0].click(); await (await page.$$(".player:first-of-type .add[data-leg]"))[1].click();
    await page.click("[data-tab=slip]");
    await page.waitForSelector("text=same player");
  }));
});

describe("user mistakes on the slip", opts, () => {
  async function slipWithLegs(page, n = 2) {
    await gamesReady(page);
    const picks = await page.$$(".pick[data-leg]");
    await picks[0].click();
    if (n > 1) await (await page.$$(".pick[data-leg]"))[6].click();   // a leg from the next game
    await page.click("[data-tab=slip]");
    await page.waitForSelector(".hero");
  }

  test("bad odds are rejected and the old price kept", () => withApp({}, async ({ page }) => {
    await slipWithLegs(page);
    const before = await page.inputValue("#odds-0");
    for (const bad of ["abc", "50", "-99", "0", ""]) {
      await page.fill("#odds-0", bad); await page.press("#odds-0", "Enter"); await page.locator("#odds-0").blur();
      assert.match(await toastText(page), /Odds look like/);
      assert.equal(await page.inputValue("#odds-0"), before);
    }
    await page.fill("#odds-0", "even"); await page.locator("#odds-0").blur();
    await page.waitForFunction(() => document.querySelector("#odds-0").value === "+100");
  }));

  test("zero, negative and huge stakes are refused", () => withApp({}, async ({ page }) => {
    await slipWithLegs(page);
    for (const bad of ["0", "-5", "1000000"]) {
      await page.fill("#stake", bad); await page.locator("#stake").blur();
      assert.match(await toastText(page), /Stake|stake/);
    }
    assert.equal(await page.inputValue("#stake"), "10");
  }));

  test("double-tapping save tracks the bet once", () => withApp({}, async ({ page }) => {
    await slipWithLegs(page);
    await page.evaluate(() => { const b = document.querySelector("[data-save=parlay]"); b.click(); b.click(); });
    await page.waitForSelector(".bet");
    assert.equal((await page.$$(".bet")).length, 1);
  }));

  test("tracking as straights splits the stake", () => withApp({}, async ({ page }) => {
    await slipWithLegs(page);
    await page.click("[data-save=straight]");
    await page.waitForSelector(".bet");
    assert.equal((await page.$$(".bet")).length, 2);
    assert.match(await page.textContent(".bet"), /Stake \$5\.00/);
  }));

  test("both sides of one market can't be in a slip", () => withApp({}, async ({ page }) => {
    await gamesReady(page);
    await page.click('.pick[data-leg$="|ml|home"]');
    await page.click('.pick[data-leg$="|ml|away"]');
    assert.equal(await page.textContent("#slipCount"), "1");
  }));

  test("removing every leg empties the slip cleanly", () => withApp({}, async ({ page }) => {
    await slipWithLegs(page);
    await page.click("[data-remove='0']");
    await page.click("[data-remove='0']");
    await page.waitForSelector("text=Your slip is empty");
    assert.equal(await page.isHidden("#slipCount"), true);
  }));

  test("delete asks for a second tap", () => withApp({ storage: { "cp.bets": [pendingBet()] }, espn: (u) => (u.includes("/summary") ? { status: 500, body: "" } : undefined) }, async ({ page }) => {
    await page.click("[data-tab=tracker]");
    await page.click("[data-del]");
    assert.equal((await page.$$(".bet")).length, 1);
    await page.click("[data-del]");
    await page.waitForSelector("text=No bets tracked yet");
  }));

  test("switching days quickly never shows a stale day", () => withApp({ espn: async (u) => { if (isScoreboard(u) && u.includes("dates=")) { const d = new URL(u).searchParams.get("dates"); if (d.endsWith("0") || d.endsWith("5")) await new Promise((r) => setTimeout(r, 400)); } } }, async ({ page }) => {
    await gamesReady(page);
    for (let i = 0; i < 4; i++) await page.click("#nextDay");
    await page.click("#dayLabel");
    await gamesReady(page);
    assert.equal(await page.textContent("#dayLabel"), "Today");
  }));
});
