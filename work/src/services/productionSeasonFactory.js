import { createPhase1Hitter, createPhase1Pitcher } from "../engine/player/playerFixtures.js";
import { importSnapshotSchedule, generateFutureProductionSchedule } from "../engine/season/schedule.js";
import { validateMasterSnapshot } from "../data/masterSnapshot.js";
import { isPlayerGameAvailable, playerAssignedLevel, playerAssignedTeamId, playerAvailability, playerOrganizationId, playerRosterStatus } from "../data/rosterAvailability.js";
import { inferRealPlayerPotentialProfile } from "../data/realWorldPotential.js";
import { buildProductionPitchArsenalIndex, createGeneratedRandomArsenal, normalizeInferredPitchArsenal } from "./productionPitchArsenal.js";
import { createGeneratedDurability, createGeneratedHitterStyle, createGeneratedPitcherStyle } from "./productionStyleFallback.js";

const PRODUCTION_WORLD_VERSION = 1;
const PRODUCTION_LEVELS = Object.freeze(["MLB", "AAA", "AA", "HIGH_A", "A"]);
const LINEUP_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]);
const DEFENSE_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);
const MIN_PRODUCTION_HITTERS = 10; // 9 starters + at least 1 real bench player
const MIN_PRODUCTION_PITCHERS = 8; // 5 starters + at least 3 bullpen arms

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clampRating(value, fallback = 50) {
  const n = Number(value);
  return Math.max(20, Math.min(99, Math.round(Number.isFinite(n) ? n : fallback)));
}

function normalizePosition(value) {
  const p = String(value ?? "DH").toUpperCase().replaceAll(" ", "");
  if (["C","1B","2B","3B","SS","LF","CF","RF","DH"].includes(p)) return p;
  if (["OF","OUTFIELD"].includes(p)) return "CF";
  if (["IF","INF","INFIELD"].includes(p)) return "2B";
  if (p === "P") return "P";
  return "DH";
}

function legacySecondaryPositions(primary) {
  const map = {
    C: {}, "1B": { DH: 1, LF: 0.55 }, "2B": { SS: 0.78, "3B": 0.70 },
    "3B": { "1B": 0.78, "2B": 0.62 }, SS: { "2B": 0.90, "3B": 0.80 },
    LF: { RF: 0.84, CF: 0.68 }, CF: { LF: 0.92, RF: 0.92 }, RF: { LF: 0.84, CF: 0.68 },
    DH: { "1B": 0.50 }
  };
  return map[primary] ?? {};
}

const ADJACENT_POSITION_FAMILIARITY = Object.freeze({
  C: Object.freeze({}),
  "1B": Object.freeze({ "3B": 0.42, LF: 0.38, RF: 0.38 }),
  "2B": Object.freeze({ SS: 0.58, "3B": 0.48 }),
  "3B": Object.freeze({ "1B": 0.68, "2B": 0.46, SS: 0.40 }),
  SS: Object.freeze({ "2B": 0.72, "3B": 0.62 }),
  LF: Object.freeze({ RF: 0.72, CF: 0.48 }),
  CF: Object.freeze({ LF: 0.84, RF: 0.84 }),
  RF: Object.freeze({ LF: 0.72, CF: 0.48 }),
  DH: Object.freeze({})
});

function positionEvidenceWeight(row) {
  const innings = Number(row?.innings);
  if (Number.isFinite(innings) && innings > 0) return innings;

  const games = Number(row?.games);
  if (Number.isFinite(games) && games > 0) return games * 9;

  return 0;
}

