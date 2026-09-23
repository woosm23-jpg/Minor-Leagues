import { buildPAContext } from "../pa/context.js";
import { getEffectivePitcherRatings, resolvePitcherUsageRole } from "../game/pitcherFatigue.js";
import { FIELDING_POSITIONS, getFieldingTeam } from "../game/gameState.js";

function asLookup(players) {
  if (players instanceof Map) {
    return (id) => players.get(id);
  }
  if (players && typeof players === "object") {
    return (id) => players[id];
  }
  throw new TypeError("players는 Map 또는 ID-keyed object여야 합니다.");
}

function assertPlayer(player, id) {
  if (!player || typeof player !== "object") {
    throw new RangeError(`Player를 찾을 수 없습니다: ${id}`);
  }
  if (player.id !== id) {
    throw new RangeError(`Player ID가 lookup key와 일치하지 않습니다: ${id}`);
  }
}

function assertSection(player, key) {
  const value = player[key];
  if (!value || typeof value !== "object") {
    throw new TypeError(`${player.id}.${key}가 필요합니다.`);
  }
  return value;
}

/**
 * Convert a canonical Player object into the flat hitter shape consumed by the
 * shared PAContext builder. OVR is deliberately ignored.
 */
function getHitterPAProfile(player) {
  assertPlayer(player, player?.id);
  const hitting = assertSection(player, "hitting");
  const tendencies = assertSection(player, "tendencies");
  const running = player.running ?? { speed: 50 };

  return Object.freeze({
    bats: player.bats,
    contactR: hitting.contactR,
    contactL: hitting.contactL,
    rawPower: hitting.rawPower,
    vision: hitting.vision,
    discipline: hitting.discipline,
    speed: running.speed ?? 50,
    powerUtilizationR: tendencies.powerUtilizationR,
    powerUtilizationL: tendencies.powerUtilizationL,
    launchTendency: tendencies.launchTendency,
    sprayPull: tendencies.sprayPull,
    sprayCenter: tendencies.sprayCenter,
    sprayOppo: tendencies.sprayOppo
  });
}

/**
 * Minimal defensive profile used by the fielder-specific Phase 1 resolver.
 * Position familiarity is carried on the effective Player snapshot. Primary
 * positions are normally 1.0 while secondary-position reps can improve lower
 * familiarity over time without changing the PA probability model.
 */
function getFielderDefenseProfile(player, position, familiarity = 1) {
  assertPlayer(player, player?.id);
  if (!FIELDING_POSITIONS.includes(position)) {
    throw new RangeError(`지원하지 않는 수비 포지션입니다: ${position}`);
  }
  const fielding = assertSection(player, "fielding");
  const running = assertSection(player, "running");
  if (typeof familiarity !== "number" || !Number.isFinite(familiarity) || familiarity <= 0 || familiarity > 1) {
    throw new RangeError("position familiarity는 0 초과 1 이하의 유한한 number여야 합니다.");
  }

  return Object.freeze({
    id: player.id,
    position,
    reaction: fielding.reaction,
    speed: running.speed,
    fielding: fielding.fielding,
    armStrength: fielding.armStrength,
    armAccuracy: fielding.armAccuracy,
    familiarity
  });
}

/**
 * Build a nine-fielder package from authoritative GameState alignment.
 * A missing alignment intentionally falls back to the aggregate neutral defense
 * path so old Phase 0/early Phase 1 games remain backwards compatible.
 */
function buildGameDefensePackage(state, fieldingTeam, lookupPlayer) {
  if (fieldingTeam !== "away" && fieldingTeam !== "home") {
    throw new RangeError("fieldingTeam은 away/home이어야 합니다.");
  }
  if (typeof lookupPlayer !== "function") throw new TypeError("lookupPlayer 함수가 필요합니다.");
  const alignment = state?.defensiveAlignment?.[fieldingTeam];
  if (!alignment) return null;

  const fielders = {};
  for (const position of FIELDING_POSITIONS) {
    const id = alignment[position];
    const player = lookupPlayer(id);
    assertPlayer(player, id);
    const familiarity = player?.positioning?.familiarity?.[position] ?? 1;
    fielders[position] = getFielderDefenseProfile(player, position, familiarity);
  }

  return Object.freeze({
    mode: "FIELDERS",
    fielders: Object.freeze(fielders)
  });
}


