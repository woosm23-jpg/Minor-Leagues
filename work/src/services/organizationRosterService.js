import { defaultRoleForRosterPlayer } from "../engine/season/roleSystem.js";

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function replaceId(value, outgoingId, incomingId) { return value === outgoingId ? incomingId : value; }

function replaceRosterMember(roster, outgoingId, incoming) {
  if (!roster?.players?.[outgoingId]) throw new RangeError(`roster에 이동 대상 선수가 없습니다: ${outgoingId}`);
  if (roster.players[incoming.id]) throw new RangeError(`roster에 이미 incoming 선수가 있습니다: ${incoming.id}`);
  const players = { ...roster.players };
  const names = { ...roster.names };
  delete players[outgoingId]; delete names[outgoingId];
  players[incoming.id] = incoming.player; names[incoming.id] = incoming.name;
  return freeze({
    ...roster,
    players,
    names,
    lineup: (roster.lineup ?? []).map((id) => replaceId(id, outgoingId, incoming.id)),
    lineupSlots: (roster.lineupSlots ?? []).map((slot) => ({ ...slot, starterId: replaceId(slot.starterId, outgoingId, incoming.id) })),
    defense: Object.fromEntries(Object.entries(roster.defense ?? {}).map(([position, id]) => [position, replaceId(id, outgoingId, incoming.id)])),
    bench: (roster.bench ?? []).map((row) => ({ ...row, playerId: replaceId(row.playerId, outgoingId, incoming.id) })),
    positionPlayers: (roster.positionPlayers ?? []).map((id) => replaceId(id, outgoingId, incoming.id)),
    starters: [...(roster.starters ?? [])],
    bullpen: [...(roster.bullpen ?? [])],
    pitchers: [...(roster.pitchers ?? [])]
  });
}


function replacePitcherRosterMember(roster, outgoingId, incoming, role) {
  if (!['SP', 'RP'].includes(role)) throw new RangeError(`pitcher roster role은 SP/RP여야 합니다: ${role}`);
  if (!roster?.players?.[outgoingId]) throw new RangeError(`roster에 이동 대상 투수가 없습니다: ${outgoingId}`);
  if (roster.players[incoming.id]) throw new RangeError(`roster에 이미 incoming 투수가 있습니다: ${incoming.id}`);
  const source = role === 'SP' ? roster.starters : roster.bullpen;
  if (!source?.includes(outgoingId)) throw new RangeError(`${role} depth에 이동 대상 투수가 없습니다: ${outgoingId}`);
  const players = { ...roster.players };
  const names = { ...roster.names };
  delete players[outgoingId]; delete names[outgoingId];
  players[incoming.id] = incoming.player; names[incoming.id] = incoming.name;
  const starters = role === 'SP' ? (roster.starters ?? []).map((id) => replaceId(id, outgoingId, incoming.id)) : [...(roster.starters ?? [])];
  const bullpen = role === 'RP' ? (roster.bullpen ?? []).map((id) => replaceId(id, outgoingId, incoming.id)) : [...(roster.bullpen ?? [])];
  return freeze({
    ...roster,
    players,
    names,
    lineup: [...(roster.lineup ?? [])],
    lineupSlots: (roster.lineupSlots ?? []).map((slot) => ({ ...slot })),
    defense: { ...(roster.defense ?? {}) },
    bench: (roster.bench ?? []).map((row) => ({ ...row })),
    positionPlayers: [...(roster.positionPlayers ?? [])],
    starters,
    bullpen,
    pitchers: (roster.pitchers ?? []).map((id) => replaceId(id, outgoingId, incoming.id))
  });
}

function resetRoleForAssignment(state, { roster, playerId, level, date }) {
  const role = defaultRoleForRosterPlayer(roster, playerId, level);
  return freeze({
    ...(state ?? { playerId, gamesTracked: 0, reviews: 0 }),
    playerId,
    level,
    role,
    momentum: 0,
    recentFeedback: [],
    gamesSinceReview: 0,
    roleSinceDate: date,
    levelSinceDate: date,
    lastReviewDate: date,
    lastGameDate: state?.lastGameDate ?? null
  });
}

/**
 * Atomic same-position swap between adjacent organization levels.
 * AI modules decide; this Service is the only roster mutation boundary.
 */