function resolveProductionPositionProfile(player, inference) {
  const primary = normalizePosition(player?.position);
  const rows = Array.isArray(inference?.positionFamiliarity)
    ? inference.positionFamiliarity
    : [];

  const evidence = new Map();

  for (const row of rows) {
    const position = normalizePosition(row?.position);

    if (
      !DEFENSE_POSITIONS.includes(position) &&
      position !== "DH"
    ) {
      continue;
    }

    const weight = positionEvidenceWeight(row);
    if (!(weight > 0)) continue;

    evidence.set(
      position,
      (evidence.get(position) ?? 0) + weight
    );
  }

  if (!evidence.size) {
    const secondary = legacySecondaryPositions(primary);

    return freeze({
      source: "LEGACY_HEURISTIC",
      primaryPosition: primary,
      actualPositions: [primary],
      inferredPositions: [],
      familiarity: {
        [primary]: 1,
        ...secondary
      },
      secondaryPositions: secondary,
      coverage: [
        primary,
        ...Object.keys(secondary)
      ].filter(
        (position, index, all) =>
          DEFENSE_POSITIONS.includes(position) &&
          all.indexOf(position) === index
      )
    });
  }

  const maxWeight = Math.max(...evidence.values());
  const familiarity = {};
  const actualPositions = new Set([
    primary,
    ...evidence.keys()
  ]);

  for (const [position, weight] of evidence.entries()) {
    if (position === primary) {
      familiarity[position] = 1;
      continue;
    }

    familiarity[position] = Number(
      Math.max(
        0.55,
        Math.min(
          0.98,
          0.55 + 0.45 * Math.sqrt(weight / maxWeight)
        )
      ).toFixed(3)
    );
  }

  familiarity[primary] = 1;

  const inferredPositions = new Set();

  for (const sourcePosition of actualPositions) {
    const sourceFamiliarity = Number(
      familiarity[sourcePosition] ??
      (sourcePosition === primary ? 1 : 0.7)
    );
    const adjacent =
      ADJACENT_POSITION_FAMILIARITY[sourcePosition] ?? {};

    for (const [target, factor] of Object.entries(adjacent)) {
      if (actualPositions.has(target)) continue;

      const derived = Number(
        Math.max(
          0.35,
          Math.min(
            0.49,
            sourceFamiliarity * Number(factor)
          )
        ).toFixed(3)
      );

      if (
        derived >
        Number(familiarity[target] ?? 0)
      ) {
        familiarity[target] = derived;
      }
      inferredPositions.add(target);
    }
  }

  const secondaryPositions = Object.fromEntries(
    Object.entries(familiarity)
      .filter(([position]) => position !== primary)
  );

  return freeze({
    source:
      inferredPositions.size > 0
        ? "REAL_POSITION_EVIDENCE_WITH_ADJACENT_INFERENCE"
        : "REAL_POSITION_EVIDENCE",
    primaryPosition: primary,
    actualPositions: [...actualPositions],
    inferredPositions: [...inferredPositions],
    familiarity,
    secondaryPositions,
    coverage: Object.keys(familiarity).filter(
      (position) => DEFENSE_POSITIONS.includes(position)
    )
  });
}

function productionFacts(
  player,
  hiddenDevelopmentPrior = null,
  {
    durability = null,
    pitcherRoleEvidence = null
  } = {}
) {
  return freeze({
    physical: {
      age: player.age == null ? null : Number(player.age),
      birthDate: player.birthDate ?? null,
      height: player.height ?? null,
      weight: player.weight == null ? null : Number(player.weight),
      durability:
        durability?.rating == null
          ? null
          : Number(durability.rating)
    },
    realWorld: {
      sourceTeamId: playerAssignedTeamId(player),
      sourceLevel: playerAssignedLevel(player),
      organizationId: player.organizationId ?? null,
      rosterStatus: playerRosterStatus(player),
      availability: playerAvailability(player),
      on40Man: player.on40Man ?? null,
      mlbActive: player.mlbActive ?? null,
      injuryListType: player.injuryListType ?? null,
      mlbDebutDate: player.mlbDebutDate ?? null,
      sourceId: player.sourceId ?? null,
      durabilitySource:
        durability?.source ?? null,
      pitcherRoleSource:
        pitcherRoleEvidence
          ? "REAL_GAMES_STARTS_INNINGS_EVIDENCE"
          : null,
      pitcherRoleEvidence:
        pitcherRoleEvidence ?? null,
      hiddenDevelopmentPrior
    }
  });
}

function hitterInferenceView(inference) {
  return inference?.type === "TWO_WAY"
    ? inference.hitterProfile
    : inference;
}

function pitcherInferenceView(inference) {
  return inference?.type === "TWO_WAY"
    ? inference.pitcherProfile
    : inference;
}

function isProductionPitcherInference(inference) {
  return (
    inference?.type === "PITCHER" ||
    inference?.type === "TWO_WAY"
  );
}

function isProductionHitterInference(inference) {
  return inference?.type !== "PITCHER";
}

