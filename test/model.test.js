import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "../js/model.js";
import * as D from "../js/data.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} !≈ ${b}`);

test("odds conversions", () => {
  near(M.toDecimal(-110), 1.9091);
  near(M.toDecimal(150), 2.5);
  assert.equal(M.toAmerican(2.5), 150);
  assert.equal(M.toAmerican(1.5), -200);
  near(M.impliedProb(-200), 2 / 3);
  const [a, b] = M.noVig(-110, -110);
  near(a, 0.5); near(b, 0.5);
});

test("distributions", () => {
  near(M.normCdf(0), 0.5, 1e-6);
  near(M.normCdf(1.96), 0.975, 1e-3);
  near(M.poissonAtLeast(1, 2), 1 - Math.exp(-2));
  assert.equal(M.poissonAtLeast(0, 3), 1);
});

test("better team at home is favoured; injuries move the line", () => {
  const good = { wins: 15, losses: 3, ppg: 120, opp: 108 }, bad = { wins: 4, losses: 14, ppg: 108, opp: 119 };
  const p = M.projectGame(good, bad);
  assert.ok(p.pHome > 0.8 && p.margin > 10);
  const hurt = M.projectGame(good, bad, { homeInjury: 5 });
  assert.ok(hurt.margin < p.margin && hurt.pHome < p.pHome);
  near(p.homePts + p.awayPts, p.total);
  assert.ok(M.pCover(p.margin, -5.5) > 0.5);
  assert.ok(M.pOver(230, 220) > 0.5 && M.pOver(210, 220) < 0.5);
});

test("injury impact is zero for bench players and capped for stars", () => {
  assert.equal(M.injuryImpact({ ppg: 4, mpg: 8 }), 0);
  assert.ok(M.injuryImpact({ ppg: 20, rpg: 5, apg: 5, mpg: 33 }) > 2);
  assert.equal(M.injuryImpact({ ppg: 60, rpg: 20, apg: 20, mpg: 40 }), 6);
});

test("prop probability tracks the player's history", () => {
  const scorer = [30, 28, 32, 25, 35, 29, 31, 27, 33, 30, 26, 34];
  const easy = M.propProb(scorer, 20), hard = M.propProb(scorer, 40);
  assert.ok(easy.p > 0.9 && hard.p < 0.1, `${easy.p} ${hard.p}`);
  assert.ok(M.propProb(scorer, 30, 1.1).p > M.propProb(scorer, 30, 0.9).p, "better matchup → higher chance");
  const shooter = [3, 2, 4, 1, 3, 5, 2, 3, 0, 4];
  const r = M.propProb(shooter, 3);
  assert.ok(r.p > 0.35 && r.p < 0.75);
  assert.equal(r.hitL10, 0.6);
  assert.equal(M.propProb([], 10), null);
});

test("double-double probability", () => {
  const big = Array.from({ length: 12 }, (_, i) => ({ pts: 18, reb: i % 3 ? 12 : 8, ast: 2, stl: 1, blk: 2 }));
  const r = M.multiDoubleProb(big, 2);
  assert.ok(r.p > 0.5 && r.p < 0.75);
});

test("parlay math and straight vs parlay comparison", () => {
  const legs = [{ american: -110, pModel: 0.55, eventId: "1" }, { american: -110, pModel: 0.55, eventId: "2" }];
  const m = M.parlayMath(legs);
  near(m.decimal, 1.9091 ** 2, 1e-3);
  assert.equal(m.american, 264);
  near(m.pModel, 0.3025);
  assert.equal(m.sameGame, false);
  const c = M.compareStraightVsParlay(legs, 10);
  near(c.parlay.toWin, 10 * (m.decimal - 1), 1e-6);
  assert.equal(c.straights.length, 2);
  near(c.straightsPAnyWin, 1 - 0.45 * 0.45);
});

test("suggestParlays respects payout floor and one leg per player", () => {
  const legs = [
    { id: "a", eventId: "1", athleteId: "p1", american: -300, pModel: 0.8 },
    { id: "b", eventId: "1", athleteId: "p1", american: -150, pModel: 0.65 },
    { id: "c", eventId: "2", athleteId: "p2", american: -250, pModel: 0.75 },
    { id: "d", eventId: "3", athleteId: "p3", american: 120, pModel: 0.5 },
    { id: "e", eventId: "4", athleteId: "p4", american: -200, pModel: 0.7 },
  ];
  const out = M.suggestParlays(legs, { sizes: [2, 3], minAmerican: 100 });
  assert.ok(out.length >= 1);
  for (const s of out) {
    assert.ok(s.math.decimal >= 2);
    const ps = s.legs.map((l) => l.athleteId);
    assert.equal(new Set(ps).size, ps.length);
  }
});