function executeAdjacentLevelSwap({ fixture, roleStates, fromLevel, toLevel, promotePlayerId, demotePlayerId, position, date, reasonCodes = [], promoteReasonCodes = null, demoteReasonCodes = null }) {
  const organization = fixture?.organization;
  const lower = organization?.levels?.[fromLevel], upper = organization?.levels?.[toLevel];
  if (!lower?.roster || !upper?.roster) throw new RangeError(`${fromLevel}/${toLevel} organization roster가 필요합니다.`);
  const order = organization.levelOrder ?? ["MLB", "AAA", "AA", "HIGH_A", "A"];
  if (order.indexOf(toLevel) !== order.indexOf(fromLevel) - 1) throw new RangeError(`인접 레벨 이동만 지원합니다: ${fromLevel}->${toLevel}`);
  const promotePlayer = lower.roster.players[promotePlayerId];
  const demotePlayer = upper.roster.players[demotePlayerId];
  if (!promotePlayer || !demotePlayer) throw new RangeError("승격/강등 선수가 현재 레벨 roster에 없습니다.");
  const promotedName = lower.roster.names[promotePlayerId] ?? promotePlayerId;
  const demotedName = upper.roster.names[demotePlayerId] ?? demotePlayerId;
  const pitcherMovement = position === "SP" || position === "RP";
  const nextLowerRoster = pitcherMovement
    ? replacePitcherRosterMember(lower.roster, promotePlayerId, { id: demotePlayerId, player: demotePlayer, name: demotedName }, position)
    : replaceRosterMember(lower.roster, promotePlayerId, { id: demotePlayerId, player: demotePlayer, name: demotedName });
  const nextUpperRoster = pitcherMovement
    ? replacePitcherRosterMember(upper.roster, demotePlayerId, { id: promotePlayerId, player: promotePlayer, name: promotedName }, position)
    : replaceRosterMember(upper.roster, demotePlayerId, { id: promotePlayerId, player: promotePlayer, name: promotedName });
  const nextLevels = {
    ...organization.levels,
    [fromLevel]: freeze({ ...lower, roster: nextLowerRoster }),
    [toLevel]: freeze({ ...upper, roster: nextUpperRoster })
  };
  let userLevel = organization.userLevel;
  if (promotePlayerId === fixture.userPlayerId) userLevel = toLevel;
  if (demotePlayerId === fixture.userPlayerId) userLevel = fromLevel;
  const nextOrganization = freeze({ ...organization, levels: nextLevels, userLevel });

  // fixture.rosters is the legacy/canonical AAA mirror. Keep it synchronized
  // whenever AAA participates in a transaction without touching other levels.
  let nextRosters = { ...fixture.rosters };
  if (fromLevel === "AAA") nextRosters = { ...nextRosters, [fixture.userTeamId]: nextLowerRoster };
  if (toLevel === "AAA") nextRosters = { ...nextRosters, [fixture.userTeamId]: nextUpperRoster };

  const levelLeagues = fixture.levelLeagues ? { ...fixture.levelLeagues } : fixture.levelLeagues;
  if (levelLeagues) {
    const lowerLeague = levelLeagues[fromLevel];
    const upperLeague = levelLeagues[toLevel];
    if (lowerLeague) levelLeagues[fromLevel] = freeze({ ...lowerLeague, rosters: { ...lowerLeague.rosters, [lower.team.id]: nextLowerRoster } });
    if (upperLeague) levelLeagues[toLevel] = freeze({ ...upperLeague, rosters: { ...upperLeague.rosters, [upper.team.id]: nextUpperRoster } });
  }
  const nextFixture = freeze({ ...fixture, rosters: nextRosters, organization: nextOrganization, levelLeagues });

  const nextRoleStates = pitcherMovement ? { ...(roleStates ?? {}) } : {
    ...(roleStates ?? {}),
    [promotePlayerId]: resetRoleForAssignment(roleStates?.[promotePlayerId], { roster: nextUpperRoster, playerId: promotePlayerId, level: toLevel, date }),
    [demotePlayerId]: resetRoleForAssignment(roleStates?.[demotePlayerId], { roster: nextLowerRoster, playerId: demotePlayerId, level: fromLevel, date })
  };
  const promotionReasons = promoteReasonCodes ?? reasonCodes;
  const demotionReasons = demoteReasonCodes ?? reasonCodes;
  const events = [
    freeze({ type: "PLAYER_PROMOTED", date, playerId: promotePlayerId, fromLevel, toLevel, position, reasonCodes: [...promotionReasons] }),
    freeze({ type: "PLAYER_DEMOTED", date, playerId: demotePlayerId, fromLevel: toLevel, toLevel: fromLevel, position, reasonCodes: [...demotionReasons] })
  ];
  return freeze({ fixture: nextFixture, roleStates: nextRoleStates, events });
}

/** Backward-compatible v22-v26 wrapper. */
function executeAaaMlbSwap(options) {
  return executeAdjacentLevelSwap({ ...options, fromLevel: "AAA", toLevel: "MLB" });
}

export { executeAdjacentLevelSwap, executeAaaMlbSwap };