function mergeTwoWayEnginePlayer(
  hitterEngine,
  pitcherEngine,
  inference
) {
  return freeze({
    ...pitcherEngine,
    id: hitterEngine.id,
    bats: hitterEngine.bats,
    throws: hitterEngine.throws,
    ovr: Math.max(
      Number(hitterEngine.ovr ?? 20),
      Number(pitcherEngine.ovr ?? 20)
    ),
    hitting: hitterEngine.hitting,
    tendencies:
      hitterEngine.tendencies,
    fielding:
      hitterEngine.fielding,
    running:
      hitterEngine.running,
    positioning:
      hitterEngine.positioning,
    physical:
      hitterEngine.physical,
    realWorld: freeze({
      ...(hitterEngine.realWorld ?? {}),
      ...(pitcherEngine.realWorld ?? {}),
      durabilitySource:
        hitterEngine.realWorld
          ?.durabilitySource ??
        pitcherEngine.realWorld
          ?.durabilitySource ??
        null,
      hiddenDevelopmentPrior:
        hitterEngine.realWorld
          ?.hiddenDevelopmentPrior ??
        pitcherEngine.realWorld
          ?.hiddenDevelopmentPrior ??
        null,
      pitcherRoleSource:
        pitcherEngine.realWorld
          ?.pitcherRoleSource ??
        null,
      pitcherRoleEvidence:
        pitcherEngine.realWorld
          ?.pitcherRoleEvidence ??
        null,
      twoWay: true,
      twoWayEvidence:
        inference?.twoWayEvidence ??
        null,
      twoWayHitterOverall:
        inference?.hitterOverall ??
        inference?.hitterProfile
          ?.overall ??
        null,
      twoWayPitcherOverall:
        inference?.pitcherOverall ??
        inference?.pitcherProfile
          ?.overall ??
        null
    })
  });
}

function engineHitter(player, inference, { seed = "" } = {}) {
  const r = inference?.ratings ?? {};
  const positionProfile =
    resolveProductionPositionProfile(
      player,
      inference
    );
  const primaryPosition =
    positionProfile.primaryPosition;
  const style = createGeneratedHitterStyle({ seed, playerId: String(player.id) });
  const engine = createPhase1Hitter({
    id: String(player.id), bats: player.bats ?? "R", throws: player.throws ?? "R", ovr: clampRating(inference?.overall),
    contactR: clampRating(r.contactR), contactL: clampRating(r.contactL), rawPower: clampRating(r.rawPower),
    vision: clampRating(r.vision), discipline: clampRating(r.discipline),
    powerUtilizationR: clampRating(r.powerUtilizationR), powerUtilizationL: clampRating(r.powerUtilizationL),
    launchTendency: style.launchTendency, sprayPull: style.sprayPull, sprayCenter: style.sprayCenter, sprayOppo: style.sprayOppo,
    speed: clampRating(r.speed), stealing: clampRating(r.stealing), baserunning: clampRating(r.baserunning),
    fielding: clampRating(r.fielding), reaction: clampRating(r.reaction), armStrength: clampRating(r.armStrength), armAccuracy: clampRating(r.armAccuracy),
    primaryPosition, secondaryPositions: positionProfile.secondaryPositions, adaptability: 55
  });
  const hiddenDevelopmentPrior = inferRealPlayerPotentialProfile({ player: engine, sourcePlayer: player, inference, seed });
  const durability = createGeneratedDurability({
    seed,
    playerId: String(player.id),
    kind: "HITTER"
  });
  return freeze({
    ...engine,
    ...productionFacts(
      player,
      hiddenDevelopmentPrior,
      { durability }
    )
  });
}

function enginePitcher(player, inference, { seed = "", pitchArsenal = [] } = {}) {
  const r = inference?.ratings ?? {};
  const style = createGeneratedPitcherStyle({ seed, playerId: String(player.id) });
  const engine = createPhase1Pitcher({
    id: String(player.id), throws: player.throws ?? "R", ovr: clampRating(inference?.overall),
    control: clampRating(r.control), command: clampRating(r.command), movement: clampRating(r.movement),
    pitchability: clampRating(r.pitchability), stuff: clampRating(r.stuff),
    pitchVelocityMph: r.pitchVelocityMph == null ? null : Number(r.pitchVelocityMph),
    stamina: clampRating(r.stamina), role: inference?.role ?? "RP", holdRunner: style.holdRunner, fielding: style.fielding, reaction: style.reaction, armStrength: style.armStrength, armAccuracy: style.armAccuracy
  });
  const hiddenDevelopmentPrior = inferRealPlayerPotentialProfile({ player: engine, sourcePlayer: player, inference, seed });
  const durability = createGeneratedDurability({
    seed,
    playerId: String(player.id),
    kind: "PITCHER"
  });
  return freeze({
    ...engine,
    pitchArsenal,
    ...productionFacts(
      player,
      hiddenDevelopmentPrior,
      {
        durability,
        pitcherRoleEvidence:
          inference?.roleEvidence ?? null
      }
    )
  });
}

function positionFit(
  player,
  slot,
  inference
) {
  if (slot === "DH") return 1;

  const profile =
    resolveProductionPositionProfile(
      player,
      inference
    );

  const familiarity =
    Number(
      profile.familiarity?.[slot] ?? 0
    );

  if (!(familiarity > 0)) return 0;

  const exact =
    (profile.actualPositions ?? [])
      .includes(slot);

  return exact
    ? 5 + familiarity
    : 2 + familiarity;
}