/** Minimal running profile for detailed advancement resolution. */
function getRunnerProfile(player) {
  assertPlayer(player, player?.id);
  const running = assertSection(player, "running");
  return Object.freeze({
    id: player.id,
    speed: running.speed,
    stealing: running.stealing ?? 50,
    baserunning: running.baserunning ?? 50
  });
}


function resolvePitcherThrowHand(throws, batterBats = "R") {
  if (throws === "R" || throws === "L") return throws;
  if (throws === "S") {
    if (batterBats === "L" || batterBats === "R") return batterBats;
    return "R";
  }
  throw new RangeError(`pitcher throws는 R/L/S 중 하나여야 합니다: ${throws}`);
}

function getPitcherRunningGameProfile(player) {
  assertPlayer(player, player?.id);
  const pitching = assertSection(player, "pitching");
  return Object.freeze({
    id: player.id,
    throws: resolvePitcherThrowHand(player.throws),
    holdRunner: pitching.holdRunner ?? 50
  });
}

function getCatcherRunningGameProfile(player) {
  assertPlayer(player, player?.id);
  const fielding = assertSection(player, "fielding");
  return Object.freeze({
    id: player.id,
    reaction: fielding.reaction,
    armStrength: fielding.armStrength,
    armAccuracy: fielding.armAccuracy
  });
}

function createRunnerProfileResolver({ players }) {
  const lookup = asLookup(players);
  return (playerId) => {
    const player = lookup(playerId);
    assertPlayer(player, playerId);
    return getRunnerProfile(player);
  };
}

/**
 * Default Stuff accessor. Stuff is a derived value in THE CALL-UP. During
 * Phase 1 it may be supplied as a derived/cache field, but never under the
 * authoritative raw pitcher ratings object. A later arsenal model can replace
 * this accessor without changing GameEngine or PAContext.
 */
function getCachedDerivedStuff(player) {
  const derived = assertSection(player, "derived");
  return derived.stuff;
}

function getPitcherPAProfile(player, getPitcherStuff = getCachedDerivedStuff, gameUsage = null, { startedGame = false } = {}) {
  assertPlayer(player, player?.id);
  const pitching = assertSection(player, "pitching");
  if (typeof getPitcherStuff !== "function") {
    throw new TypeError("getPitcherStuff는 함수여야 합니다.");
  }

  const base = {
    control: pitching.control,
    command: pitching.command,
    movement: pitching.movement,
    stuff: getPitcherStuff(player),
    pitchVelocityMph: pitching.pitchVelocityMph ?? null,
    stamina: pitching.stamina ?? 50,
    role: resolvePitcherUsageRole(pitching.role ?? "SP", { startedGame })
  };
  const effective = gameUsage
    ? getEffectivePitcherRatings({ ...base, pitchCount: gameUsage.pitchCount ?? 0 })
    : base;

  return Object.freeze({
    throws: player.throws,
    control: effective.control,
    command: effective.command,
    movement: effective.movement,
    pitchability: pitching.pitchability,
    stuff: effective.stuff,
    pitchVelocityMph: effective.pitchVelocityMph ?? null,
    fatigue: effective.fatigue ?? 0
  });
}

/**
 * Create the GameEngine resolver that bridges canonical Player objects to the
 * minimal PAContext. This module knows player shapes; GameEngine does not.
 *
 * If GameState carries a defensiveAlignment, the default path resolves all nine
 * actual fielders into the PA context. An explicit resolveDefense callback can
 * still override that behavior for calibration/tests.
 */
