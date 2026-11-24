// Edge cases and error paths for the model and the ESPN parsers: bad input must give a safe answer, never throw.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "../js/model.js";
import * as D from "../js/data.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} !≈ ${b}`);
const JUNK = [undefined, null, 0, "", "x", [], {}, NaN, Infinity, -1, true, { events: null }, { events: "x" }, { items: [null, 1, "a", {}] }];

describe("odds parsing", () => {
  test("valid forms", () => {
    assert.equal(M.parseAmerican("+150"), 150);
    assert.equal(M.parseAmerican("-110"), -110);
    assert.equal(M.parseAmerican(" EVEN "), 100);
    assert.equal(M.parseAmerican("ev"), 100);
    assert.equal(M.parseAmerican(-250), -250);
  });
  test("invalid forms are NaN, never a fake price", () => {
    for (const bad of ["", "abc", "1e5", "--110", "+", "50", "-99", 0, 99.9, -50, NaN, Infinity, null, undefined, {}, [], "110abc"]) {
      assert.ok(Number.isNaN(M.parseAmerican(bad)), `accepted ${String(bad)}`);
      assert.ok(Number.isNaN(M.toDecimal(bad)), `toDecimal accepted ${String(bad)}`);
    }
  });
  test("round-trips and formatting", () => {
    for (const a of [-1000, -200, -110, 100, 150, 2500]) assert.ok(Math.abs(M.toAmerican(M.toDecimal(a)) - a) <= 1);
    assert.ok(Number.isNaN(M.toAmerican(1))); assert.ok(Number.isNaN(M.toAmerican(0.5))); assert.ok(Number.isNaN(M.toAmerican(NaN)));
    assert.equal(M.fmtAmerican(150), "+150"); assert.equal(M.fmtAmerican(-110), "-110"); assert.equal(M.fmtAmerican(NaN), "—");
  });
  test("no-vig handles missing sides", () => {
    assert.ok(M.noVig(-110, NaN).every(Number.isNaN));
    const [a, b] = M.noVig(-300, 250); near(a + b, 1, 1e-9); assert.ok(a > b);
    assert.ok(Number.isNaN(M.fairOneSided("junk")));
  });
});

describe("distributions", () => {
  test("normal CDF limits and symmetry", () => {
    assert.equal(M.normCdf(Infinity), 1); assert.equal(M.normCdf(-Infinity), 0); assert.ok(Number.isNaN(M.normCdf(NaN)));
    near(M.normCdf(1) + M.normCdf(-1), 1, 1e-9);
    assert.ok(M.normCdf(-8) >= 0 && M.normCdf(8) <= 1);
  });
  test("poisson guards", () => {
    assert.equal(M.poissonAtLeast(1, 0), 0);
    assert.equal(M.poissonAtLeast(-3, 2), 1);
    assert.ok(Number.isNaN(M.poissonAtLeast(2, -1)));
    assert.ok(Number.isNaN(M.poissonAtLeast(NaN, 2)));
    assert.ok(M.poissonAtLeast(200, 3) >= 0);
    near(M.poissonAtLeast(2.5, 2), M.poissonAtLeast(3, 2), 1e-12);   // "2.5+" means 3 or more
  });
});

describe("blend and consensus", () => {
  test("blend falls back gracefully and stays in range", () => {
    assert.ok(Number.isNaN(M.blend(NaN, NaN)));
    assert.equal(M.blend(1.5, NaN), 0.99);
    assert.equal(M.blend(-1, 0.5, 0.5), 0.01);
    near(M.blend(0.2, 0.8, 0.5), 0.5);
  });
  test("consensus: verified, split, single, none", () => {
    assert.equal(M.consensus(0.6, 0.65).status, "verified");
    assert.equal(M.consensus(0.6, 0.75).status, "split");
    assert.equal(M.consensus(0.6, 0.68).verified, true);    // exactly at tolerance counts as agreement
    assert.equal(M.consensus(0.6, NaN).status, "single");
    assert.equal(M.consensus(undefined, 0.4).p, 0.4);
    assert.equal(M.consensus(NaN, NaN).status, "none");
  });
});