function pickLineup(
  hitters,
  inferenceById
) {
  const defensivePositions =
    LINEUP_POSITIONS.filter(
      (position) =>
        position !== "DH"
    );

  const overall = (player) =>
    Number(
      inferenceById.get(
        String(player.id)
      )?.overall ?? 50
    );

  const candidatesByPosition =
    Object.fromEntries(
      defensivePositions.map(
        (position) => [
          position,
          hitters
            .map((player) => ({
              player,
              fit: positionFit(
                player,
                position,
                inferenceById.get(
                  String(player.id)
                )
              ),
              overall: overall(player)
            }))
            .filter(
              (row) => row.fit > 0
            )
            .sort(
              (a, b) =>
                b.fit - a.fit ||
                b.overall - a.overall ||
                String(a.player.id)
                  .localeCompare(
                    String(b.player.id)
                  )
            )
        ]
      )
    );

  for (
    const position of
    defensivePositions
  ) {
    if (
      !candidatesByPosition[position]
        .length
    ) {
      throw new RangeError(
        `production roster에 ${position} 수비 가능 선수가 없습니다.`
      );
    }
  }

  const orderedPositions =
    [...defensivePositions].sort(
      (a, b) =>
        candidatesByPosition[a].length -
          candidatesByPosition[b].length ||
        defensivePositions.indexOf(a) -
          defensivePositions.indexOf(b)
    );

  const playerToPosition = new Map();
  const positionToPlayer = new Map();

  function augment(
    position,
    seenPlayers
  ) {
    for (
      const row of
      candidatesByPosition[position]
    ) {
      const playerId =
        String(row.player.id);

      if (
        seenPlayers.has(playerId)
      ) {
        continue;
      }
      seenPlayers.add(playerId);

      const occupiedPosition =
        playerToPosition.get(playerId);

      if (
        occupiedPosition == null ||
        augment(
          occupiedPosition,
          seenPlayers
        )
      ) {
        playerToPosition.set(
          playerId,
          position
        );
        positionToPlayer.set(
          position,
          row.player
        );
        return true;
      }
    }

    return false;
  }

  for (
    const position of
    orderedPositions
  ) {
    if (
      !augment(
        position,
        new Set()
      )
    ) {
      throw new RangeError(
        `production roster에서 ${position} 포함 수비 8자리를 구성할 수 없습니다.`
      );
    }
  }

  const usedIds =
    new Set(
      [...positionToPlayer.values()]
        .map(
          (player) =>
            String(player.id)
        )
    );

  const dhPlayer =
    hitters
      .filter(
        (player) =>
          !usedIds.has(
            String(player.id)
          )
      )
      .sort(
        (a, b) =>
          overall(b) -
            overall(a) ||
          String(a.id)
            .localeCompare(
              String(b.id)
            )
      )[0];

  if (!dhPlayer) {
    throw new RangeError(
      "production roster에 DH를 배치할 추가 야수가 없습니다."
    );
  }

  usedIds.add(
    String(dhPlayer.id)
  );

  const slots =
    LINEUP_POSITIONS.map(
      (position) => ({
        position,
        player:
          position === "DH"
            ? dhPlayer
            : positionToPlayer.get(
                position
              )
      })
    );

  const remaining =
    hitters.filter(
      (player) =>
        !usedIds.has(
          String(player.id)
        )
    );

  return {
    slots,
    remaining
  };
}

function benchCoverage(
  player,
  inference
) {
  return resolveProductionPositionProfile(
    player,
    inference
  ).coverage;
}

