import { normalizeSaveUniverse } from "../data/masterSnapshot.js";
import { validateContractState } from "../engine/career/contractState.js";
import { validateRosterControlState } from "../engine/career/rosterControlState.js";

const SAVE_FORMAT = "THE_CALL_UP_SEASON_SAVE";
const SAVE_SCHEMA_VERSION = 2;
const GAME_VERSION = "full_career_roster_rules_v52";
const VALIDATION_MODES = Object.freeze(["LIGHT", "FULL"]);
const ROLE_VALUES = new Set(["STARTER", "PLATOON", "ROTATION", "BENCH", "UTILITY", "CALL_UP_DEPTH", "AAA_STARTER"]);

function clone(value) {
  return structuredClone(value);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}가 필요합니다.`);
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}

function validateHealthState(health, label) {
  if (health === undefined || health === null) return; // legacy v40 states are normalized on restore
  assertObject(health, label);
  if (health.version !== 1) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if (!Number.isFinite(Number(health.durability)) || Number(health.durability) < 20 || Number(health.durability) > 99) throw new RangeError(`${label}.durability가 범위를 벗어났습니다.`);
  const injury = health.activeInjury ?? null;
  if (injury) {
    assertObject(injury, `${label}.activeInjury`);
    if (!Number.isInteger(injury.daysRemaining) || injury.daysRemaining < 1) throw new RangeError(`${label}.activeInjury.daysRemaining이 잘못되었습니다.`);
    assertIsoDate(injury.startDate, `${label}.activeInjury.startDate`);
    assertIsoDate(injury.expectedReturnDate, `${label}.activeInjury.expectedReturnDate`);
  }
}

function validateAgingState(aging, label, { allowMigration = false } = {}) {
  if (aging === undefined || aging === null) return; // v41 legacy states are normalized on restore
  assertObject(aging, label);
  if (aging.version !== 1) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if (!Array.isArray(aging.processedSeasons)) throw new TypeError(`${label}.processedSeasons는 배열이어야 합니다.`);
  if (new Set(aging.processedSeasons).size !== aging.processedSeasons.length) throw new RangeError(`${label}.processedSeasons가 중복됩니다.`);
  for (const key of aging.processedSeasons) if (typeof key !== "string" || !key) throw new TypeError(`${label}.processedSeasons 값이 잘못되었습니다.`);
  assertObject(aging.modifiers, `${label}.modifiers`);
  for (const [key, value] of Object.entries(aging.modifiers)) {
    if (!Number.isFinite(Number(value))) throw new RangeError(`${label}.modifiers.${key}가 유한한 수가 아닙니다.`);
  }
  if (allowMigration && aging.lastMigration !== undefined && aging.lastMigration !== null) {
    assertObject(aging.lastMigration, `${label}.lastMigration`);
    const allowed = new Set(["SS", "2B", "3B", "CF", "LF", "RF"]);
    if (!allowed.has(aging.lastMigration.fromPosition) || !allowed.has(aging.lastMigration.toPosition)) throw new RangeError(`${label}.lastMigration position이 잘못되었습니다.`);
    if (typeof aging.lastMigration.seasonKey !== "string" || !aging.lastMigration.seasonKey) throw new TypeError(`${label}.lastMigration.seasonKey가 필요합니다.`);
  }
}


function validateScoutingState(scouting, label) {
  if (scouting === undefined || scouting === null) return; // v43 and older saves are normalized on restore
  assertObject(scouting, label);
  if (scouting.version !== 1) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if (!Number.isInteger(scouting.randomKey) || scouting.randomKey < 0 || scouting.randomKey > 0xffffffff) throw new RangeError(`${label}.randomKey가 잘못되었습니다.`);
  if (!Number.isFinite(Number(scouting.exposure)) || Number(scouting.exposure) < 0.15 || Number(scouting.exposure) > 0.995) throw new RangeError(`${label}.exposure가 범위를 벗어났습니다.`);
  if (!Number.isInteger(scouting.observations) || scouting.observations < 0) throw new RangeError(`${label}.observations가 잘못되었습니다.`);
  assertIsoDate(scouting.lastUpdateDate, `${label}.lastUpdateDate`);
  if (!Array.isArray(scouting.processedReviews)) throw new TypeError(`${label}.processedReviews는 배열이어야 합니다.`);
  if (new Set(scouting.processedReviews).size !== scouting.processedReviews.length) throw new RangeError(`${label}.processedReviews가 중복됩니다.`);
  if (scouting.processedReviews.length > 24) throw new RangeError(`${label}.processedReviews가 보존 한도를 초과했습니다.`);
}

function validateDevelopmentState(development, label, { positionPlayer = false } = {}) {
  if (development === undefined || development === null) return; // v42 legacy pitcher states may not have this yet
  assertObject(development, label);
  if (development.version !== 2) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if (!Number.isInteger(development.randomKey) || development.randomKey < 0 || development.randomKey > 0xffffffff) throw new RangeError(`${label}.randomKey가 잘못되었습니다.`);
  if (!["LATE_BLOOMER","EARLY_DEVELOPER","HIGH_VARIANCE","POLISHED"].includes(development.hiddenTrait)) throw new RangeError(`${label}.hiddenTrait가 잘못되었습니다.`);
  if (!Number.isFinite(Number(development.rate)) || Number(development.rate) < 0.65 || Number(development.rate) > 1.35) throw new RangeError(`${label}.rate가 범위를 벗어났습니다.`);
  if (!Number.isFinite(Number(development.workEthic)) || Number(development.workEthic) < 0.75 || Number(development.workEthic) > 1.25) throw new RangeError(`${label}.workEthic이 범위를 벗어났습니다.`);
  if (!Number.isFinite(Number(development.trajectory)) || Number(development.trajectory) < 0.65 || Number(development.trajectory) > 1.15) throw new RangeError(`${label}.trajectory가 범위를 벗어났습니다.`);
  if (positionPlayer && !["BALANCED","CONTACT","POWER","PLATE_DISCIPLINE","DEFENSE","SPEED"].includes(development.focus)) throw new RangeError(`${label}.focus가 잘못되었습니다.`);
  for (const key of ["progress","gains","ceilings"]) {
    assertObject(development[key], `${label}.${key}`);
    for (const [tool, value] of Object.entries(development[key])) if (!Number.isFinite(Number(value))) throw new RangeError(`${label}.${key}.${tool}가 유한한 수가 아닙니다.`);
  }
  if (!Array.isArray(development.processedOffseasons)) throw new TypeError(`${label}.processedOffseasons는 배열이어야 합니다.`);
  if (new Set(development.processedOffseasons).size !== development.processedOffseasons.length) throw new RangeError(`${label}.processedOffseasons가 중복됩니다.`);
  for (const key of development.processedOffseasons) if (typeof key !== "string" || !key) throw new TypeError(`${label}.processedOffseasons 값이 잘못되었습니다.`);
  if (development.lastOffseason !== undefined && development.lastOffseason !== null) {
    assertObject(development.lastOffseason, `${label}.lastOffseason`);
    if (!["NORMAL","BREAKOUT","BUST","STAGNATION"].includes(development.lastOffseason.type)) throw new RangeError(`${label}.lastOffseason.type이 잘못되었습니다.`);
    if (typeof development.lastOffseason.seasonKey !== "string" || !development.lastOffseason.seasonKey) throw new TypeError(`${label}.lastOffseason.seasonKey가 필요합니다.`);
  }
}

function assertBasePayload(payload) {
  assertObject(payload, "season save payload");
  if (payload.format !== SAVE_FORMAT) throw new RangeError(`지원하지 않는 save format입니다: ${payload.format}`);
  if (!Number.isInteger(payload.schemaVersion) || payload.schemaVersion < 1) throw new RangeError(`잘못된 save schema입니다: ${payload.schemaVersion}`);
  if (payload.schemaVersion > SAVE_SCHEMA_VERSION) throw new RangeError(`현재 버전보다 새로운 save schema입니다: ${payload.schemaVersion}`);
}

function migrateV1ToV2(payload) {
  const next = clone(payload);
  next.schemaVersion = 2;
  next.gameVersion = GAME_VERSION;
  next.activeGameCheckpoint = null;
  next.activeScheduleGameId = null;
  delete next.activeGame;
  return next;
}

const MIGRATIONS = Object.freeze({ 1: migrateV1ToV2 });

function migrateSeasonSavePayload(payload) {
  assertBasePayload(payload);
  let migrated = clone(payload);
  while (migrated.schemaVersion < SAVE_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[migrated.schemaVersion];
    if (typeof migrate !== "function") throw new RangeError(`save schema ${migrated.schemaVersion} migration이 없습니다.`);
    const before = migrated.schemaVersion;
    migrated = migrate(migrated);
    if (migrated.schemaVersion !== before + 1) throw new RangeError(`save migration이 순차적이지 않습니다: ${before} -> ${migrated.schemaVersion}`);
  }
  return migrated;
}

function validateCommon(payload) {
  assertObject(payload.season, "payload.season");
  assertObject(payload.fixture, "payload.fixture");
  assertObject(payload.playerStates, "payload.playerStates");
  assertObject(payload.pitcherStates, "payload.pitcherStates");
  if (payload.scoutingStates !== undefined && payload.scoutingStates !== null) assertObject(payload.scoutingStates, "payload.scoutingStates");
  if (payload.roleStates !== undefined && payload.roleStates !== null) assertObject(payload.roleStates, "payload.roleStates");
  if (payload.organizationState !== undefined && payload.organizationState !== null) assertObject(payload.organizationState, "payload.organizationState");
  if (payload.careerEventState !== undefined && payload.careerEventState !== null) assertObject(payload.careerEventState, "payload.careerEventState");
  if (payload.contractStates !== undefined && payload.contractStates !== null) assertObject(payload.contractStates, "payload.contractStates");
  if (payload.rosterControlStates !== undefined && payload.rosterControlStates !== null) assertObject(payload.rosterControlStates, "payload.rosterControlStates");
  if (payload.levelSeasons !== undefined && payload.levelSeasons !== null) assertObject(payload.levelSeasons, "payload.levelSeasons");
  if (payload.dataUniverse !== undefined && payload.dataUniverse !== null) normalizeSaveUniverse(payload.dataUniverse, { startDate: payload.fixture?.startDate ?? payload.season?.startDate ?? payload.season?.currentDate, sourceVersion: payload.gameVersion ?? "legacy" });
  if (typeof payload.seasonId !== "string" || !payload.seasonId) throw new TypeError("payload.seasonId가 필요합니다.");
  if (payload.season.seasonId !== payload.seasonId) throw new RangeError("save seasonId가 season state와 일치하지 않습니다.");
  if (payload.fixture.userTeamId !== payload.season.userTeamId) throw new RangeError("save userTeamId가 일치하지 않습니다.");
  if (payload.fixture.userPlayerId !== payload.season.userPlayerId) throw new RangeError("save userPlayerId가 일치하지 않습니다.");
  assertIsoDate(payload.playerStateDate, "payload.playerStateDate");
  assertIsoDate(payload.season.currentDate, "payload.season.currentDate");
  if (!Array.isArray(payload.season.schedule)) throw new TypeError("payload.season.schedule은 배열이어야 합니다.");
  assertObject(payload.season.teams, "payload.season.teams");
  assertObject(payload.season.standings, "payload.season.standings");
  if (!payload.season.teams[payload.fixture.userTeamId]) throw new RangeError("사용자 팀이 season teams에 없습니다.");
  if (!payload.season.standings[payload.fixture.userTeamId]) throw new RangeError("사용자 팀이 standings에 없습니다.");
  if (!payload.playerStates[payload.fixture.userPlayerId]) throw new RangeError("사용자 player state가 없습니다.");
}

function validateActiveGame(payload) {
  const checkpoint = payload.activeGameCheckpoint ?? null;
  const activeScheduleGameId = payload.activeScheduleGameId ?? null;
  if (!checkpoint && activeScheduleGameId !== null) throw new RangeError("activeScheduleGameId가 있지만 checkpoint가 없습니다.");
  if (!checkpoint) return;
  assertObject(checkpoint, "payload.activeGameCheckpoint");
  if (checkpoint.format !== "THE_CALL_UP_GAME_CHECKPOINT" || checkpoint.schemaVersion !== 1) throw new RangeError("active game checkpoint format/schema가 호환되지 않습니다.");
  if (typeof checkpoint.state?.gameId !== "string" || checkpoint.state.gameId !== checkpoint.gameId) throw new RangeError("active checkpoint state gameId가 일치하지 않습니다.");
  if (checkpoint.boxScore?.gameId !== checkpoint.gameId) throw new RangeError("active checkpoint boxScore gameId가 일치하지 않습니다.");
  const rng = checkpoint.rng;
  if (!rng || rng.version !== 1 || rng.algorithm !== "mulberry32-v1" || !Number.isInteger(rng.state) || rng.state < 0 || rng.state > 0xffffffff || !Number.isSafeInteger(rng.counter) || rng.counter < 0) {
    throw new RangeError("active checkpoint RNG state가 호환되지 않습니다.");
  }
  if (typeof activeScheduleGameId !== "string" || !activeScheduleGameId) throw new TypeError("active checkpoint에는 activeScheduleGameId가 필요합니다.");
  if (checkpoint.gameId !== activeScheduleGameId) throw new RangeError("active checkpoint gameId와 schedule gameId가 일치하지 않습니다.");
  if (checkpoint.state?.status !== "IN_PROGRESS") throw new RangeError("save의 active checkpoint는 진행 중 경기여야 합니다.");
  if (checkpoint.fixture?.userPlayerId !== payload.fixture.userPlayerId) throw new RangeError("active checkpoint userPlayerId가 시즌과 일치하지 않습니다.");
  const activeLevel = payload.activeLevel ?? checkpoint.fixture?.level ?? "AAA";
  if (!["A", "HIGH_A", "AA", "AAA", "MLB"].includes(activeLevel)) throw new RangeError(`지원하지 않는 activeLevel입니다: ${activeLevel}`);
  const activeSeason = payload.levelSeasons?.[activeLevel] ?? (activeLevel === "AAA" ? payload.season : null);
  const scheduleGame = activeSeason?.schedule?.find((game) => game.gameId === activeScheduleGameId);
  if (!scheduleGame) throw new RangeError("active checkpoint가 해당 레벨 season schedule에 없습니다.");
  if (scheduleGame.status === "FINAL") throw new RangeError("완료된 schedule game을 active checkpoint로 저장할 수 없습니다.");
}

function validateFull(payload) {
  const teamIds = new Set(Object.keys(payload.season.teams));
  const rosterMembership = new Map();
  for (const [teamId, roster] of Object.entries(payload.fixture.rosters ?? {})) {
    if (!teamIds.has(teamId)) throw new RangeError(`fixture roster 팀이 season teams에 없습니다: ${teamId}`);
    for (const playerId of Object.keys(roster.players ?? {})) {
      const previous = rosterMembership.get(playerId);
      if (previous && previous !== teamId) throw new RangeError(`선수가 여러 roster에 중복 소속되어 있습니다: ${playerId}`);
      rosterMembership.set(playerId, teamId);
    }
  }
  for (const game of payload.season.schedule) {
    if (!teamIds.has(game.awayTeamId) || !teamIds.has(game.homeTeamId)) throw new RangeError(`schedule game의 팀 참조가 잘못되었습니다: ${game.gameId}`);
    if (game.awayTeamId === game.homeTeamId) throw new RangeError(`동일 팀 경기입니다: ${game.gameId}`);
  }
  for (const teamId of teamIds) {
    if (!payload.season.standings[teamId]) throw new RangeError(`standings 행이 없습니다: ${teamId}`);
  }
  if (payload.activeGameCheckpoint) {
    const level = payload.activeLevel ?? payload.activeGameCheckpoint.fixture?.level ?? "AAA";
    const activeSeason = payload.levelSeasons?.[level] ?? (level === "AAA" ? payload.season : null);
    const game = activeSeason?.schedule?.find((item) => item.gameId === payload.activeScheduleGameId);
    if (!game) throw new RangeError("active checkpoint schedule game을 찾을 수 없습니다.");
    if (payload.activeGameCheckpoint.fixture?.teams?.away?.id !== game.awayTeamId) throw new RangeError("active checkpoint 원정팀이 schedule과 일치하지 않습니다.");
    if (payload.activeGameCheckpoint.fixture?.teams?.home?.id !== game.homeTeamId) throw new RangeError("active checkpoint 홈팀이 schedule과 일치하지 않습니다.");
  }
  if (payload.levelSeasons) {
    // AAA/MLB are required for v23+ legacy compatibility. v29 additionally serializes High-A alongside A/AA, but old schema-v2 saves remain valid and are backfilled
    // by Season API restore before the next save.
    for (const required of ["AAA", "MLB"]) {
      if (!payload.levelSeasons[required]) throw new RangeError(`levelSeasons.${required}가 필요합니다.`);
    }
    for (const [level, levelSeason] of Object.entries(payload.levelSeasons)) {
      if (!["A", "HIGH_A", "AA", "AAA", "MLB"].includes(level)) throw new RangeError(`지원하지 않는 levelSeasons 레벨입니다: ${level}`);
      assertObject(levelSeason, `levelSeasons.${level}`);
      assertObject(levelSeason.teams, `levelSeasons.${level}.teams`);
      if (!Array.isArray(levelSeason.schedule)) throw new TypeError(`levelSeasons.${level}.schedule은 배열이어야 합니다.`);
      const league = payload.fixture.levelLeagues?.[level];
      if (league && levelSeason.userTeamId !== league.userTeamId) throw new RangeError(`levelSeasons.${level}.userTeamId가 fixture와 일치하지 않습니다.`);
      if (levelSeason.userPlayerId !== payload.fixture.userPlayerId) throw new RangeError(`levelSeasons.${level}.userPlayerId가 일치하지 않습니다.`);
    }
  }
  for (const [playerId, contractState] of Object.entries(payload.contractStates ?? {})) {
    validateContractState(contractState, `payload.contractStates.${playerId}`);
    if (contractState.playerId !== playerId) throw new RangeError(`contract state playerId가 key와 일치하지 않습니다: ${playerId}`);
  }
  for (const [playerId, rosterState] of Object.entries(payload.rosterControlStates ?? {})) {
    validateRosterControlState(rosterState, `payload.rosterControlStates.${playerId}`);
    if (rosterState.playerId !== playerId) throw new RangeError(`roster-control playerId가 key와 일치하지 않습니다: ${playerId}`);
  }
  for (const [playerId, playerState] of Object.entries(payload.playerStates ?? {})) {
    validateHealthState(playerState.health, `payload.playerStates.${playerId}.health`);
    validateAgingState(playerState.aging, `payload.playerStates.${playerId}.aging`, { allowMigration: true });
    validateDevelopmentState(playerState.development, `payload.playerStates.${playerId}.development`, { positionPlayer: true });
    if (playerState.positionFamiliarity !== undefined) {
      assertObject(playerState.positionFamiliarity, `payload.playerStates.${playerId}.positionFamiliarity`);
      for (const [position, value] of Object.entries(playerState.positionFamiliarity)) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0.35 || value > 1) throw new RangeError(`position familiarity가 범위를 벗어났습니다: ${playerId}:${position}`);
      }
    }
    if (playerState.positionReps !== undefined) {
      assertObject(playerState.positionReps, `payload.playerStates.${playerId}.positionReps`);
      for (const [position, value] of Object.entries(playerState.positionReps)) {
        if (!Number.isInteger(value) || value < 0) throw new RangeError(`position reps가 잘못되었습니다: ${playerId}:${position}`);
      }
    }
  }
  if (payload.roleStates) {
    for (const [playerId, roleState] of Object.entries(payload.roleStates)) {
      assertObject(roleState, `payload.roleStates.${playerId}`);
      if (roleState.playerId !== playerId) throw new RangeError(`role state playerId가 key와 일치하지 않습니다: ${playerId}`);
      if (!ROLE_VALUES.has(roleState.role)) throw new RangeError(`지원하지 않는 role입니다: ${roleState.role}`);
      if (typeof roleState.level !== "string" || !roleState.level) throw new TypeError(`role state level이 필요합니다: ${playerId}`);
      if (typeof roleState.momentum !== "number" || !Number.isFinite(roleState.momentum) || roleState.momentum < -1 || roleState.momentum > 1) {
        throw new RangeError(`role momentum이 -1~1 범위를 벗어났습니다: ${playerId}`);
      }
    }
  }
  for (const [playerId, pitcherState] of Object.entries(payload.pitcherStates ?? {})) {
    validateHealthState(pitcherState.health, `payload.pitcherStates.${playerId}.health`);
    validateAgingState(pitcherState.aging, `payload.pitcherStates.${playerId}.aging`);
    validateDevelopmentState(pitcherState.development, `payload.pitcherStates.${playerId}.development`);
  }
  for (const [playerId, scoutingState] of Object.entries(payload.scoutingStates ?? {})) {
    validateScoutingState(scoutingState, `payload.scoutingStates.${playerId}`);
  }
  if (payload.careerEventState) {
    const career = payload.careerEventState;
    if (career.schemaVersion !== 1) throw new RangeError("career event state schema가 호환되지 않습니다.");
    if (!Number.isInteger(career.nextSequence) || career.nextSequence < 1) throw new RangeError("career event nextSequence가 잘못되었습니다.");
    if (!Array.isArray(career.events)) throw new TypeError("careerEventState.events는 배열이어야 합니다.");
    if (career.completedMomentKeys !== undefined && !Array.isArray(career.completedMomentKeys)) throw new TypeError("careerEventState.completedMomentKeys는 배열이어야 합니다.");
    const allowedMomentKeys = new Set(["PRO_DEBUT", "MLB_DEBUT", "FIRST_MLB_HIT", "FIRST_MLB_HR", "FIRST_MLB_RBI", "FIRST_MLB_SB"]);
    for (const key of career.completedMomentKeys ?? []) if (!allowedMomentKeys.has(key)) throw new RangeError(`지원하지 않는 career moment key입니다: ${key}`);
    if (career.nextSequence !== career.events.length + 1) throw new RangeError("career event nextSequence가 events와 일치하지 않습니다.");
    career.events.forEach((event, index) => {
      assertObject(event, `careerEventState.events[${index}]`);
      if (event.schemaVersion !== 1) throw new RangeError("career event schema가 호환되지 않습니다.");
      if (event.sequence !== index + 1) throw new RangeError("career event sequence가 연속적이지 않습니다.");
      if (event.eventId !== `career_event_${String(index + 1).padStart(6, "0")}`) throw new RangeError("career eventId가 sequence와 일치하지 않습니다.");
      if (!["CAREER_STARTED", "LEVEL_ASSIGNED", "PLAYER_PROMOTED", "PLAYER_DEMOTED", "ROLE_CHANGED", "PRO_DEBUT", "MLB_DEBUT", "FIRST_MLB_HIT", "FIRST_MLB_HR", "FIRST_MLB_RBI", "FIRST_MLB_SB"].includes(event.type)) throw new RangeError(`지원하지 않는 career event입니다: ${event.type}`);
      if (!["MINOR", "NORMAL", "MAJOR", "CAREER"].includes(event.importance)) throw new RangeError(`지원하지 않는 career event importance입니다: ${event.importance}`);
      if (event.playerId !== payload.fixture.userPlayerId) throw new RangeError("career timeline에는 사용자 선수 event만 저장할 수 있습니다.");
      assertIsoDate(event.date, "career event date");
      if (!Array.isArray(event.reasonCodes ?? [])) throw new TypeError("career event reasonCodes는 배열이어야 합니다.");
      if (event.momentKey !== undefined && event.momentKey !== null && !allowedMomentKeys.has(event.momentKey)) throw new RangeError(`지원하지 않는 career moment key입니다: ${event.momentKey}`);
      if (event.careerOnce !== undefined && typeof event.careerOnce !== "boolean") throw new TypeError("career event careerOnce는 boolean이어야 합니다.");
      if (event.gameContext !== undefined && event.gameContext !== null) {
        assertObject(event.gameContext, "career event gameContext");
        if (!["GAME", "PA", "RUNNING"].includes(event.gameContext.kind)) throw new RangeError(`지원하지 않는 career gameContext kind입니다: ${event.gameContext.kind}`);
        if (event.gameContext.inning !== null && event.gameContext.inning !== undefined && (!Number.isInteger(event.gameContext.inning) || event.gameContext.inning < 1)) throw new RangeError("career gameContext inning이 잘못되었습니다.");
        if (event.gameContext.half !== null && event.gameContext.half !== undefined && !["TOP", "BOTTOM"].includes(event.gameContext.half)) throw new RangeError("career gameContext half가 잘못되었습니다.");
        if (event.gameContext.userSide !== null && event.gameContext.userSide !== undefined && !["away", "home"].includes(event.gameContext.userSide)) throw new RangeError("career gameContext userSide가 잘못되었습니다.");
        for (const key of ["scoreBefore", "scoreAfter"]) {
          const score = event.gameContext[key];
          if (score !== null && score !== undefined) {
            assertObject(score, `career gameContext ${key}`);
            if (!Number.isInteger(score.away) || score.away < 0 || !Number.isInteger(score.home) || score.home < 0) throw new RangeError(`career gameContext ${key}가 잘못되었습니다.`);
          }
        }
      }
    });
  }
  if (payload.organizationState) {
    const orgState = payload.organizationState;
    if (orgState.schemaVersion !== 1) throw new RangeError("organization review state schema가 호환되지 않습니다.");
    assertIsoDate(orgState.lastReviewDate, "payload.organizationState.lastReviewDate");
    if (orgState.lastTransactionDate !== null && orgState.lastTransactionDate !== undefined) assertIsoDate(orgState.lastTransactionDate, "payload.organizationState.lastTransactionDate");
    if (!Array.isArray(orgState.transactions)) throw new TypeError("organizationState.transactions는 배열이어야 합니다.");
    for (const event of orgState.transactions) {
      if (!["PLAYER_PROMOTED", "PLAYER_DEMOTED"].includes(event?.type)) throw new RangeError("지원하지 않는 organization transaction event입니다.");
      if (typeof event.playerId !== "string" || !event.playerId) throw new TypeError("organization transaction playerId가 필요합니다.");
      assertIsoDate(event.date, "organization transaction date");
    }
  }
  const careerProfile = payload.fixture.careerProfile ?? null;
  if (careerProfile) {
    if (careerProfile.schemaVersion !== 1) throw new RangeError("careerProfile schema가 호환되지 않습니다.");
    assertObject(careerProfile.identity, "fixture.careerProfile.identity");
    const identity = careerProfile.identity;
    for (const key of ["name", "nationality", "hometown", "bats", "throws", "primaryPosition", "bodyType"]) {
      if (typeof identity[key] !== "string" || !identity[key]) throw new TypeError(`careerProfile.identity.${key}가 필요합니다.`);
    }
    if (!Number.isInteger(identity.age) || identity.age < 18 || identity.age > 22) throw new RangeError("careerProfile age가 범위를 벗어났습니다.");
    if (!Number.isInteger(identity.heightCm) || identity.heightCm < 160 || identity.heightCm > 205) throw new RangeError("careerProfile height가 범위를 벗어났습니다.");
    if (!Number.isInteger(identity.weightKg) || identity.weightKg < 55 || identity.weightKg > 125) throw new RangeError("careerProfile weight가 범위를 벗어났습니다.");
    if (!["1B","2B","3B","SS","LF","CF","RF"].includes(identity.primaryPosition)) throw new RangeError("careerProfile primaryPosition이 지원 범위가 아닙니다.");
    if (!["R","L","S"].includes(identity.bats) || !["R","L"].includes(identity.throws)) throw new RangeError("careerProfile bats/throws가 잘못되었습니다.");
    if (!["LEAN","AVERAGE","ATHLETIC","STURDY","POWER_FRAME"].includes(identity.bodyType)) throw new RangeError("careerProfile bodyType이 잘못되었습니다.");
    if (typeof careerProfile.archetype !== "string" || !careerProfile.archetype) throw new TypeError("careerProfile archetype이 필요합니다.");
    if (!Array.isArray(careerProfile.visibleTraits) || careerProfile.visibleTraits.length > 2 || new Set(careerProfile.visibleTraits).size !== careerProfile.visibleTraits.length) throw new RangeError("careerProfile visibleTraits가 잘못되었습니다.");
    assertObject(careerProfile.startingProfile, "fixture.careerProfile.startingProfile");
    assertObject(careerProfile.organizationChoice, "fixture.careerProfile.organizationChoice");
    const organizationChoiceTeamId = String(careerProfile.organizationChoice.teamId);
    if (payload.fixture.worldMode === "PRODUCTION_REAL") {
      const productionOrganizationId = payload.fixture.organization?.organizationId;
      if (productionOrganizationId === undefined || productionOrganizationId === null || String(productionOrganizationId) === "") {
        throw new RangeError("production careerProfile 검증에 organizationId가 필요합니다.");
      }
      if (organizationChoiceTeamId !== String(productionOrganizationId)) {
        throw new RangeError("careerProfile 조직과 production organizationId가 일치하지 않습니다.");
      }
      const mlbAffiliateTeamId = payload.fixture.organization?.levels?.MLB?.team?.id;
      if (mlbAffiliateTeamId !== undefined && mlbAffiliateTeamId !== null && String(mlbAffiliateTeamId) !== String(productionOrganizationId)) {
        throw new RangeError("production organizationId와 MLB 조직 팀이 일치하지 않습니다.");
      }
    } else if (organizationChoiceTeamId !== String(payload.fixture.userTeamId)) {
      throw new RangeError("careerProfile 조직과 userTeamId가 일치하지 않습니다.");
    }
    if (!["RANDOM","FAVORITE"].includes(careerProfile.organizationChoice.mode)) throw new RangeError("careerProfile organization mode가 잘못되었습니다.");
  }

  const organization = payload.fixture.organization ?? null;
  if (organization) {
    if (!Array.isArray(organization.levelOrder) || !organization.levelOrder.length) throw new TypeError("organization.levelOrder가 필요합니다.");
    assertObject(organization.levels, "fixture.organization.levels");
    if (!organization.levels[organization.userLevel]) throw new RangeError("organization userLevel이 levels에 없습니다.");
    const seenOrgPlayers = new Set();
    const seenAffiliateTeams = new Set();
    for (const level of organization.levelOrder) {
      const affiliate = organization.levels[level];
      assertObject(affiliate, `fixture.organization.levels.${level}`);
      assertObject(affiliate.team, `fixture.organization.levels.${level}.team`);
      assertObject(affiliate.roster, `fixture.organization.levels.${level}.roster`);
      if (affiliate.level !== level) throw new RangeError(`organization level key가 일치하지 않습니다: ${level}`);
      if (seenAffiliateTeams.has(affiliate.team.id)) throw new RangeError(`organization affiliate team이 중복됩니다: ${affiliate.team.id}`);
      seenAffiliateTeams.add(affiliate.team.id);
      for (const playerId of Object.keys(affiliate.roster.players ?? {})) {
        if (seenOrgPlayers.has(playerId)) throw new RangeError(`organization 레벨 간 선수가 중복됩니다: ${playerId}`);
        seenOrgPlayers.add(playerId);
      }
    }
    if (!organization.levels[organization.userLevel].roster?.players?.[payload.fixture.userPlayerId]) {
      throw new RangeError("사용자 선수가 organization userLevel roster에 없습니다.");
    }
  }
}

function validateMigratedPayload(payload, mode = "LIGHT") {
  if (!VALIDATION_MODES.includes(mode)) throw new RangeError(`지원하지 않는 validation mode입니다: ${mode}`);
  if (payload.schemaVersion !== SAVE_SCHEMA_VERSION) throw new RangeError(`지원하지 않는 save schema입니다: ${payload.schemaVersion}`);
  validateCommon(payload);
  validateActiveGame(payload);
  if (mode === "FULL") validateFull(payload);
  return payload;
}

function serializeSeasonSession(session, { activeGameCheckpoint = null } = {}) {
  assertObject(session, "season session");
  assertObject(session.fixture, "session.fixture");
  assertObject(session.state, "session.state");
  const payload = clone({
    format: SAVE_FORMAT,
    schemaVersion: SAVE_SCHEMA_VERSION,
    gameVersion: GAME_VERSION,
    seasonId: session.state.seasonId,
    deterministicSeed: session.fixture.seed,
    fixture: session.fixture,
    season: session.state,
    levelSeasons: session.levelStates ?? { AAA: session.state },
    playerStates: session.playerStates,
    pitcherStates: session.pitcherStates,
    scoutingStates: session.scoutingStates ?? null,
    dataUniverse: session.dataUniverse ?? null,
    roleStates: session.roleStates ?? null,
    organizationState: session.organizationState ?? null,
    careerEventState: session.careerEventState ?? null,
    contractStates: session.contractStates ?? null,
    rosterControlStates: session.rosterControlStates ?? null,
    leagueEcologyState: session.leagueEcologyState ?? null,
    playerStateDate: session.playerStateDate,
    activeGameCheckpoint,
    activeScheduleGameId: activeGameCheckpoint ? session.activeScheduleGameId : null,
    activeLevel: activeGameCheckpoint ? (session.activeLevel ?? activeGameCheckpoint.fixture?.level ?? "AAA") : null
  });
  validateMigratedPayload(payload, "LIGHT");
  return payload;
}

function restoreSeasonSession(payload) {
  const migrated = migrateSeasonSavePayload(payload);
  validateMigratedPayload(migrated, "LIGHT");
  const restored = clone(migrated);
  return {
    fixture: restored.fixture,
    state: restored.season,
    levelStates: restored.levelSeasons ?? null,
    playerStates: restored.playerStates,
    pitcherStates: restored.pitcherStates,
    scoutingStates: restored.scoutingStates ?? null,
    dataUniverse: normalizeSaveUniverse(restored.dataUniverse ?? null, { startDate: restored.fixture?.startDate ?? restored.season?.startDate ?? restored.season?.currentDate, sourceVersion: restored.gameVersion ?? "legacy" }),
    roleStates: restored.roleStates ?? null,
    organizationState: restored.organizationState ?? null,
    careerEventState: restored.careerEventState ?? null,
    contractStates: restored.contractStates ?? null,
    rosterControlStates: restored.rosterControlStates ?? null,
    leagueEcologyState: restored.leagueEcologyState ?? null,
    playerStateDate: restored.playerStateDate,
    activeGameId: null,
    activeScheduleGameId: restored.activeScheduleGameId,
    activeLevel: restored.activeLevel ?? null,
    finalizedActiveGameId: null,
    activeFixture: null,
    activeGameCheckpoint: restored.activeGameCheckpoint
  };
}

function validateSeasonSavePayload(payload, { mode = "LIGHT" } = {}) {
  const migrated = migrateSeasonSavePayload(payload);
  validateMigratedPayload(migrated, mode);
  return true;
}

const seasonSaveFormat = Object.freeze({ format: SAVE_FORMAT, schemaVersion: SAVE_SCHEMA_VERSION, gameVersion: GAME_VERSION });

export { migrateSeasonSavePayload, serializeSeasonSession, restoreSeasonSession, validateSeasonSavePayload, seasonSaveFormat };
