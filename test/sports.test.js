// NFL, MLB, tennis and esports: parsers against real ESPN / PandaScore data, and the models behind each.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as M from "../js/model.js";
import * as D from "../js/data.js";
import { SPORTS, marketFor } from "../js/sports.js";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} !≈ ${b}`);
const { nfl, mlb, nba } = SPORTS;

describe("generic stat rows", () => {
  test("compound names split on their own separator", () => {
    const r = D.statRow(["hits-atBats", "completions/passingAttempts", "fullInnings.partInnings", "avg", "points"], ["1-3", "30/44", "5.1", ".278", "12"]);
    assert.deepEqual([r.hits, r.atBats, r.completions, r.passingAttempts, r.fullInnings, r.partInnings, r.avg, r.points], [1, 3, 30, 44, 5, 1, 0.278, 12]);
  });
  test("junk values become NaN, not crashes", () => {
    const r = D.statRow(["a", "b-c"], [undefined, "--"]);
    assert.ok(Number.isNaN(r.a) && Number.isNaN(r.b));
    assert.deepEqual(D.statRow(null, null), {});
  });
  test("ESPN's '(incl. overtime)' suffix still matches a market", () => {
    assert.equal(marketFor(nfl, "Total Receiving Yards (incl. overtime)").type, "ou");
    assert.equal(marketFor(nfl, "First Touchdown Scorer"), null, "markets we can't grade are not offered");
    assert.equal(marketFor(mlb, "Total Bases"), null, "box scores lack doubles/triples, so total bases can't be graded");
  });
});

describe("NFL", () => {
  test("props: lines without prices are kept (price unknown), anytime TD is a 1+ threshold", () => {
    const p = D.parseProps(fx("nfl/props.json"), nfl);
    assert.ok(p.length > 200);
    assert.ok(p.every((x) => Number.isNaN(x.american)), "this snapshot is unpriced");
    const td = p.find((x) => x.label === "Anytime TD");
    assert.deepEqual([td.threshold, td.stats], [1, ["rushingTouchdowns", "receivingTouchdowns"]]);
    assert.ok(p.some((x) => x.side === "under" && x.label === "Rec Yds"));
  });
  test("game log, box score and standings", () => {
    const g = D.parseGamelog(fx("nfl/gamelog.json"), nfl);
    assert.ok(g.length >= 5 && Number.isFinite(g[0].receivingYards) && Number.isFinite(g[0].receivingTargets) && g[0].oppId);
    const s = D.parseSummary(fx("nfl/summary.json"), nfl);
    const qb = Object.values(s.players).find((x) => x.passingYards > 100);
    assert.ok(qb && qb.completions > 0 && qb.passingAttempts >= qb.completions && !qb.dnp);
    const st = D.parseStandings(fx("nfl/standings.json"));
    assert.equal(Object.keys(st.teams).length, 32);
    const t = Object.values(st.teams)[0];
    assert.ok(t.ppg > 5 && t.ppg < 45, "points per game derived from season totals");
  });
  test("grouped roster flattens", () => {
    const r = Object.values(D.parseRoster(fx("nfl/roster_23.json")));
    assert.ok(r.length > 40 && r.every((x) => x.id && x.teamId === "23"));
  });
  test("a prop leg grades from the NFL box score", () => {
    const s = D.parseSummary(fx("nfl/summary.json"), nfl);
    const [id, p] = Object.entries(s.players).find(([, x]) => x.receivingYards > 20);
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: id, stats: ["receivingYards"], threshold: p.receivingYards }, s), "win");
    assert.equal(M.gradeLeg({ kind: "prop", athleteId: id, stats: ["receivingYards"], line: p.receivingYards - 0.5, side: "under", threshold: p.receivingYards }, s), "loss");
  });
  test("NFL settings change the projection", () => {
    const a = { wins: 8, losses: 2, ppg: 27, opp: 18 }, b = { wins: 3, losses: 7, ppg: 18, opp: 26 };
    const p = M.projectGame(a, b, {}, nfl);
    assert.ok(p.margin > 5 && p.total > 30 && p.total < 60 && p.pHome > 0.6);
    assert.ok(M.pCover(3, -3, nfl.sdMargin) > 0.45 && M.pCover(3, -3, nfl.sdMargin) < 0.55);
  });
});

describe("MLB", () => {
  test("props: only gradable markets, priced", () => {
    const p = D.parseProps(fx("mlb/props.json"), mlb);
    assert.ok(p.length > 100 && p.every((x) => Number.isFinite(x.american)));
    const labels = new Set(p.map((x) => x.label));
    for (const l of ["Hits", "RBIs", "Home Runs", "Pitcher Strikeouts", "Outs Recorded"]) assert.ok(labels.has(l), l);
    assert.ok(![...labels].some((l) => /Bases|Singles|Doubles|Triples|Stolen/.test(l)));
  });
  test("pitcher logs and box scores are prefixed and count outs", () => {
    const g = D.parseGamelog(fx("mlb/gamelog_pitcher.json"), mlb);
    assert.ok(g.length && "p_strikeouts" in g[0] && !("strikeouts" in g[0]));
    for (const r of g) assert.equal(r.p_outs, Math.trunc(r.p_innings) * 3 + Math.round((r.p_innings % 1) * 10));
    const s = D.parseSummary(fx("mlb/summary.json"), mlb);
    const pitcher = Object.values(s.players).find((x) => x.p_outs > 0);
    assert.equal(pitcher.p_outs, pitcher.p_fullInnings * 3 + pitcher.p_partInnings);
    const batter = Object.values(s.players).find((x) => x.atBats > 0);
    assert.ok(Number.isFinite(batter.hits) && !("p_hits" in batter));
  });
  test("standings nested under leagues and divisions", () => {
    const st = D.parseStandings(fx("mlb/standings.json"));
    assert.equal(Object.keys(st.teams).length, 30);
    assert.ok(st.leagueOpp > 3 && st.leagueOpp < 6, "runs, not points");
  });
});

describe("tennis", () => {
  test("singles only, two players each, winner recorded", () => {
    const m = D.parseTennis(fx("tennis/scoreboard.json"), "atp");
    assert.ok(m.length > 20 && m.every((x) => x.players.length === 2 && /singles/i.test(x.event)));
    const done = m.find((x) => x.completed);
    assert.ok(done.winnerId && done.players.some((p) => p.id === done.winnerId));
  });
  test("rankings match scoreboard player ids", () => {
    const rk = { ...D.parseRankings(fx("tennis/rankings_atp.json")), ...D.parseRankings(fx("tennis/rankings_wta.json")) };
    const ms = D.parseTennis(fx("tennis/scoreboard.json"), "atp");
    assert.ok(ms.filter((m) => m.players.every((p) => rk[p.id])).length > 10);
  });
  test("ranking models favour the better player and stay in range", () => {
    assert.ok(M.tennisPointsProb(10000, 1000) > 0.85);
    assert.ok(M.tennisRankProb(1, 50) > 0.9);
    near(M.tennisPointsProb(2000, 2000), 0.5);
    for (const [a, b] of [[NaN, 5000], [0, 0], [1e9, 1]]) { const p = M.tennisPointsProb(a, b); assert.ok(p >= 0.03 && p <= 0.97); }
    assert.ok(M.tennisRankProb(undefined, 10) < 0.5, "unranked vs ranked");
  });
  test("match-winner grading", () => {
    assert.equal(M.gradeLeg({ kind: "win", pickId: "5" }, { completed: true, winnerId: "5" }), "win");
    assert.equal(M.gradeLeg({ kind: "win", pickId: "5" }, { completed: true, winnerId: "6" }), "loss");
    assert.equal(M.gradeLeg({ kind: "win", pickId: "5" }, { completed: true, winnerId: "" }), "void", "walkover with no winner");
    assert.equal(M.gradeLeg({ kind: "win", pickId: "5" }, { completed: false }), "pending");
    assert.equal(M.gradeLeg({ kind: "win", pickId: "5" }, { canceled: true }), "void");
  });
});

describe("esports", () => {
  test("published file parses; junk entries are dropped", () => {
    const d = D.parseEsports(fx("esports.json"));
    assert.ok(d.matches.length > 20 && d.matches.every((m) => m.teams.length === 2 && m.id));
    assert.ok(d.matches.some((m) => m.state === "pre") && d.matches.some((m) => m.completed && m.winnerId));
    const junk = D.parseEsports({ matches: [null, { id: 1 }, { id: 2, teams: [{ id: 1 }] }, { id: 3, teams: [{}, {}] }, "x"], teams: "no" });
    assert.deepEqual([junk.matches.length, junk.teams], [0, {}]);
    assert.deepEqual(D.parseEsports(null).matches, []);
  });
  test("Elo and form models", () => {
    near(M.eloProb(1500, 1500), 0.5);
    assert.ok(M.eloProb(1700, 1500) > 0.75);
    assert.ok(Number.isNaN(M.eloProb(undefined, 1500)));
    assert.ok(M.formProb(9, 10, 2, 10) > 0.75);
    near(M.formProb(0, 0, 0, 0), 0.5);
    assert.ok(M.formProb(10, 10, 0, 10) <= 0.97);
  });
  test("fair price round-trips the probability", () => {
    near(M.impliedProb(M.fairAmerican(0.6)), 0.6, 0.01);
    assert.equal(M.fairAmerican(0.5), 100);
    assert.ok(Number.isNaN(M.fairAmerican(0)) && Number.isNaN(M.fairAmerican(1)) && Number.isNaN(M.fairAmerican(NaN)));
  });
  test("builder script without a key writes an empty file instead of failing the deploy", () => {
    const out = join(mkdtempSync(join(tmpdir(), "es-")), "esports.json");
    const env = { ...process.env, ESPORTS_OUT: out }; delete env.PANDASCORE_TOKEN;
    const r = spawnSync(process.execPath, [new URL("../scripts/esports.mjs", import.meta.url).pathname], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(d.error && Array.isArray(d.matches) && d.matches.length === 0);
  });
});

describe("second-algorithm variants", () => {
  test("per-opportunity model reacts to a jump in targets", () => {
    const rows = [...Array(4)].map(() => ({ receivingTargets: 10, receivingYards: 80 })).concat([...Array(8)].map(() => ({ receivingTargets: 4, receivingYards: 32 })));
    const vol = (r) => r.receivingTargets, st = (r) => r.receivingYards;
    const b = M.perVolumeProp(rows, 60, st, vol), a = M.propProb(rows.map(st), 60);
    assert.ok(b.p > a.p, `${b.p} > ${a.p}`);
    assert.equal(M.perVolumeProp(rows.slice(0, 2), 60, st, vol), null);
  });
  test("recent model needs 3 games and weighs only the last 5", () => {
    assert.equal(M.recentProp([1, 2], 1), null);
    const hot = M.recentProp([30, 30, 30, 30, 30, 5, 5, 5, 5, 5, 5, 5], 20), season = M.propProb([30, 30, 30, 30, 30, 5, 5, 5, 5, 5, 5, 5], 20);
    assert.ok(hot.p > season.p);
  });
  test("default (NBA) behaviour is unchanged when no sport is passed", () => {
    const t = { wins: 10, losses: 5, ppg: 118, opp: 110 };
    assert.deepEqual(M.projectGame(t, t).margin, M.projectGame(t, t, {}, nba).margin);
  });
});
