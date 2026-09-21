import fs from "node:fs";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { seasonApi } from "../src/api/seasonApi.js";

const SNAPSHOT_PATH = "data/the_call_up_snapshot_v2/mlb-milb-2026-production-v2.json.gz";
const DEFAULT_OUTPUT = "reports/v50-1d-mlb-callup-replacement.json";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function loadSnapshot(path) {
  const bytes = fs.readFileSync(path);
  const text = path.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
  return JSON.parse(text);
}

function setTools(player, value) {
  if (!player) return;
  for (const key of ["contactR", "contactL", "rawPower", "vision", "discipline"]) {
    if (player.hitting && key in player.hitting) player.hitting[key] = value;
  }
  for (const key of ["fielding", "reaction", "armStrength", "armAccuracy"]) {
    if (player.fielding && key in player.fielding) player.fielding[key] = value;
  }
  for (const key of ["speed", "stealing", "baserunning"]) {
    if (player.running && key in player.running) player.running[key] = value;
  }
}

function setEveryFixtureCopy(payload, playerId, value) {
  for (const roster of Object.values(payload.fixture.rosters ?? {})) {
    if (roster.players?.[playerId]) setTools(roster.players[playerId], value);
  }
  for (const league of Object.values(payload.fixture.levelLeagues ?? {})) {
    for (const roster of Object.values(league.rosters ?? {})) {
      if (roster.players?.[playerId]) setTools(roster.players[playerId], value);
    }
  }
  for (const affiliate of Object.values(payload.fixture.organization?.levels ?? {})) {
    if (affiliate.roster?.players?.[playerId]) setTools(affiliate.roster.players[playerId], value);
  }
}

function findStarterId(roster, position) {
  return roster?.lineupSlots?.find((row) => row.position === position)?.starterId ?? null;
}

function timelineEvents(season, type) {
  return (season.careerTimeline?.events ?? []).filter((event) => event.type === type);
}

const verify = process.argv.includes("--verify");
const outputPath = arg("output", DEFAULT_OUTPUT);
const snapshot = loadSnapshot(SNAPSHOT_PATH);
const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
assert.equal(catalog.organizations.length, 30, "Production organization catalog must contain 30 MLB organizations");

const organization = catalog.organizations[0];
const input = {
  name: "v50.1d Callup QA",
  nationality: "대한민국",
  hometown: "구미",
  age: 21,
  heightCm: 180,
  weightKg: 78,
  bodyType: "ATHLETIC",
  bats: "R",
  throws: "R",
  primaryPosition: "CF",
  archetype: "HIT_FIRST",
  visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
  organizationMode: "FAVORITE",
  favoriteOrganizationId: String(organization.id)
};

let season = seasonApi.createCareerSeason({
  seed: "v50-1d-production-callup",
  input,
  masterSnapshot: snapshot
});

assert.equal(season.currentLevel, "AAA", "age-21 Production career must start at AAA");
assert.equal(season.organization.userLevel, "AAA", "organization assignment must start at AAA");

let aaaGamesSimulated = 0;
while (aaaGamesSimulated < 8 && season.currentLevel === "AAA" && season.nextGame) {
  season = seasonApi.simulateCurrentGame(season.seasonId);
  aaaGamesSimulated += 1;
}

const aaaLineBeforeCallup = season.userStatsByLevel.AAA.userSeasonLine;
assert.ok(aaaLineBeforeCallup.G >= 4, `AAA sample too small: G=${aaaLineBeforeCallup.G}`);
assert.ok(aaaLineBeforeCallup.PA >= 12, `AAA sample too small: PA=${aaaLineBeforeCallup.PA}`);
assert.equal(timelineEvents(season, "MLB_DEBUT").length, 0, "MLB debut must not exist before call-up");
assert.equal(timelineEvents(season, "PRO_DEBUT").length, 1, "pro debut must be recorded exactly once before MLB call-up");

let callupMode = "NATURAL";
let preCallupPayload = structuredClone(seasonApi.serializeSeason(season.seasonId));
const userId = String(preCallupPayload.fixture.userPlayerId);
const position = "CF";

if (season.currentLevel === "AAA") {
  callupMode = "FORCED_FALLBACK";
  const mlbRoster = preCallupPayload.fixture.organization.levels.MLB.roster;
  const mlbStarterId = findStarterId(mlbRoster, position);
  assert.ok(mlbStarterId, "MLB CF starter missing before forced fallback");
  assert.notEqual(String(mlbStarterId), userId, "user cannot occupy MLB CF while still assigned to AAA");

  setEveryFixtureCopy(preCallupPayload, userId, 99);
  for (const id of [
    mlbStarterId,
    ...(mlbRoster.bench ?? []).filter((row) => row.coverage?.includes(position)).map((row) => row.playerId)
  ]) {
    if (id) setEveryFixtureCopy(preCallupPayload, String(id), 20);
  }

  season = seasonApi.restoreSeason(preCallupPayload);
  season = seasonApi.runOrganizationReview(season.seasonId, { force: true });
}