function createPlayerContextResolver({
  players,
  getPitcherStuff = getCachedDerivedStuff,
  resolvePark = () => null,
  resolveDefense = null,
  resolveApproach = () => "BALANCED",
  resolvePitchVelocity = () => null
}) {
  const lookup = asLookup(players);
  if (typeof resolvePark !== "function") throw new TypeError("resolvePark는 함수여야 합니다.");
  if (resolveDefense !== null && typeof resolveDefense !== "function") {
    throw new TypeError("resolveDefense는 함수 또는 null이어야 합니다.");
  }
  if (typeof resolveApproach !== "function") throw new TypeError("resolveApproach는 함수여야 합니다.");
  if (typeof resolvePitchVelocity !== "function") throw new TypeError("resolvePitchVelocity는 함수여야 합니다.");

  const resolver = ({ state, batterId, pitcherId }) => {
    const batter = lookup(batterId);
    const pitcher = lookup(pitcherId);
    assertPlayer(batter, batterId);
    assertPlayer(pitcher, pitcherId);

    const fieldingTeam = getFieldingTeam(state);
    const args = { state, batterId, pitcherId, batter, pitcher, fieldingTeam };
    const teamUsage = state.pitcherUsage?.[fieldingTeam] ?? {};
    const gameUsage = teamUsage[pitcherId] ?? null;
    const startedGame = Object.keys(teamUsage)[0] === pitcherId;
    const explicitDefense = resolveDefense ? resolveDefense(args) : null;
    const defense = explicitDefense ?? buildGameDefensePackage(state, fieldingTeam, lookup);

    const rawPitcherProfile = getPitcherPAProfile(pitcher, getPitcherStuff, gameUsage, { startedGame });
    const pitcherProfile = Object.freeze({ ...rawPitcherProfile, throws: resolvePitcherThrowHand(rawPitcherProfile.throws, batter.bats) });
    const selectedPitch = resolvePitchVelocity({ ...args, pitcherProfile });
    const selectedPitchVelocityMph = selectedPitch && typeof selectedPitch === "object" ? selectedPitch.velocityMph ?? null : selectedPitch;
    const selectedPitchType = selectedPitch && typeof selectedPitch === "object" ? selectedPitch.pitchType ?? null : null;

    return buildPAContext({
      hitter: getHitterPAProfile(batter),
      // Quick AB has no selected pitch yet. Do not misuse a pitcher's average
      // velocity as the incoming velocity of every BIP. Full/pitch-by-pitch AB
      // can inject the actual selected pitch velocity through resolvePitchVelocity.
      pitcher: { ...pitcherProfile, pitchType: selectedPitchType, pitchVelocityMph: selectedPitchVelocityMph },
      park: resolvePark(args),
      defense,
      approach: resolveApproach(args)
    });
  };
  resolver.runnerProfileResolver = (playerId) => {
    const player = lookup(playerId);
    assertPlayer(player, playerId);
    return getRunnerProfile(player);
  };
  resolver.runningGameResolver = ({ state, runnerId, pitcherId, fieldingTeam }) => {
    const runner = lookup(runnerId);
    const pitcher = lookup(pitcherId);
    assertPlayer(runner, runnerId);
    assertPlayer(pitcher, pitcherId);
    const catcherId = state?.defensiveAlignment?.[fieldingTeam]?.C ?? null;
    const catcher = catcherId ? lookup(catcherId) : null;
    if (catcherId) assertPlayer(catcher, catcherId);
    return Object.freeze({
      runner: getRunnerProfile(runner),
      pitcher: getPitcherRunningGameProfile(pitcher),
      catcher: catcher
        ? getCatcherRunningGameProfile(catcher)
        : Object.freeze({ id: null, reaction: 50, armStrength: 50, armAccuracy: 50 })
    });
  };
  return resolver;
}

export { getHitterPAProfile, getFielderDefenseProfile, buildGameDefensePackage, getRunnerProfile, resolvePitcherThrowHand, getPitcherRunningGameProfile, getCatcherRunningGameProfile, createRunnerProfileResolver, getCachedDerivedStuff, getPitcherPAProfile, createPlayerContextResolver };
