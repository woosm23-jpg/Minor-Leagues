const LEGACY_MASTER_SNAPSHOT_SCHEMA_VERSION = 1;
const MASTER_SNAPSHOT_SCHEMA_VERSION = 2;
const SUPPORTED_MASTER_SNAPSHOT_SCHEMA_VERSIONS = Object.freeze([LEGACY_MASTER_SNAPSHOT_SCHEMA_VERSION, MASTER_SNAPSHOT_SCHEMA_VERSION]);
const SAVE_UNIVERSE_SCHEMA_VERSION = 1;

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clone(value) { return structuredClone(value); }
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}가 필요합니다.`);
  return value.trim();
}
function isoDate(value, label) {
  const text = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError(`${label}는 YYYY-MM-DD 형식이어야 합니다.`);
  return text;
}
function idString(value, label) {
  if (value == null || String(value).trim() === "") throw new TypeError(`${label}가 필요합니다.`);
  return String(value).trim();
}
function supportedLevel(value, label) {
  const level = requiredString(value, label);
  if (!["MLB", "AAA", "AA", "HIGH_A", "A"].includes(level)) throw new RangeError(`${label}이 지원 범위를 벗어났습니다.`);
  return level;
}
function finiteInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new TypeError(`${label}는 정수여야 합니다.`);
  return n;
}
function array(value, label) { if (!Array.isArray(value)) throw new TypeError(`${label}는 배열이어야 합니다.`); return value; }
function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}가 필요합니다.`); return value; }
function optionalBoolean(value) { return value == null ? null : value === true; }
function normalizePositionEvidence(row, index, label = "positions") {
  if (typeof row === "string") return { position: row, games: null, innings: null, starts: null, seasons: [] };
  object(row, `${label}[${index}]`);
  return {
    position: requiredString(row.position ?? row.code, `${label}[${index}].position`),
    games: row.games == null ? null : Number(row.games), innings: row.innings == null ? null : Number(row.innings),
    starts: row.starts == null ? null : Number(row.starts), seasons: Array.isArray(row.seasons) ? row.seasons.map(Number).filter(Number.isFinite) : []
  };
}
function normalizeSample(row, label) {
  if (row == null) return {};
  return clone(object(row, label));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function stableContentHash(value) {
  const text = stable(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
}

function normalizeSource(row, index) {
  object(row, `sources[${index}]`);
  return {
    id: requiredString(row.id ?? `source_${index + 1}`, `sources[${index}].id`),
    name: requiredString(row.name, `sources[${index}].name`),
    url: requiredString(row.url, `sources[${index}].url`),
    retrievedAt: requiredString(row.retrievedAt, `sources[${index}].retrievedAt`),
    notes: row.notes == null ? null : String(row.notes)
  };
}

function normalizeTeam(row, index) {
  object(row, `teams[${index}]`);
  const level = supportedLevel(row.level, `teams[${index}].level`);
  return {
    id: idString(row.id, `teams[${index}].id`), name: requiredString(row.name, `teams[${index}].name`), abbreviation: String(row.abbreviation ?? ""),
    level, parentOrganizationId: row.parentOrganizationId == null ? null : String(row.parentOrganizationId),
    leagueId: row.leagueId == null ? null : String(row.leagueId), divisionId: row.divisionId == null ? null : String(row.divisionId),
    venueId: row.venueId == null ? null : String(row.venueId), active: row.active !== false,
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function normalizeLegacyPlayer(row, index) {
  object(row, `players[${index}]`);
  return {
    id: idString(row.id, `players[${index}].id`), fullName: requiredString(row.fullName, `players[${index}].fullName`),
    teamId: row.teamId == null ? null : String(row.teamId), level: supportedLevel(row.level, `players[${index}].level`),
    status: String(row.status ?? "UNKNOWN"), position: String(row.position ?? "UNK"),
    birthDate: row.birthDate == null ? null : String(row.birthDate), age: row.age == null ? null : Number(row.age),
    bats: row.bats == null ? null : String(row.bats), throws: row.throws == null ? null : String(row.throws),
    height: row.height == null ? null : String(row.height), weight: row.weight == null ? null : Number(row.weight),
    mlbDebutDate: row.mlbDebutDate == null ? null : String(row.mlbDebutDate), active: row.active !== false,
    publicScouting: row.publicScouting == null ? null : clone(object(row.publicScouting, `players[${index}].publicScouting`)),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function normalizePlayer(row, index) {
  object(row, `players[${index}]`);
  const assignedTeamId = row.assignedTeamId ?? row.teamId;
  const assignedLevel = row.assignedLevel ?? row.level;
  const rosterStatus = String(row.rosterStatus ?? row.status ?? "UNKNOWN");
  const positions = array(row.positions ?? [row.position ?? "UNK"], `players[${index}].positions`).map((position, positionIndex) => normalizePositionEvidence(position, positionIndex, `players[${index}].positions`));
  const primaryPosition = String(row.position ?? positions[0]?.position ?? "UNK");
  return {
    id: idString(row.id, `players[${index}].id`), fullName: requiredString(row.fullName, `players[${index}].fullName`),
    organizationId: row.organizationId == null ? null : String(row.organizationId),
    assignedTeamId: assignedTeamId == null ? null : String(assignedTeamId), assignedLevel: supportedLevel(assignedLevel, `players[${index}].assignedLevel`),
    rosterStatus, availability: String(row.availability ?? (row.active === false ? "UNKNOWN" : "ACTIVE")),
    on40Man: optionalBoolean(row.on40Man), mlbActive: optionalBoolean(row.mlbActive), injuryListType: row.injuryListType == null ? null : String(row.injuryListType),
    eligibleReturnDate: row.eligibleReturnDate == null ? null : String(row.eligibleReturnDate),
    rookieEligibility: row.rookieEligibility == null ? null : clone(object(row.rookieEligibility, `players[${index}].rookieEligibility`)),
    position: primaryPosition, positions,
    birthDate: row.birthDate == null ? null : String(row.birthDate), age: row.age == null ? null : Number(row.age),
    bats: row.bats == null ? null : String(row.bats), throws: row.throws == null ? null : String(row.throws),
    height: row.height == null ? null : String(row.height), weight: row.weight == null ? null : Number(row.weight),
    mlbDebutDate: row.mlbDebutDate == null ? null : String(row.mlbDebutDate), active: row.active !== false,
    publicScouting: row.publicScouting == null ? null : clone(object(row.publicScouting, `players[${index}].publicScouting`)),
    rosterEvidence: Array.isArray(row.rosterEvidence) ? clone(row.rosterEvidence) : [],
    sourceId: row.sourceId == null ? null : String(row.sourceId),
    // Compatibility aliases used by the v47-v50 runtime while v2 is staged.
    teamId: assignedTeamId == null ? null : String(assignedTeamId), level: supportedLevel(assignedLevel, `players[${index}].level`), status: rosterStatus
  };
}

function normalizeAffiliation(row, index) {
  object(row, `affiliations[${index}]`);
  return {
    organizationId: idString(row.organizationId, `affiliations[${index}].organizationId`), mlbTeamId: idString(row.mlbTeamId ?? row.organizationId, `affiliations[${index}].mlbTeamId`),
    level: supportedLevel(row.level, `affiliations[${index}].level`), teamId: idString(row.teamId, `affiliations[${index}].teamId`),
    effectiveSeason: finiteInt(row.effectiveSeason, `affiliations[${index}].effectiveSeason`), sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function normalizeLegacyStat(row, index) {
  object(row, `stats[${index}]`);
  const group = requiredString(row.group, `stats[${index}].group`);
  if (!["hitting", "pitching", "fielding"].includes(group)) throw new RangeError(`stats[${index}].group이 잘못되었습니다.`);
  return {
    playerId: idString(row.playerId, `stats[${index}].playerId`), teamId: row.teamId == null ? null : String(row.teamId), level: supportedLevel(row.level, `stats[${index}].level`),
    season: finiteInt(row.season, `stats[${index}].season`), group, gameType: String(row.gameType ?? "R"),
    position: row.position == null ? null : String(row.position),
    values: clone(object(row.values ?? {}, `stats[${index}].values`)), sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function normalizeStat(row, index) {
  object(row, `stats[${index}]`);
  const group = requiredString(row.group, `stats[${index}].group`);
  if (!["hitting", "pitching", "fielding"].includes(group)) throw new RangeError(`stats[${index}].group이 잘못되었습니다.`);
  return {
    playerId: idString(row.playerId, `stats[${index}].playerId`), teamId: row.teamId == null ? null : String(row.teamId), level: supportedLevel(row.level, `stats[${index}].level`),
    season: finiteInt(row.season, `stats[${index}].season`), group, gameType: String(row.gameType ?? "R"),
    position: row.position == null ? null : String(row.position), splitContext: row.splitContext == null ? { type: "TOTAL" } : clone(object(row.splitContext, `stats[${index}].splitContext`)),
    values: clone(object(row.values ?? {}, `stats[${index}].values`)), sample: normalizeSample(row.sample, `stats[${index}].sample`),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}


function normalizeTracking(row, index) {
  object(row, `tracking[${index}]`);
  return {
    playerId: idString(row.playerId, `tracking[${index}].playerId`), season: finiteInt(row.season, `tracking[${index}].season`),
    level: supportedLevel(row.level, `tracking[${index}].level`), metricGroup: requiredString(row.metricGroup, `tracking[${index}].metricGroup`),
    values: clone(object(row.values ?? {}, `tracking[${index}].values`)), denominators: normalizeSample(row.denominators, `tracking[${index}].denominators`),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}
function normalizePitchArsenal(row, index) {
  object(row, `pitchArsenal[${index}]`);
  return {
    playerId: idString(row.playerId, `pitchArsenal[${index}].playerId`), season: finiteInt(row.season, `pitchArsenal[${index}].season`),
    level: supportedLevel(row.level, `pitchArsenal[${index}].level`), pitchType: requiredString(row.pitchType, `pitchArsenal[${index}].pitchType`),
    usage: row.usage == null ? null : Number(row.usage), velocity: row.velocity == null ? null : clone(row.velocity), movement: row.movement == null ? null : clone(row.movement),
    whiff: row.whiff == null ? null : clone(row.whiff), location: row.location == null ? null : clone(row.location), samples: normalizeSample(row.samples, `pitchArsenal[${index}].samples`),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}
function normalizeAvailabilityEvent(row, index) {
  object(row, `availabilityEvents[${index}]`);
  return {
    playerId: idString(row.playerId, `availabilityEvents[${index}].playerId`), date: isoDate(row.date, `availabilityEvents[${index}].date`),
    type: requiredString(row.type, `availabilityEvents[${index}].type`), fromStatus: row.fromStatus == null ? null : String(row.fromStatus),
    toStatus: row.toStatus == null ? null : String(row.toStatus), teamId: row.teamId == null ? null : String(row.teamId),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}


function normalizeParkData(row, index) {
  object(row, `parks[${index}]`);
  const geometry = row.geometry == null ? {} : clone(object(row.geometry, `parks[${index}].geometry`));
  const wallHeights = row.wallHeights == null ? {} : clone(object(row.wallHeights, `parks[${index}].wallHeights`));
  const empiricalFactors = row.empiricalFactors == null ? null : clone(object(row.empiricalFactors, `parks[${index}].empiricalFactors`));
  return {
    venueId: idString(row.venueId, `parks[${index}].venueId`), teamId: row.teamId == null ? null : String(row.teamId),
    name: requiredString(row.name ?? `Venue ${row.venueId}`, `parks[${index}].name`), geometry, wallHeights, empiricalFactors,
    carryDistanceFeet: row.carryDistanceFeet == null ? 0 : Number(row.carryDistanceFeet),
    sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function normalizeGame(row, index) {
  object(row, `schedule[${index}]`);
  return {
    gamePk: idString(row.gamePk, `schedule[${index}].gamePk`), date: isoDate(row.date, `schedule[${index}].date`), level: supportedLevel(row.level, `schedule[${index}].level`),
    gameType: String(row.gameType ?? "R"), status: String(row.status ?? "SCHEDULED"),
    awayTeamId: idString(row.awayTeamId, `schedule[${index}].awayTeamId`), homeTeamId: idString(row.homeTeamId, `schedule[${index}].homeTeamId`),
    awayScore: row.awayScore == null ? null : Number(row.awayScore), homeScore: row.homeScore == null ? null : Number(row.homeScore),
    venueId: row.venueId == null ? null : String(row.venueId), sourceId: row.sourceId == null ? null : String(row.sourceId)
  };
}

function validateMasterSnapshot(snapshot, { requireProductionCoverage = false } = {}) {
  object(snapshot, "master snapshot");
  if (!SUPPORTED_MASTER_SNAPSHOT_SCHEMA_VERSIONS.includes(snapshot.schemaVersion)) throw new RangeError(`master snapshot schema가 호환되지 않습니다: ${snapshot.schemaVersion}`);
  object(snapshot.metadata, "snapshot.metadata");
  requiredString(snapshot.metadata.snapshotId, "snapshot.metadata.snapshotId");
  isoDate(snapshot.metadata.snapshotDate, "snapshot.metadata.snapshotDate");
  finiteInt(snapshot.metadata.season, "snapshot.metadata.season");
  const sources = array(snapshot.sources, "snapshot.sources");
  const teams = array(snapshot.teams, "snapshot.teams");
  const players = array(snapshot.players, "snapshot.players");
  const affiliations = array(snapshot.affiliations, "snapshot.affiliations");
  const stats = array(snapshot.stats, "snapshot.stats");
  const schedule = array(snapshot.schedule, "snapshot.schedule");
  const parks = snapshot.parks == null ? null : array(snapshot.parks, "snapshot.parks");
  const tracking = snapshot.schemaVersion >= 2 ? array(snapshot.tracking ?? [], "snapshot.tracking") : null;
  const pitchArsenal = snapshot.schemaVersion >= 2 ? array(snapshot.pitchArsenal ?? [], "snapshot.pitchArsenal") : null;
  const availabilityEvents = snapshot.schemaVersion >= 2 ? array(snapshot.availabilityEvents ?? [], "snapshot.availabilityEvents") : null;
  if (sources.length === 0) throw new RangeError("master snapshot source provenance가 비어 있습니다.");

  const storedHash = requiredString(snapshot.metadata.contentHash, "snapshot.metadata.contentHash");
  const { contentHash: _ignoredContentHash, ...metadataWithoutHash } = snapshot.metadata;
  const actualHash = stableContentHash({
    schemaVersion: snapshot.schemaVersion, metadata: metadataWithoutHash, sources, teams, players, affiliations, stats, schedule, ...(parks == null ? {} : { parks }),
    ...(snapshot.schemaVersion >= 2 ? { tracking, pitchArsenal, availabilityEvents } : {})
  });
  if (storedHash !== actualHash) throw new RangeError(`master snapshot content hash가 일치하지 않습니다: ${storedHash} != ${actualHash}`);

  const duplicate = (rows, keyFn) => {
    const seen = new Set();
    for (const row of rows) { const key = keyFn(row); if (seen.has(key)) return key; seen.add(key); }
    return null;
  };
  const duplicateTeam = duplicate(teams, (team) => String(team.id));
  if (duplicateTeam) throw new RangeError(`master snapshot team id가 중복됩니다: ${duplicateTeam}`);
  const duplicatePlayer = duplicate(players, (player) => String(player.id));
  if (duplicatePlayer) throw new RangeError(`master snapshot player id가 중복됩니다: ${duplicatePlayer}`);

  if (requireProductionCoverage) {
    const levels = ["MLB", "AAA", "AA", "HIGH_A", "A"];
    const levelCounts = Object.fromEntries(levels.map((level) => [level, teams.filter((team) => team.level === level && team.active !== false).length]));
    for (const level of levels) if (levelCounts[level] !== 30) throw new RangeError(`production snapshot ${level} 팀 수가 30이 아닙니다: ${levelCounts[level]}`);
    if (players.length < 700) throw new RangeError(`production snapshot player coverage가 너무 작습니다: ${players.length}`);
    if (affiliations.length < 120) throw new RangeError(`production snapshot affiliation coverage가 너무 작습니다: ${affiliations.length}`);
    if (stats.length === 0 || schedule.length === 0) throw new RangeError("production snapshot stats/schedule이 비어 있습니다.");
    if (!parks || parks.length !== 30) throw new RangeError(`production snapshot MLB park coverage가 30이 아닙니다: ${parks?.length ?? 0}`);
    const venueIds = new Set(parks.map((park) => String(park.venueId)));
    for (const team of teams.filter((team) => team.level === "MLB")) if (!team.venueId || !venueIds.has(String(team.venueId))) throw new RangeError(`production snapshot MLB park가 팀 venue와 연결되지 않았습니다: ${team.id}`);
    for (const level of levels) {
      if (!players.some((player) => (player.assignedLevel ?? player.level) === level)) throw new RangeError(`production snapshot ${level} player coverage가 비어 있습니다.`);
      if (!schedule.some((game) => game.level === level)) throw new RangeError(`production snapshot ${level} schedule coverage가 비어 있습니다.`);
      for (const group of ["hitting", "pitching", "fielding"]) if (!stats.some((row) => row.level === level && row.group === group)) throw new RangeError(`production snapshot ${level}/${group} stats coverage가 비어 있습니다.`);
    }

    const mlbIds = new Set(teams.filter((team) => team.level === "MLB").map((team) => String(team.id)));
    const teamById = new Map(teams.map((team) => [String(team.id), team]));
    const affiliateKeys = new Set();
    const coverage = new Map([...mlbIds].map((id) => [id, new Set()]));
    for (const row of affiliations) {
      const orgId = String(row.organizationId); const teamId = String(row.teamId); const level = String(row.level);
      if (!mlbIds.has(orgId)) throw new RangeError(`production affiliation의 MLB organization이 없습니다: ${orgId}`);
      const affiliate = teamById.get(teamId);
      if (!affiliate || affiliate.level !== level || level === "MLB") throw new RangeError(`production affiliation team/level이 snapshot과 일치하지 않습니다: ${teamId}/${level}`);
      const key = `${orgId}:${level}`;
      if (affiliateKeys.has(key)) throw new RangeError(`production affiliation이 조직/레벨별로 중복됩니다: ${key}`);
      affiliateKeys.add(key); coverage.get(orgId).add(level);
    }
    for (const [orgId, found] of coverage) for (const level of ["AAA", "AA", "HIGH_A", "A"]) if (!found.has(level)) throw new RangeError(`production organization ${orgId}에 ${level} affiliate가 없습니다.`);
  }
  return true;
}

function createMasterSnapshot(input) {
  object(input, "master snapshot input");
  const metadata = object(input.metadata, "input.metadata");
  const schemaVersion = Number(input.schemaVersion ?? LEGACY_MASTER_SNAPSHOT_SCHEMA_VERSION);
  if (!SUPPORTED_MASTER_SNAPSHOT_SCHEMA_VERSIONS.includes(schemaVersion)) throw new RangeError(`master snapshot schema가 호환되지 않습니다: ${schemaVersion}`);
  const normalizedCore = {
    schemaVersion,
    metadata: {
      snapshotId: requiredString(metadata.snapshotId, "metadata.snapshotId"), snapshotDate: isoDate(metadata.snapshotDate, "metadata.snapshotDate"),
      season: finiteInt(metadata.season, "metadata.season"), createdAt: requiredString(metadata.createdAt, "metadata.createdAt"),
      kind: String(metadata.kind ?? "REAL_WORLD"), productionReady: metadata.productionReady === true,
      notes: metadata.notes == null ? null : String(metadata.notes)
    },
    sources: array(input.sources ?? [], "sources").map(normalizeSource),
    teams: array(input.teams ?? [], "teams").map(normalizeTeam),
    players: array(input.players ?? [], "players").map(schemaVersion >= 2 ? normalizePlayer : normalizeLegacyPlayer),
    affiliations: array(input.affiliations ?? [], "affiliations").map(normalizeAffiliation),
    stats: array(input.stats ?? [], "stats").map(schemaVersion >= 2 ? normalizeStat : normalizeLegacyStat),
    schedule: array(input.schedule ?? [], "schedule").map(normalizeGame),
    parks: array(input.parks ?? [], "parks").map(normalizeParkData),
    ...(schemaVersion >= 2 ? {
      tracking: array(input.tracking ?? [], "tracking").map(normalizeTracking),
      pitchArsenal: array(input.pitchArsenal ?? [], "pitchArsenal").map(normalizePitchArsenal),
      availabilityEvents: array(input.availabilityEvents ?? [], "availabilityEvents").map(normalizeAvailabilityEvent)
    } : {})
  };
  const contentHash = stableContentHash(normalizedCore);
  const snapshot = freeze({ ...normalizedCore, metadata: { ...normalizedCore.metadata, contentHash } });
  validateMasterSnapshot(snapshot, { requireProductionCoverage: snapshot.metadata.productionReady });
  return snapshot;
}

function createMasterSnapshotV2(input) {
  return createMasterSnapshot({ ...input, schemaVersion: MASTER_SNAPSHOT_SCHEMA_VERSION });
}

function createSyntheticUniverseDescriptor({ startDate = "2026-04-01", sourceVersion = "DEV_FIXTURE_V44" } = {}) {
  return freeze({
    schemaVersion: SAVE_UNIVERSE_SCHEMA_VERSION, origin: "SYNTHETIC_DEV", sourceSnapshot: null,
    copiedAtCareerStart: startDate, sourceVersion, snapshotDate: null, provenance: [],
    data: null, independent: true
  });
}

function createSaveUniverseFromMasterSnapshot(snapshot, { copiedAtCareerStart, sourceVersion = "v45" } = {}) {
  validateMasterSnapshot(snapshot, { requireProductionCoverage: false });
  const date = isoDate(copiedAtCareerStart ?? snapshot.metadata.snapshotDate, "copiedAtCareerStart");
  const copied = clone(snapshot);
  return freeze({
    schemaVersion: SAVE_UNIVERSE_SCHEMA_VERSION, origin: "MASTER_SNAPSHOT",
    sourceSnapshot: { id: snapshot.metadata.snapshotId, hash: snapshot.metadata.contentHash, season: snapshot.metadata.season },
    copiedAtCareerStart: date, sourceVersion, snapshotDate: snapshot.metadata.snapshotDate,
    provenance: copied.sources,
    data: { teams: copied.teams, players: copied.players, affiliations: copied.affiliations, stats: copied.stats, schedule: copied.schedule, parks: copied.parks ?? [],
      ...(snapshot.schemaVersion >= 2 ? { tracking: copied.tracking ?? [], pitchArsenal: copied.pitchArsenal ?? [], availabilityEvents: copied.availabilityEvents ?? [] } : {}) },
    independent: true
  });
}

function normalizeSaveUniverse(universe, { startDate = "2026-04-01", sourceVersion = "legacy" } = {}) {
  if (universe == null) return createSyntheticUniverseDescriptor({ startDate, sourceVersion });
  object(universe, "save universe");
  if (universe.schemaVersion !== SAVE_UNIVERSE_SCHEMA_VERSION) throw new RangeError(`save universe schema가 호환되지 않습니다: ${universe.schemaVersion}`);
  if (!universe.independent) throw new RangeError("save universe는 career 생성 이후 독립 상태여야 합니다.");
  if (!['SYNTHETIC_DEV','MASTER_SNAPSHOT'].includes(universe.origin)) throw new RangeError(`save universe origin이 잘못되었습니다: ${universe.origin}`);
  if (universe.origin === "MASTER_SNAPSHOT") {
    object(universe.sourceSnapshot, "save universe sourceSnapshot");
    requiredString(universe.sourceSnapshot.id, "save universe sourceSnapshot.id");
    requiredString(universe.sourceSnapshot.hash, "save universe sourceSnapshot.hash");
    isoDate(universe.snapshotDate, "save universe snapshotDate");
    array(universe.provenance, "save universe provenance");
    object(universe.data, "save universe data");
    for (const key of ["teams","players","affiliations","stats","schedule"]) array(universe.data[key], `save universe data.${key}`);
    for (const key of ["parks","tracking","pitchArsenal","availabilityEvents"]) if (universe.data[key] !== undefined) array(universe.data[key], `save universe data.${key}`);
  }
  return freeze(clone(universe));
}

export { LEGACY_MASTER_SNAPSHOT_SCHEMA_VERSION, MASTER_SNAPSHOT_SCHEMA_VERSION, SUPPORTED_MASTER_SNAPSHOT_SCHEMA_VERSIONS, SAVE_UNIVERSE_SCHEMA_VERSION, stableContentHash, validateMasterSnapshot, createMasterSnapshot, createMasterSnapshotV2, createSyntheticUniverseDescriptor, createSaveUniverseFromMasterSnapshot, normalizeSaveUniverse };