function createProductionRoster(team, snapshotPlayers, universe, inferenceById, { userPlayer = null, userPlayerName = null, seed = "", pitchArsenalIndex = new Map() } = {}) {
  const playersForTeam = snapshotPlayers.filter((player) => String(playerAssignedTeamId(player)) === String(team.id) && isPlayerGameAvailable(player));
  const pitchers = playersForTeam.filter(
    (player) =>
      isProductionPitcherInference(
        inferenceById.get(
          String(player.id)
        )
      )
  );
  const hitters = playersForTeam.filter(
    (player) =>
      isProductionHitterInference(
        inferenceById.get(
          String(player.id)
        )
      )
  );
  if (hitters.length < MIN_PRODUCTION_HITTERS) throw new RangeError(`${team.name} production roster 야수가 부족합니다: ${hitters.length} < ${MIN_PRODUCTION_HITTERS}`);
  if (pitchers.length < MIN_PRODUCTION_PITCHERS) throw new RangeError(`${team.name} production roster 투수가 부족합니다: ${pitchers.length} < ${MIN_PRODUCTION_PITCHERS}`);

  const picked = pickLineup(hitters, inferenceById);
  const slots = picked.slots;
  const remaining = picked.remaining;
  if (userPlayer) {
    const preferred = normalizePosition(userPlayer.positioning?.primaryPosition ?? "DH");
    const slot = slots.find((row) => row.position === preferred) ?? slots.find((row) => row.position === "DH") ?? slots[0];
    if (slot?.player) remaining.unshift(slot.player);
    slot.player = { id: userPlayer.id, position: preferred, fullName: userPlayerName ?? "User Player" };
  }
  const enginePlayers = {};
  const names = {};
  for (const player of hitters) {
    const inference =
      inferenceById.get(
        String(player.id)
      );
    enginePlayers[String(player.id)] =
      engineHitter(
        player,
        hitterInferenceView(inference),
        { seed }
      );
    names[String(player.id)] =
      player.fullName;
  }
  for (const player of pitchers) {
    const inference =
      inferenceById.get(
        String(player.id)
      );
    const pitcherInference =
      pitcherInferenceView(
        inference
      );

    const realPitchArsenal =
      normalizeInferredPitchArsenal(
        pitcherInference,
        {
          level: String(team.level),
          season:
            universe.sourceSnapshot
              ?.season ?? 2026
        }
      );

    const pitchArsenal =
      realPitchArsenal.length
        ? realPitchArsenal
        : createGeneratedRandomArsenal({
            playerId:
              String(player.id),
            seed,
            level:
              String(team.level),
            season:
              universe.sourceSnapshot
                ?.season ?? 2026
          });

    const pitcherEngine =
      enginePitcher(
        player,
        pitcherInference,
        { seed, pitchArsenal }
      );

    if (
      inference?.type ===
        "TWO_WAY" &&
      enginePlayers[
        String(player.id)
      ]
    ) {
      enginePlayers[
        String(player.id)
      ] = mergeTwoWayEnginePlayer(
        enginePlayers[
          String(player.id)
        ],
        pitcherEngine,
        inference
      );
    } else {
      enginePlayers[
        String(player.id)
      ] = pitcherEngine;
    }

    names[String(player.id)] =
      player.fullName;
  }
  if (userPlayer) {
    enginePlayers[userPlayer.id] = userPlayer;
    names[userPlayer.id] = userPlayerName ?? "User Player";
  }

  const lineupSlots = slots.map(({ position, player }) => ({ position, starterId: String(player.id) }));
  const lineup = lineupSlots.map((slot) => slot.starterId);
  const defense = Object.fromEntries(DEFENSE_POSITIONS.map((position) => [position, lineupSlots.find((slot) => slot.position === position).starterId]));
  const bench = remaining
    .slice(
      0,
      Math.max(
        4,
        remaining.length
      )
    )
    .map((player) => ({
      playerId: String(player.id),
      coverage: benchCoverage(
        player,
        inferenceById.get(
          String(player.id)
        )
      )
    }));

  const rankedPitchers = [...pitchers].sort(
    (a, b) =>
      Number(
        pitcherInferenceView(
          inferenceById.get(
            String(b.id)
          )
        )?.overall ?? 50
      ) -
        Number(
          pitcherInferenceView(
            inferenceById.get(
              String(a.id)
            )
          )?.overall ?? 50
        ) ||
      String(a.id).localeCompare(
        String(b.id)
      )
  );
  const preferredStarters = rankedPitchers.filter(
    (p) =>
      pitcherInferenceView(inferenceById.get(String(p.id)))?.role === "SP"
  );
  const swingStarters = rankedPitchers.filter(
    (p) =>
      pitcherInferenceView(inferenceById.get(String(p.id)))?.role === "SWING"
  );
  const reliefFallback = rankedPitchers.filter(
    (p) =>
      pitcherInferenceView(inferenceById.get(String(p.id)))?.role === "RP"
  );
  const starters = [
    ...preferredStarters,
    ...swingStarters,
    ...reliefFallback
  ]
    .slice(0, 5)
    .map((p) => String(p.id));
  const starterSet = new Set(starters);
  const bullpen = rankedPitchers.filter((p) => !starterSet.has(String(p.id))).map((p) => String(p.id));
  if (bullpen.length < 3) throw new RangeError(`${team.name} production bullpen이 부족합니다: ${bullpen.length} < 3`);

  return freeze({
    team: { id: String(team.id), name: team.name, shortName: team.abbreviation || team.name },
    players: enginePlayers, names, lineup, lineupSlots, defense, bench,
    positionPlayers: [...hitters.map((p) => String(p.id)), ...(userPlayer ? [userPlayer.id] : [])],
    starters, bullpen, pitchers: pitchers.map((p) => String(p.id))
  });
}

