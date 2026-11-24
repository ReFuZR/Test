// Per-sport configuration. ESPN team sports (NBA, NFL, MLB) share one engine; tennis and esports have
// their own data paths but reuse the same pick cards, slip, tracker and two-algorithm cross-check.
//
// Prop markets: only markets the app can both model (from player game logs) and grade (from box scores)
// are listed. `vol` is the opportunity stat the second algorithm projects from (minutes, targets, carries...).

const strip = (s) => String(s || "").replace(/\s*\(incl\. overtime\)\s*$/i, "").trim();

const NBA_LADDER = {
  "Points Milestones": { stats: ["pts"], label: "Points" },
  "Rebounds Milestones": { stats: ["reb"], label: "Rebounds" },
  "Assists Milestones": { stats: ["ast"], label: "Assists" },
  "3-Point Field Goals Milestones": { stats: ["tpm"], label: "3-Pointers" },
  "Points + Rebounds Milestones": { stats: ["pts", "reb"], label: "Pts + Reb" },
  "Points + Assists Milestones": { stats: ["pts", "ast"], label: "Pts + Ast" },
  "Rebounds + Assists Milestones": { stats: ["reb", "ast"], label: "Reb + Ast" },
  "Points + Assists + Rebounds Milestones": { stats: ["pts", "reb", "ast"], label: "PRA" },
};
const NBA_OU = {
  "Total Points": NBA_LADDER["Points Milestones"],
  "Total Rebounds": NBA_LADDER["Rebounds Milestones"],
  "Total Assists": NBA_LADDER["Assists Milestones"],
  "Total 3-Point Field Goals": NBA_LADDER["3-Point Field Goals Milestones"],
  "Total Points and Rebounds": NBA_LADDER["Points + Rebounds Milestones"],
  "Total Points and Assists": NBA_LADDER["Points + Assists Milestones"],
  "Total Assists and Rebounds": NBA_LADDER["Rebounds + Assists Milestones"],
  "Total Points, Rebounds, and Assists": NBA_LADDER["Points + Assists + Rebounds Milestones"],
};

const NFL = {
  passYds: { stats: ["passingYards"], label: "Pass Yds", vol: ["passingAttempts"] },
  passTd: { stats: ["passingTouchdowns"], label: "Pass TDs", vol: ["passingAttempts"] },
  passAtt: { stats: ["passingAttempts"], label: "Pass Att", vol: null },
  passCmp: { stats: ["completions"], label: "Completions", vol: ["passingAttempts"] },
  rushYds: { stats: ["rushingYards"], label: "Rush Yds", vol: ["rushingAttempts"] },
  rushAtt: { stats: ["rushingAttempts"], label: "Carries", vol: null },
  recYds: { stats: ["receivingYards"], label: "Rec Yds", vol: ["receivingTargets"] },
  rec: { stats: ["receptions"], label: "Receptions", vol: ["receivingTargets"] },
  rushRec: { stats: ["rushingYards", "receivingYards"], label: "Rush + Rec Yds", vol: ["rushingAttempts", "receivingTargets"] },
  passRush: { stats: ["passingYards", "rushingYards"], label: "Pass + Rush Yds", vol: ["passingAttempts", "rushingAttempts"] },
  anyTd: { stats: ["rushingTouchdowns", "receivingTouchdowns"], label: "Anytime TD", vol: ["rushingAttempts", "receivingTargets"] },
};

const MLB = {
  hits: { stats: ["hits"], label: "Hits", vol: ["atBats"] },
  runs: { stats: ["runs"], label: "Runs", vol: ["atBats"] },
  rbi: { stats: ["RBIs"], label: "RBIs", vol: ["atBats"] },
  hr: { stats: ["homeRuns"], label: "Home Runs", vol: ["atBats"] },
  hrr: { stats: ["hits", "runs", "RBIs"], label: "Hits + Runs + RBIs", vol: ["atBats"] },
  bb: { stats: ["walks"], label: "Walks", vol: ["atBats"] },
  so: { stats: ["strikeouts"], label: "Strikeouts (batter)", vol: ["atBats"] },
  k: { stats: ["p_strikeouts"], label: "Pitcher Strikeouts", vol: ["p_outs"] },
  ha: { stats: ["p_hits"], label: "Hits Allowed", vol: ["p_outs"] },
  er: { stats: ["p_earnedRuns"], label: "Earned Runs", vol: ["p_outs"] },
  wa: { stats: ["p_walks"], label: "Walks Allowed", vol: ["p_outs"] },
  outs: { stats: ["p_outs"], label: "Outs Recorded", vol: null },
};