test("grading and settlement", () => {
  const result = { completed: true, home: { id: "30", score: 111 }, away: { id: "29", score: 117 },
    players: { p1: { pts: 25, reb: 10, ast: 4, tpm: 3, stl: 1, blk: 0, dnp: false }, p2: { dnp: true } } };
  assert.equal(M.gradeLeg({ kind: "ml", side: "away" }, result), "win");
  assert.equal(M.gradeLeg({ kind: "spread", side: "home", line: 6 }, result), "push");
  assert.equal(M.gradeLeg({ kind: "spread", side: "home", line: 5.5 }, result), "loss");
  assert.equal(M.gradeLeg({ kind: "total", side: "over", line: 220.5 }, result), "win");
  assert.equal(M.gradeLeg({ kind: "prop", athleteId: "p1", stats: ["pts", "reb"], threshold: 35 }, result), "win");
  assert.equal(M.gradeLeg({ kind: "dd", athleteId: "p1" }, result), "win");
  assert.equal(M.gradeLeg({ kind: "prop", athleteId: "p2", stats: ["pts"], threshold: 10 }, result), "void");
  assert.equal(M.gradeLeg({ kind: "ml", side: "home" }, { completed: false }), "pending");

  const parlay = { type: "parlay", stake: 10, legs: [{ american: 100, result: "win" }, { american: -110, result: "push" }] };
  const s = M.settleBet(parlay);
  assert.equal(s.status, "win"); near(s.profit, 10);
  assert.equal(M.settleBet({ ...parlay, legs: [{ american: 100, result: "win" }, { american: 100, result: "loss" }] }).status, "loss");
  assert.equal(M.settleBet({ ...parlay, legs: [{ american: 100, result: "win" }, { american: 100, result: "pending" }] }).status, "pending");

  const stats = M.trackerStats([{ ...parlay, ...s, legs: parlay.legs.map((l) => ({ ...l, kind: "prop", pModel: 0.6 })) }]);
  assert.equal(stats.wins, 1); near(stats.roi, 1);
});

// ---------- parsers against real ESPN responses ----------
test("parse scoreboard with DraftKings odds", () => {
  const g = D.parseScoreboard(fx("scoreboard.json"));
  assert.ok(g.length > 0);
  const withOdds = g.find((x) => x.odds);
  assert.ok(withOdds, "some game has odds");
  for (const k of ["homeML", "awayML", "homeSpread", "total"]) assert.ok(Number.isFinite(withOdds.odds[k]), k);
  assert.equal(withOdds.odds.homeSpread, -withOdds.odds.awaySpread);
});

test("parse standings, injuries, transactions, roster", () => {
  const s = D.parseStandings(fx("standings.json"));
  assert.equal(Object.keys(s.teams).length, 30);
  assert.ok(s.leagueOpp > 95 && s.leagueOpp < 130);
  const inj = Object.values(D.parseInjuries(fx("injuries.json"))).flat();
  assert.ok(inj.length && inj.every((p) => p.athleteId && p.status));
  assert.ok(D.parseTransactions(fx("transactions.json")).every((t) => t.description));
  const r = Object.values(D.parseRoster(fx("roster.json")));
  assert.ok(r.length > 10 && r[0].name && r[0].teamId);
});

test("parse game log, props, box score", () => {
  const gl = D.parseGamelog(fx("gamelog.json"));
  assert.ok(gl.length > 5);
  assert.ok(new Date(gl[0].date) >= new Date(gl[1].date), "most recent first");
  assert.ok(gl.every((r) => Number.isFinite(r.pts) && Number.isFinite(r.tpm)));
  const props = D.parseProps(fx("props.json"));
  assert.ok(props.filter((p) => p.kind === "prop").length > 100);
  assert.ok(props.every((p) => p.athleteId && Number.isFinite(p.american)));
  const sum = D.parseSummary(fx("summary.json"));
  assert.equal(sum.completed, true);
  assert.ok(Object.keys(sum.players).length > 15);
  const anyPlayed = Object.values(sum.players).find((p) => !p.dnp);
  assert.ok(Number.isFinite(anyPlayed.pts));
});

test("blend anchors to the market", () => {
  near(M.blend(0.6, 0.8, 0.6), 0.72);
  assert.equal(M.blend(NaN, 0.7), 0.7);
  assert.equal(M.blend(0.4, NaN), 0.4);
  assert.ok(M.fairOneSided(-110) < M.impliedProb(-110));
});