function teamRowsForLevel(universe, level) {
  return universe.data.teams.filter((team) => team.level === level && team.active !== false);
}

function affiliateTeamId(universe, organizationId, level) {
  if (level === "MLB") return String(organizationId);
  return String(universe.data.affiliations.find((row) => String(row.organizationId) === String(organizationId) && row.level === level)?.teamId ?? "");
}

function getProductionOrganizationTeamIds(universe, organizationId) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("organization team ids에는 Master Snapshot universe가 필요합니다.");
  return freeze(Object.fromEntries(PRODUCTION_LEVELS.map((level) => [level, affiliateTeamId(universe, organizationId, level)])));
}

function getProductionOrganizationOptions(universe) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("production organization에는 Master Snapshot universe가 필요합니다.");
  const teams = teamRowsForLevel(universe, "MLB").sort((a, b) => a.name.localeCompare(b.name));
  if (teams.length !== 30) throw new RangeError(`production MLB 조직 수가 30이 아닙니다: ${teams.length}`);
  return freeze(teams.map((team) => ({ id: String(team.id), name: team.name, shortName: team.abbreviation || team.name, pool: "PRODUCTION_30", provisional: false })));
}

function resolveProductionStartingLevel(age) {
  const a = Number(age);
  if (a <= 18) return "A";
  if (a === 19) return "HIGH_A";
  if (a === 20) return "AA";
  return "AAA";
}

function validateProductionRuntimeUniverse(universe) {
  if (universe?.origin !== "MASTER_SNAPSHOT" || !universe.data) throw new TypeError("production runtime에는 Master Snapshot universe가 필요합니다.");
  if (!universe.inference?.players?.length) throw new RangeError("production runtime에는 v46 inference가 필요합니다.");
  const inferenceById = new Map((universe.inference.players ?? []).map((row) => [String(row.playerId), row]));
  for (const level of PRODUCTION_LEVELS) {
    const teams = teamRowsForLevel(universe, level);
    if (teams.length !== 30) throw new RangeError(`production ${level} 팀 수가 30이 아닙니다: ${teams.length}`);
    const scheduleRows = universe.data.schedule.filter((game) => game.level === level && game.gameType !== "S");
    const scheduleCounts = Object.fromEntries(teams.map((team) => [String(team.id), 0]));
    for (const game of scheduleRows) {
      if (scheduleCounts[String(game.awayTeamId)] !== undefined) scheduleCounts[String(game.awayTeamId)] += 1;
      if (scheduleCounts[String(game.homeTeamId)] !== undefined) scheduleCounts[String(game.homeTeamId)] += 1;
    }
    for (const team of teams) {
      if ((scheduleCounts[String(team.id)] ?? 0) < 100) throw new RangeError(`${level} 실제 일정 coverage가 부족합니다: ${team.name} ${(scheduleCounts[String(team.id)] ?? 0)}경기`);
      const roster = universe.data.players.filter((player) => String(playerAssignedTeamId(player)) === String(team.id) && isPlayerGameAvailable(player));
      const pitcherCount = roster.filter(
        (player) =>
          isProductionPitcherInference(
            inferenceById.get(
              String(player.id)
            )
          )
      ).length;
      const hitterCount = roster.filter(
        (player) =>
          isProductionHitterInference(
            inferenceById.get(
              String(player.id)
            )
          )
      ).length;
      if (hitterCount < MIN_PRODUCTION_HITTERS || pitcherCount < MIN_PRODUCTION_PITCHERS) throw new RangeError(`${team.name} production roster coverage가 부족합니다: H${hitterCount}/P${pitcherCount}`);
    }
  }
  for (const org of teamRowsForLevel(universe, "MLB")) {
    for (const level of PRODUCTION_LEVELS.slice(1)) if (!affiliateTeamId(universe, org.id, level)) throw new RangeError(`${org.name} ${level} 제휴팀이 없습니다.`);
  }
  return true;
}