describe("game models with missing or extreme data", () => {
  const good = { wins: 10, losses: 5, ppg: 118, opp: 110 };
  test("missing team data returns null instead of NaN projections", () => {
    assert.equal(M.projectGame(good, null), null);
    assert.equal(M.projectGame(good, { wins: 1 }), null);
    assert.equal(M.projectGame(undefined, undefined), null);
    assert.equal(M.projectGameForm(null, { rating: 1, pf: 110, pa: 108 }), null);
  });
  test("0-0 teams (opening night) are a coin flip plus home court", () => {
    const z = { wins: 0, losses: 0, ppg: 0, opp: 0 };
    assert.equal(M.teamRating(z), 0);
    const p = M.projectGame({ ...z, ppg: 112, opp: 112 }, { ...z, ppg: 112, opp: 112 });
    near(p.margin, M.HOME_COURT); assert.ok(p.pHome > 0.5 && p.pHome < 0.6);
  });
  test("garbage injury numbers are ignored", () => {
    const base = M.projectGame(good, good);
    assert.deepEqual(M.projectGame(good, good, { homeInjury: NaN, awayInjury: "x" }), base);
    assert.equal(M.injuryImpact(), 0);
    assert.equal(M.injuryImpact({ ppg: -10, mpg: 30 }), 0);
    assert.equal(M.injuryImpact({ ppg: NaN, mpg: NaN }), 0);
  });
  test("form rating skips bad rows and shrinks small samples", () => {
    assert.equal(M.formRating([]), null);
    assert.equal(M.formRating(null), null);
    assert.equal(M.formRating([{ pf: NaN, pa: 100 }, null]), null);
    const one = M.formRating([{ home: false, pf: 130, pa: 100, oppId: "1" }]);
    assert.ok(one.rating > 0 && one.rating < 30, "one blowout is heavily shrunk");
    const tough = M.formRating([{ home: true, pf: 100, pa: 102, oppId: "a" }], { a: 10 });
    const weak = M.formRating([{ home: true, pf: 100, pa: 102, oppId: "b" }], { b: -10 });
    assert.ok(tough.rating > weak.rating, "losing close to a great team beats losing to a bad one");
  });
  test("cover/over guards", () => {
    assert.ok(Number.isNaN(M.pCover(NaN, -3)));
    assert.ok(Number.isNaN(M.pOver(220, undefined)));
    near(M.pCover(0, 0), 0.5); near(M.pOver(220, 220), 0.5);
  });
});

describe("prop models with bad game logs", () => {
  test("empty, junk and negative values", () => {
    assert.equal(M.propProb([], 10), null);
    assert.equal(M.propProb(null, 10), null);
    assert.equal(M.propProb([NaN, -5, "x"], 10), null);
    assert.equal(M.propProb([10, 12], NaN), null);
    const r = M.propProb([20, NaN, 22, -1, 25], 15);
    assert.equal(r.n, 3);
  });
  test("probabilities always in (0,1) even for absurd thresholds", () => {
    const xs = [10, 12, 8, 15, 11];
    for (const t of [0, 1, 1000, 0.5]) { const r = M.propProb(xs, t); assert.ok(r.p >= 0.02 && r.p <= 0.98, `${t} → ${r.p}`); }
    assert.ok(M.propProb([0, 0, 0, 0], 1).p <= 0.1, "never scores → low");
    assert.ok(M.propProb(xs, 10, NaN).p === M.propProb(xs, 10, 1).p, "bad opponent factor ignored");
  });
  test("per-minute model needs minutes and 3+ games", () => {
    const st = (r) => r.pts;
    assert.equal(M.perMinuteProp([], 10, st), null);
    assert.equal(M.perMinuteProp([{ min: 30, pts: 20 }, { min: 30, pts: 22 }], 10, st), null);
    assert.equal(M.perMinuteProp([{ min: 0, pts: 20 }, { min: NaN, pts: 1 }, { min: 30 }, { min: 30, pts: 20 }], 10, st), null);
    const rows = [{ min: 36, pts: 30 }, { min: 35, pts: 28 }, { min: 34, pts: 26 }, { min: 20, pts: 14 }, { min: 22, pts: 15 }];
    const r = M.perMinuteProp(rows, 20, st);
    assert.ok(r.p > 0.5 && Number.isFinite(r.projMin));
  });
  test("per-minute model reacts to a minutes jump the season model misses", () => {
    // Bench player just promoted: last 5 games at 34 min vs 14 before
    const rows = [...Array(5)].map(() => ({ min: 34, pts: 17 })).concat([...Array(15)].map(() => ({ min: 14, pts: 7 })));
    const seasonP = M.propProb(rows.map((r) => r.pts), 15).p, minuteP = M.perMinuteProp(rows, 15, (r) => r.pts).p;
    assert.ok(minuteP > seasonP, `${minuteP} should beat ${seasonP}`);
  });
  test("double-double models agree on obvious cases", () => {
    const big = [...Array(12)].map(() => ({ min: 34, pts: 20, reb: 13, ast: 2, stl: 1, blk: 2 }));
    const guard = [...Array(12)].map(() => ({ min: 30, pts: 15, reb: 3, ast: 4, stl: 1, blk: 0 }));
    assert.ok(M.multiDoubleProb(big).p > 0.8 && M.perMinuteMultiDouble(big).p > 0.8);
    assert.ok(M.multiDoubleProb(guard).p < 0.15 && M.perMinuteMultiDouble(guard).p < 0.15);
    assert.equal(M.multiDoubleProb([]), null); assert.equal(M.perMinuteMultiDouble([]), null);
    assert.ok(M.perMinuteMultiDouble(big, 3).p < M.perMinuteMultiDouble(big, 2).p);
  });
});