export const SPORTS = {
  nba: {
    id: "nba", name: "NBA", kind: "espn", path: "basketball/nba", noun: "game",
    hca: 2.2, sdMargin: 12.5, sdTotal: 18.5, shrinkGames: 8,
    unit: "pts", injuries: true, injuryModel: true,
    // gamelog/box-score names -> short keys used in prop definitions
    alias: { min: ["minutes"], pts: ["points"], reb: ["totalRebounds", "rebounds"], ast: ["assists"], tpm: ["threePointFieldGoalsMade"], stl: ["steals"], blk: ["blocks"] },
    ladder: NBA_LADDER, ou: NBA_OU, defaultVol: ["min"],
    yesNo: { "To Record a Double Double": { kind: "dd", label: "Double-double" }, "To Record a Triple Double": { kind: "td", label: "Triple-double" } },
    statCols: [["pts", "PTS"], ["reb", "REB"], ["ast", "AST"], ["tpm", "3PM"], ["min", "MIN"]],
    oppAdjust: ["pts"],
  },
  nfl: {
    id: "nfl", name: "NFL", kind: "espn", path: "football/nfl", noun: "game",
    hca: 1.5, sdMargin: 13.5, sdTotal: 13, shrinkGames: 4,
    unit: "pts", injuries: true, injuryModel: false,
    alias: {},
    ladder: {
      "Passing Yards Milestones": NFL.passYds, "Passing Touchdown Milestones": NFL.passTd, "Passing Attempts Milestones": NFL.passAtt,
      "Passing Completions Milestones": NFL.passCmp, "Rushing Yards Milestones": NFL.rushYds, "Rushing Attempts Milestones": NFL.rushAtt,
      "Receiving Yards Milestones": NFL.recYds, "Receptions Milestones": NFL.rec, "Rushing + Receiving Yards Milestones": NFL.rushRec,
      "Passing + Rushing Yards Milestones": NFL.passRush,
    },
    ou: {
      "Total Passing Yards": NFL.passYds, "Total Passing Touchdowns": NFL.passTd, "Total Passing Attempts": NFL.passAtt,
      "Total Pass Completions": NFL.passCmp, "Total Rushing Yards": NFL.rushYds, "Total Carries": NFL.rushAtt,
      "Total Receiving Yards": NFL.recYds, "Total Receptions": NFL.rec, "Total Rushing Plus Receiving Yards": NFL.rushRec,
      "Total Passing Plus Rushing Yards": NFL.passRush,
    },
    // one-sided "yes" markets that are really thresholds on a stat
    thresholdMarkets: { "Anytime Touchdown Scorer": { ...NFL.anyTd, threshold: 1 }, "Player to score 2 or more touchdowns": { ...NFL.anyTd, label: "2+ TDs", threshold: 2 } },
    defaultVol: null,
    statCols: [["passingYards", "PASS"], ["rushingYards", "RUSH"], ["receivingYards", "REC"], ["receptions", "CATCH"]],
    oppAdjust: [],
  },
  mlb: {
    id: "mlb", name: "MLB", kind: "espn", path: "baseball/mlb", noun: "game",
    hca: 0.15, sdMargin: 4.3, sdTotal: 4.5, shrinkGames: 20,
    unit: "runs", injuries: true, injuryModel: false,
    alias: {},
    pitcherPrefix: "p_",
    ladder: {
      "Hits Milestones": MLB.hits, "Runs Milestones": MLB.runs, "RBIs Milestones": MLB.rbi, "Home Runs Milestones": MLB.hr,
      "Hits + Runs + RBIs Milestones": MLB.hrr, "Walks (Batter) Milestones": MLB.bb, "Strikeouts (Batter) Milestones": MLB.so,
      "Strikeouts Thrown Milestones": MLB.k,
    },
    ou: {
      "Total Hits": MLB.hits, "Total Runs Scored": MLB.runs, "Total RBIs": MLB.rbi, "Total Hits + Runs + RBIs": MLB.hrr,
      "Total Walks (Batter)": MLB.bb, "Total Strikeouts": MLB.k, "Total Hits Allowed": MLB.ha, "Earned Runs Allowed": MLB.er,
      "Total Walks Allowed": MLB.wa, "Total Outs Recorded": MLB.outs,
    },
    defaultVol: null,
    statCols: [["hits", "H"], ["homeRuns", "HR"], ["RBIs", "RBI"], ["p_strikeouts", "K"]],
    oppAdjust: [],
  },
  tennis: { id: "tennis", name: "Tennis", kind: "tennis", tours: ["atp", "wta"], noun: "match" },
  esports: { id: "esports", name: "Esports", kind: "esports", noun: "match", data: "data/esports.json" },
};

export const SPORT_IDS = Object.keys(SPORTS);

/** Look up a prop market by ESPN's type name, for one sport. */
export function marketFor(sport, rawName) {
  const name = strip(rawName);
  if (sport.ladder?.[name]) return { type: "ladder", ...sport.ladder[name] };
  if (sport.ou?.[name]) return { type: "ou", ...sport.ou[name] };
  if (sport.thresholdMarkets?.[name]) return { type: "threshold", ...sport.thresholdMarkets[name] };
  if (sport.yesNo?.[name]) return { type: "yesno", ...sport.yesNo[name] };
  return null;
}