function createLevelLeague({ universe, level, selectedOrgId, startDate, inferenceById, pitchArsenalIndex, userPlayer = null, userPlayerName = null, userLevel = null, seed = "" }) {
  const sourceTeams = teamRowsForLevel(universe, level);
  const teams = sourceTeams.map((team) => freeze({ id: String(team.id), name: team.name, shortName: team.abbreviation || team.name }));
  const userTeamId = affiliateTeamId(universe, selectedOrgId, level);
  const rosters = Object.fromEntries(sourceTeams.map((team) => {
    const insertUser = userPlayer && level === userLevel && String(team.id) === String(userTeamId);
    return [String(team.id), createProductionRoster(team, universe.data.players, universe, inferenceById, { userPlayer: insertUser ? userPlayer : null, userPlayerName, seed, pitchArsenalIndex })];
  }));
  const schedule = importSnapshotSchedule({ games: universe.data.schedule, teamIds: teams.map((team) => team.id), level, resetResults: true });
  return freeze({
    level,
    leagueId: `PROD_${universe.sourceSnapshot?.season ?? "REAL"}_${level}_30`,
    teams,
    rosters,
    schedule,
    userTeamId,
    scheduleSource: "MASTER_SNAPSHOT"
  });
}

function createProductionCareerSeasonFixture({ seed, careerPlan, universe } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("production career seed가 필요합니다.");
  if (!careerPlan?.generated?.player || !careerPlan?.identity || !careerPlan?.organization?.teamId) throw new TypeError("검증된 careerPlan이 필요합니다.");
  validateProductionRuntimeUniverse(universe);

  const selectedOrgId = String(careerPlan.organization.teamId);
  if (!getProductionOrganizationOptions(universe).some((org) => org.id === selectedOrgId)) throw new RangeError(`production 조직을 찾을 수 없습니다: ${selectedOrgId}`);
  const userLevel = resolveProductionStartingLevel(careerPlan.identity.age);
  const userPlayer = freeze({ ...careerPlan.generated.player, physical: { ...(careerPlan.generated.player.physical ?? {}), age: careerPlan.identity.age } });
  const allDates = universe.data.schedule.filter((g) => g.gameType !== "S").map((g) => String(g.date)).sort();
  const startDate = allDates[0] ?? universe.snapshotDate;
  const inferenceById = new Map((universe.inference?.players ?? []).map((row) => [String(row.playerId), row]));
  const pitchArsenalIndex = buildProductionPitchArsenalIndex(
    universe.data.pitchArsenal ?? [],
    { season: universe.sourceSnapshot?.season ?? 2026 }
  );
  const levelLeagues = {};
  for (const level of PRODUCTION_LEVELS) {
    levelLeagues[level] = createLevelLeague({ universe, level, selectedOrgId, startDate, inferenceById, userPlayer, userPlayerName: careerPlan.identity.name, userLevel, seed });
  }
  const organizationLevels = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const league = levelLeagues[level];
    const teamId = league.userTeamId;
    return [level, freeze({ level, team: league.rosters[teamId].team, roster: league.rosters[teamId], simulated: true })];
  }));
  const aaa = levelLeagues.AAA;
  const careerProfile = freeze({
    schemaVersion: 1, identity: { ...careerPlan.identity }, archetype: careerPlan.generated.startingProfile.archetype,
    visibleTraits: [...careerPlan.generated.startingProfile.visibleTraits], startingProfile: careerPlan.generated.startingProfile,
    organizationChoice: { ...careerPlan.organization }
  });
  return freeze({
    seed, startDate, worldMode: "PRODUCTION_REAL", productionWorldVersion: PRODUCTION_WORLD_VERSION,
    sourceSnapshotId: universe.sourceSnapshot?.id ?? null, sourceSnapshotHash: universe.sourceSnapshot?.hash ?? null,
    scheduleSource: "MASTER_SNAPSHOT", futureScheduleGenerator: "ROUND_ROBIN_162_BALANCED_V47",
    userPlayerId: userPlayer.id, userTeamId: aaa.userTeamId,
    teams: aaa.teams, rosters: aaa.rosters, schedule: aaa.schedule, levelLeagues,
    parks: universe.data.parks ?? [],
    organization: { id: `ORG_${selectedOrgId}`, organizationId: selectedOrgId, name: careerPlan.organization.teamName, levels: organizationLevels, levelOrder: PRODUCTION_LEVELS, userLevel },
    careerProfile
  });
}