describe("parlays", () => {
  const L = (id, p, a, ev, ath) => ({ id, pModel: p, american: a, eventId: ev, athleteId: ath, verified: p > 0.6 });
  test("empty and invalid legs", () => {
    assert.equal(M.parlayMath([]), null);
    assert.equal(M.parlayMath(null), null);
    assert.equal(M.parlayMath([{ american: "junk", pModel: 0.5 }]).valid, false);
    assert.equal(M.compareStraightVsParlay([], 10), null);
    assert.equal(M.compareStraightVsParlay([L("a", 0.5, 100, "1")], -5).parlay.stake, 0);
  });
  test("single-leg parlay equals a straight bet", () => {
    const m = M.parlayMath([L("a", 0.5, 100, "1")]);
    near(m.decimal, 2); near(m.ev, 0);
  });
  test("builder: no candidates, all filtered, too few legs", () => {
    assert.deepEqual(M.suggestParlays([]), []);
    assert.deepEqual(M.suggestParlays(null), []);
    assert.deepEqual(M.suggestParlays([L("a", 0.2, 100, "1")]), []);
    assert.deepEqual(M.suggestParlays([L("a", 0.7, 100, "1")], { sizes: [2] }), []);
    assert.deepEqual(M.suggestParlays([L("a", 0.5, 100, "1"), L("b", 0.5, 100, "2")], { verifiedOnly: true }), []);
  });
  test("builder never pairs both sides of the same game line", () => {
    const out = M.suggestParlays([L("h", 0.6, -110, "1"), L("a", 0.55, -110, "1"), L("o", 0.6, -110, "2")], { sizes: [2] });
    assert.ok(out.every((s) => new Set(s.legs.map((l) => l.eventId)).size === s.legs.length));
  });
  test("double-check: exhaustive search is never beaten by the greedy search on the same pool", () => {
    // random slates; the exhaustive search must always find a parlay at least as likely as greedy
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 40; trial++) {
      const cands = [...Array(14)].map((_, i) => L(`c${i}`, 0.35 + rnd() * 0.5, Math.round(-300 + rnd() * 500) || 110, String(i % 7), `p${i}`)).filter((c) => Number.isFinite(M.toDecimal(c.american)));
      for (const k of [2, 3]) {
        const ex = M.suggestParlays(cands, { sizes: [k], minAmerican: 100, pool: 30 })[0];
        const gr = M.greedyParlay(cands, k, 100);
        if (gr) assert.ok(ex && ex.math.pModel >= gr.math.pModel - 1e-12, `trial ${trial} size ${k}`);
      }
    }
  });
  test("greedy returns null when it can't fill or pay", () => {
    assert.equal(M.greedyParlay([], 2), null);
    assert.equal(M.greedyParlay([L("a", 0.9, -900, "1"), L("b", 0.9, -900, "2")], 2, 100), null);
  });
});