assert.equal(season.currentLevel, "MLB", "Production review path did not call user up to MLB");
assert.equal(season.organization.userLevel, "MLB", "organization userLevel did not move to MLB");

const postCallupPayload = seasonApi.serializeSeason(season.seasonId);
const transactions = postCallupPayload.organizationState?.transactions ?? [];
const promotionTransaction = [...transactions].reverse().find(
  (event) => event.type === "PLAYER_PROMOTED"
    && String(event.playerId) === userId
    && event.fromLevel === "AAA"
    && event.toLevel === "MLB"
) ?? null;
assert.ok(promotionTransaction, "AAA->MLB promotion transaction missing");

const replacementTransaction = [...transactions].reverse().find(
  (event) => event.type === "PLAYER_DEMOTED"
    && String(event.playerId) !== userId
    && event.fromLevel === "MLB"
    && event.toLevel === "AAA"
    && event.date === promotionTransaction.date
    && event.position === promotionTransaction.position
) ?? null;
assert.ok(replacementTransaction, "paired MLB incumbent replacement/demotion transaction missing");
assert.equal(replacementTransaction.date, promotionTransaction.date, "promotion/replacement must be atomic on the same review date");

const promotionCareerEvents = timelineEvents(season, "PLAYER_PROMOTED").filter(
  (event) => event.fromLevel === "AAA" && event.toLevel === "MLB"
);
assert.equal(promotionCareerEvents.length, 1, "AAA->MLB career call-up event must be emitted exactly once");
assert.equal(promotionCareerEvents[0].importance, "CAREER", "MLB call-up career event importance drift");

const replacedPlayerId = String(replacementTransaction.playerId);
assert.ok(postCallupPayload.fixture.organization.levels.MLB.roster.players?.[userId], "user missing from MLB roster after call-up");
assert.equal(Boolean(postCallupPayload.fixture.organization.levels.AAA.roster.players?.[userId]), false, "user remained in AAA roster after call-up");
assert.ok(postCallupPayload.fixture.organization.levels.AAA.roster.players?.[replacedPlayerId], "replaced MLB player missing from AAA roster");
assert.equal(Boolean(postCallupPayload.fixture.organization.levels.MLB.roster.players?.[replacedPlayerId]), false, "replaced player remained on MLB roster");

const mlbGamesBefore = season.userStatsByLevel.MLB.userSeasonLine.G;
let mlbSteps = 0;
while (season.currentLevel === "MLB" && season.userStatsByLevel.MLB.userSeasonLine.G === mlbGamesBefore && season.nextGame && mlbSteps < 3) {
  season = seasonApi.simulateCurrentGame(season.seasonId);
  mlbSteps += 1;
}

const mlbLine = season.userStatsByLevel.MLB.userSeasonLine;
assert.ok(mlbLine.G > mlbGamesBefore, "user did not make an MLB appearance within bounded post-callup window");

const mlbDebutEvents = timelineEvents(season, "MLB_DEBUT");
assert.equal(mlbDebutEvents.length, 1, "MLB debut career event must be emitted exactly once");
assert.equal(mlbDebutEvents[0].level, "MLB", "MLB debut event level drift");
assert.ok(mlbDebutEvents[0].gameId, "MLB debut event must reference the official game");
assert.equal(timelineEvents(season, "PRO_DEBUT").length, 1, "pro debut event duplicated after MLB debut");
assert.equal(
  timelineEvents(season, "PLAYER_PROMOTED").filter((event) => event.fromLevel === "AAA" && event.toLevel === "MLB").length,
  1,
  "MLB call-up career event duplicated after first MLB game"
);

const finalPayload = seasonApi.serializeSeason(season.seasonId);
const restored = seasonApi.restoreSeason(structuredClone(finalPayload));
assert.equal(timelineEvents(restored, "MLB_DEBUT").length, 1, "MLB debut event lost/duplicated on restore");
assert.equal(
  timelineEvents(restored, "PLAYER_PROMOTED").filter((event) => event.fromLevel === "AAA" && event.toLevel === "MLB").length,
  1,
  "MLB call-up event lost/duplicated on restore"
);

const report = {
  schema: "THE_CALL_UP_V50_1D_MLB_CALLUP_REPLACEMENT",
  pass: true,
  verified: verify,
  source: "Production Snapshot v2",
  organization: { id: organization.id, name: organization.name },
  aaaSample: { gamesSimulated: aaaGamesSimulated, G: aaaLineBeforeCallup.G, PA: aaaLineBeforeCallup.PA },
  callup: {
    date: promotionTransaction.date,
    userId,
    replacedPlayerId,
    mode: callupMode,
    position,
    transactionType: promotionTransaction.type,
    replacementType: replacementTransaction.type,
    careerEventCount: promotionCareerEvents.length
  },
  mlbDebut: {
    boundedSteps: mlbSteps,
    G: mlbLine.G,
    eventCount: mlbDebutEvents.length,
    date: mlbDebutEvents[0].date,
    gameId: mlbDebutEvents[0].gameId
  },
  restoreRoundTrip: true
};

fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