function rehomeProductionUserOrganization(fixture, { universe, organizationId, userLevel = fixture?.organization?.userLevel ?? "AAA" } = {}) {
  ensureProductionSeasonFixture(fixture);
  const orgId=String(organizationId);
  const option=getProductionOrganizationOptions(universe).find((row)=>row.id===orgId);
  if(!option) throw new RangeError(`production 조직을 찾을 수 없습니다: ${orgId}`);
  const teamIds=getProductionOrganizationTeamIds(universe,orgId);
  const levelLeagues=Object.fromEntries(PRODUCTION_LEVELS.map((level)=>{
    const league=fixture.levelLeagues[level], teamId=String(teamIds[level]);
    if(!league?.rosters?.[teamId]) throw new RangeError(`rehome ${level} roster를 찾을 수 없습니다: ${teamId}`);
    return [level,freeze({...league,userTeamId:teamId})];
  }));
  const levels=Object.fromEntries(PRODUCTION_LEVELS.map((level)=>{
    const roster=levelLeagues[level].rosters[levelLeagues[level].userTeamId];
    return [level,freeze({level,team:roster.team,roster,simulated:true})];
  }));
  const aaa=levelLeagues.AAA;
  const careerProfile=fixture.careerProfile ? freeze({
    ...fixture.careerProfile,
    organizationChoice: freeze({
      ...(fixture.careerProfile.organizationChoice ?? {}),
      teamId: orgId,
      teamName: option.name,
      teamShortName: option.shortName,
      pool: option.pool,
      provisional: option.provisional
    })
  }) : fixture.careerProfile;
  return freeze({...fixture,userTeamId:aaa.userTeamId,teams:aaa.teams,rosters:aaa.rosters,schedule:aaa.schedule,levelLeagues,careerProfile,
    organization:freeze({id:`ORG_${orgId}`,organizationId:orgId,name:option.name,levels,levelOrder:PRODUCTION_LEVELS,userLevel})
  });
}

function ensureProductionSeasonFixture(fixture) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") return fixture;
  if (!fixture?.levelLeagues || !fixture?.organization?.levels) throw new RangeError("production fixture의 league/organization 구조가 없습니다.");
  return fixture;
}


function createNextProductionSeasonFixture(fixture, { startDate = null } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("next production season은 production fixture에서만 생성할 수 있습니다.");
  ensureProductionSeasonFixture(fixture);
  const nextStartDate = startDate ?? `${Number(String(fixture.startDate).slice(0,4)) + 1}-03-25`;
  const schedules = createFutureProductionSchedules(fixture, { startDate: nextStartDate });
  const levelLeagues = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const league = fixture.levelLeagues[level];
    return [level, freeze({ ...league, schedule: schedules[level], scheduleSource: "GENERATED_FUTURE" })];
  }));
  const organizationLevels = Object.fromEntries(PRODUCTION_LEVELS.map((level) => {
    const prior = fixture.organization.levels[level];
    const league = levelLeagues[level];
    const teamId = String(prior?.team?.id ?? league.userTeamId);
    const roster = league.rosters[teamId] ?? prior?.roster;
    if (!roster) throw new RangeError(`next production season ${level} 사용자 조직 roster를 찾을 수 없습니다.`);
    return [level, freeze({ ...prior, level, team: roster.team, roster, simulated: true })];
  }));
  const aaa = levelLeagues.AAA;
  return freeze({
    ...fixture,
    startDate: nextStartDate,
    scheduleSource: "GENERATED_FUTURE",
    teams: aaa.teams,
    rosters: aaa.rosters,
    schedule: aaa.schedule,
    levelLeagues,
    organization: freeze({ ...fixture.organization, levels: organizationLevels })
  });
}
function createFutureProductionSchedules(fixture, { startDate = null } = {}) {
  if (fixture?.worldMode !== "PRODUCTION_REAL") throw new RangeError("future production schedule은 production fixture에서만 생성할 수 있습니다.");
  const schedules = {};
  for (const level of PRODUCTION_LEVELS) {
    const league = fixture.levelLeagues[level];
    const teamCount = league.teams.length;
    const gamesPerTeam = Number((league.schedule.length * 2) / teamCount);
    if (!Number.isInteger(gamesPerTeam) || gamesPerTeam < teamCount - 1) throw new RangeError(`${level} future schedule template 경기 수가 잘못되었습니다: ${gamesPerTeam}`);
    schedules[level] = generateFutureProductionSchedule({ teamIds: league.teams.map((team) => team.id), startDate: startDate ?? `${Number(fixture.startDate.slice(0,4)) + 1}-03-25`, gamesPerTeam });
  }
  return freeze(schedules);
}

// v47 keeps player construction isolated here. The phase-1 builder functions are
// used only as immutable engine-shape constructors; source facts and ratings come
// exclusively from the copied snapshot + v46 inference, never from dev fixture constants.

export { PRODUCTION_WORLD_VERSION, PRODUCTION_LEVELS, resolveProductionPositionProfile, getProductionOrganizationOptions, getProductionOrganizationTeamIds, rehomeProductionUserOrganization, resolveProductionStartingLevel, validateProductionRuntimeUniverse, createProductionCareerSeasonFixture, ensureProductionSeasonFixture, createFutureProductionSchedules, createNextProductionSeasonFixture };