describe("grading corner cases", () => {
  const final = (hs, as, players = {}) => ({ completed: true, home: { id: "1", score: hs }, away: { id: "2", score: as }, players });
  test("not final / missing data stays pending", () => {
    assert.equal(M.gradeLeg({ kind: "ml", side: "home" }, null), "pending");
    assert.equal(M.gradeLeg(null, final(100, 90)), "pending");
    assert.equal(M.gradeLeg({ kind: "ml", side: "home" }, { completed: true, home: {}, away: {} }), "pending");
    assert.equal(M.gradeLeg({ kind: "spread", side: "home" }, final(100, 90)), "pending");
    assert.equal(M.gradeLeg({ kind: "weird" }, final(100, 90)), "pending");
  });
  test("ties, pushes and exact lines", () => {
    assert.equal(M.gradeLeg({ kind: "ml", side: "home" }, final(100, 100)), "push");
    assert.equal(M.gradeLeg({ kind: "spread", side: "away", line: 10 }, final(110, 100)), "push");
    assert.equal(M.gradeLeg({ kind: "total", side: "under", line: 210 }, final(110, 100)), "push");
    assert.equal(M.gradeLeg({ kind: "total", side: "under", line: 210.5 }, final(110, 100)), "win");
  });
  test("props: missing stat or player voids, exact threshold wins", () => {
    const res = final(100, 90, { a: { dnp: false, pts: 20, reb: NaN, ast: 5 } });
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: "a", stats: ["pts"], threshold: 20 }, res), "win");
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: "a", stats: ["reb"], threshold: 5 }, res), "void");
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: "a", stats: [], threshold: 5 }, res), "void");
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: "zz", stats: ["pts"], threshold: 5 }, res), "void");
    assert.equal(M.gradeLeg({ kind: "td", athleteId: "a" }, res), "loss");
  });
  test("settlement edge cases", () => {
    assert.deepEqual(M.settleBet({ type: "parlay", stake: 10, legs: [] }), { status: "push", profit: 0 });
    assert.deepEqual(M.settleBet(null), { status: "push", profit: 0 });
    assert.equal(M.settleBet({ type: "parlay", stake: 10, legs: [{ american: 100, result: "void" }, { american: 100, result: "push" }] }).status, "push");
    assert.equal(M.settleBet({ type: "parlay", stake: 10, legs: [{ american: 100, result: "loss" }, { american: 100, result: "pending" }] }).status, "loss", "a loss settles even with legs pending");
    assert.equal(M.settleBet({ type: "straight", stake: 10, legs: [{ american: 100, result: "void" }] }).status, "push");
    const nanStake = M.settleBet({ type: "straight", stake: NaN, legs: [{ american: 100, result: "loss" }] });
    assert.equal(nanStake.status, "loss"); assert.ok(Number.isFinite(nanStake.profit) && nanStake.profit <= 0);
  });
  test("tracker stats on empty and messy input", () => {
    const e = M.trackerStats([]);
    assert.equal(e.roi, 0); assert.equal(e.algo.brierA, null); assert.equal(e.legTotal, 0);
    const m = M.trackerStats([null, { legs: null }, { status: "win", stake: NaN, profit: NaN, legs: [{ result: "win", pModel: 0.7, pA: 0.8, pB: 0.6, verified: true }] }]);
    assert.equal(m.wins, 1); assert.equal(m.staked, 0); assert.ok(Number.isFinite(m.algo.brierA));
    assert.equal(m.algo.verifiedHit, 1);
  });
  test("Brier score rewards the sharper algorithm", () => {
    const legs = [...Array(20)].map((_, i) => ({ result: i < 15 ? "win" : "loss", pA: 0.75, pB: 0.5, pModel: 0.6 }));
    const s = M.trackerStats([{ status: "win", stake: 1, profit: 1, type: "parlay", legs }]);
    assert.ok(s.algo.brierA < s.algo.brierB);
  });
});

describe("parsers never throw on junk", () => {
  test("every parser accepts every junk value", () => {
    for (const j of JUNK) {
      assert.deepEqual(D.parseScoreboard(j), []);
      assert.deepEqual(D.parseStandings(j).teams, {});
      assert.deepEqual(D.parseInjuries(j), {});
      assert.deepEqual(D.parseTransactions(j), []);
      assert.deepEqual(D.parseRoster(j), {});
      assert.deepEqual(D.parseGamelog(j), []);
      assert.deepEqual(D.parseProps(j), []);
      assert.deepEqual(D.parseSchedule(j, "1"), []);
      assert.equal(D.parseSummary(j), null);
    }
  });
  test("scoreboard: partial events are skipped, missing odds tolerated", () => {
    const sb = fx("scoreboard.json");
    const n = D.parseScoreboard(sb).length;
    sb.events.push({ id: "x", competitions: [{ competitors: [{ homeAway: "home", team: { id: 1 } }] }] }, { competitions: [] });
    delete sb.events[0].competitions[0].odds;
    const g = D.parseScoreboard(sb);
    assert.equal(g.length, n); assert.equal(g[0].odds, null);
  });
  test("scoreboard: one-sided spread is mirrored, EVEN parsed", () => {
    const sb = fx("scoreboard.json");
    const o = sb.events[0].competitions[0].odds[0];
    delete o.pointSpread.home; o.moneyline.away.close.odds = "EVEN";
    const g = D.parseScoreboard(sb)[0];
    assert.equal(g.odds.homeSpread, -g.odds.awaySpread); assert.equal(g.odds.awayML, 100);
  });
  test("schedule keeps only completed games with scores, newest first", () => {
    const rows = D.parseSchedule(fx("schedule_8.json"), "8");
    assert.ok(rows.length > 5);
    assert.ok(rows.every((r) => Number.isFinite(r.pf) && Number.isFinite(r.pa) && r.oppId !== "8"));
    assert.ok(new Date(rows[0].date) >= new Date(rows[rows.length - 1].date));
    assert.deepEqual(D.parseSchedule(fx("schedule_8.json"), "nobody"), []);
  });
  test("props: duplicate rungs collapse, bad rows skipped", () => {
    const p = fx("props.json");
    const n = D.parseProps(p).length;
    p.items.push(p.items[0], { athlete: { $ref: "no-id" }, odds: { american: { value: "-110" } } }, { ...p.items[0], odds: { american: { value: "abc" } } });
    assert.equal(D.parseProps(p).length, n);
  });
  test("gamelog without stat names is empty, not wrong", () => {
    const g = fx("gamelog.json"); g.names = ["minutes"];
    assert.deepEqual(D.parseGamelog(g), []);
  });
  test("summary: player with no stats is DNP", () => {
    const s = fx("summary.json");
    const a = s.boxscore.players[0].statistics[0].athletes[0];
    a.stats = [];
    assert.equal(D.parseSummary(s).players[a.athlete.id].dnp, true);
  });
});

describe("network wrapper", () => {
  const url = (k) => `https://example.test/${k}/thing?x=1`;
  test("HTTP errors, 404s, bad JSON, timeouts and offline all become readable errors", async () => {
    const cases = [
      [async () => ({ ok: false, status: 500 }), /error \(500\)/, "http"],
      [async () => ({ ok: false, status: 404 }), /no thing/, "notfound"],
      [async () => ({ ok: true, json: async () => { throw new SyntaxError("x"); } }), /unreadable/, "parse"],
      [async () => ({ ok: true, json: async () => null }), /empty/, "parse"],
      [async () => { throw new TypeError("Failed to fetch"); }, /Can't reach ESPN/, "network"],
      [(u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))), /too long/, "timeout"],
    ];
    let i = 0;
    for (const [fetchImpl, msg, kind] of cases) {
      await assert.rejects(D.getJSON(url(`e${i++}`), 0, { fetchImpl, timeoutMs: 50 }), (e) => msg.test(e.message) && e.kind === kind);
    }
  });
  test("stale cache is served when the network drops", async () => {
    const u = url("stale");
    await D.getJSON(u, 0, { fetchImpl: async () => ({ ok: true, json: async () => ({ v: 1 }) }) });
    const v = await D.getJSON(u, 0, { fetchImpl: async () => { throw new TypeError("offline"); } });
    assert.deepEqual(v, { v: 1 });
  });
  test("cache honours its time-to-live", async () => {
    let calls = 0; const f = async () => ({ ok: true, json: async () => ({ n: ++calls }) });
    const u = url("ttl");
    await D.getJSON(u, 60_000, { fetchImpl: f }); await D.getJSON(u, 60_000, { fetchImpl: f });
    assert.equal(calls, 1);
    D.clearCache();
    await D.getJSON(u, 60_000, { fetchImpl: f });
    assert.equal(calls, 2);
  });
  test("pool isolates failures and respects order", async () => {
    const out = await D.pool([1, 2, 3, 4], 2, async (x) => { if (x === 2) throw new Error("boom"); return x * 10; });
    assert.deepEqual(out, [10, null, 30, 40]);
    assert.deepEqual(await D.pool([], 3, async () => 1), []);
    assert.deepEqual(await D.pool(null, 3, async () => 1), []);
  });
  test("URL builders encode ids", () => {
    assert.ok(!D.URLS.summary("1&x=2").includes("&x=2"));
    assert.ok(D.URLS.roster("a/b").includes("a%2Fb"));
  });
});
