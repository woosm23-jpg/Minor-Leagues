const CAREER_EVENT_TYPES = Object.freeze([
  "CAREER_STARTED",
  "LEVEL_ASSIGNED",
  "PLAYER_PROMOTED",
  "PLAYER_DEMOTED",
  "ROLE_CHANGED",
  "PRO_DEBUT",
  "MLB_DEBUT",
  "FIRST_MLB_HIT",
  "FIRST_MLB_HR",
  "FIRST_MLB_RBI",
  "FIRST_MLB_SB"
]);

const CAREER_EVENT_IMPORTANCE = Object.freeze(["MINOR", "NORMAL", "MAJOR", "CAREER"]);
const CAREER_MOMENT_KEYS = Object.freeze([
  "PRO_DEBUT",
  "MLB_DEBUT",
  "FIRST_MLB_HIT",
  "FIRST_MLB_HR",
  "FIRST_MLB_RBI",
  "FIRST_MLB_SB"
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function assertIsoDate(value, label = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD 문자열이어야 합니다.`);
}

function assertPlayerId(value) {
  if (typeof value !== "string" || !value) throw new TypeError("career event playerId가 필요합니다.");
}

function importanceForTransaction(type, fromLevel, toLevel) {
  if (type === "PLAYER_PROMOTED" && toLevel === "MLB") return "CAREER";
  if (type === "PLAYER_DEMOTED" && fromLevel === "MLB") return "MAJOR";
  return type === "PLAYER_PROMOTED" ? "MAJOR" : "NORMAL";
}

function emptyCareerEventState() {
  return { schemaVersion: 1, nextSequence: 1, completedMomentKeys: [], events: [] };
}

function normalizedMomentKeys(keys = []) {
  const set = new Set();
  for (const key of keys ?? []) {
    if (!CAREER_MOMENT_KEYS.includes(key)) throw new RangeError(`지원하지 않는 career moment key입니다: ${key}`);
    set.add(key);
  }
  return [...set].sort((a, b) => CAREER_MOMENT_KEYS.indexOf(a) - CAREER_MOMENT_KEYS.indexOf(b));
}

function normalizeScore(score) {
  if (score === null || score === undefined) return null;
  if (!score || typeof score !== "object" || Array.isArray(score)) throw new TypeError("career gameContext score는 object여야 합니다.");
  const away = Number(score.away);
  const home = Number(score.home);
  if (!Number.isInteger(away) || away < 0 || !Number.isInteger(home) || home < 0) throw new RangeError("career gameContext score는 0 이상의 정수여야 합니다.");
  return { away, home };
}

function normalizeBases(bases) {
  if (bases === null || bases === undefined) return null;
  if (!bases || typeof bases !== "object" || Array.isArray(bases)) throw new TypeError("career gameContext bases는 object여야 합니다.");
  return { first: Boolean(bases.first), second: Boolean(bases.second), third: Boolean(bases.third) };
}

function normalizeGameContext(context) {
  if (context === null || context === undefined) return null;
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new TypeError("career gameContext가 object여야 합니다.");
  const kind = context.kind ?? "GAME";
  if (!["GAME", "PA", "RUNNING"].includes(kind)) throw new RangeError(`지원하지 않는 career gameContext kind입니다: ${kind}`);
  const inning = context.inning ?? null;
  if (inning !== null && (!Number.isInteger(inning) || inning < 1)) throw new RangeError("career gameContext inning은 1 이상의 정수여야 합니다.");
  const half = context.half ?? null;
  if (half !== null && !["TOP", "BOTTOM"].includes(half)) throw new RangeError(`career gameContext half가 잘못되었습니다: ${half}`);
  const paNumber = context.paNumber ?? null;
  if (paNumber !== null && (!Number.isInteger(paNumber) || paNumber < 1)) throw new RangeError("career gameContext paNumber는 1 이상의 정수여야 합니다.");
  const outsBefore = context.outsBefore ?? null;
  const outsAfter = context.outsAfter ?? null;
  for (const [label, value] of [["outsBefore", outsBefore], ["outsAfter", outsAfter]]) {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 3)) throw new RangeError(`career gameContext ${label}는 0–3 정수여야 합니다.`);
  }
  const userSide = context.userSide ?? null;
  if (userSide !== null && !["away", "home"].includes(userSide)) throw new RangeError(`career gameContext userSide가 잘못되었습니다: ${userSide}`);
  const phase = context.phase ?? null;
  if (phase !== null && !["PA", "PRE_PA", "GAME"].includes(phase)) throw new RangeError(`career gameContext phase가 잘못되었습니다: ${phase}`);
  const teamName = context.teamName ?? null;
  const opponentTeamName = context.opponentTeamName ?? null;
  for (const [label, value] of [["teamName", teamName], ["opponentTeamName", opponentTeamName]]) {
    if (value !== null && (typeof value !== "string" || !value)) throw new TypeError(`career gameContext ${label}은 문자열이어야 합니다.`);
  }
  const numeric = (value, label) => {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new RangeError(`career gameContext ${label}는 0 이상의 유한한 값이어야 합니다.`);
    return n;
  };
  return {
    kind,
    phase,
    inning,
    half,
    paNumber,
    outsBefore,
    outsAfter,
    basesBefore: normalizeBases(context.basesBefore),
    basesAfter: normalizeBases(context.basesAfter),
    scoreBefore: normalizeScore(context.scoreBefore),
    scoreAfter: normalizeScore(context.scoreAfter),
    userSide,
    teamName,
    opponentTeamName,
    outcome: context.outcome ?? null,
    runningKind: context.runningKind ?? null,
    fromBase: context.fromBase ?? null,
    toBase: context.toBase ?? null,
    rbi: numeric(context.rbi, "rbi"),
    runsScored: numeric(context.runsScored, "runsScored"),
    pitchCount: numeric(context.pitchCount, "pitchCount")
  };
}

function appendMutable(state, event) {
  if (!CAREER_EVENT_TYPES.includes(event?.type)) throw new RangeError(`지원하지 않는 career event type입니다: ${event?.type}`);
  assertIsoDate(event.date, "career event date");
  assertPlayerId(event.playerId);
  const sequence = state.nextSequence;
  const importance = event.importance ?? "NORMAL";
  if (!CAREER_EVENT_IMPORTANCE.includes(importance)) throw new RangeError(`지원하지 않는 career event importance입니다: ${importance}`);
  const momentKey = event.momentKey ?? (CAREER_MOMENT_KEYS.includes(event.type) ? event.type : null);
  if (momentKey !== null && !CAREER_MOMENT_KEYS.includes(momentKey)) throw new RangeError(`지원하지 않는 career moment key입니다: ${momentKey}`);
  if (momentKey && (state.completedMomentKeys ?? []).includes(momentKey)) return state;
  state.events.push({
    schemaVersion: 1,
    eventId: `career_event_${String(sequence).padStart(6, "0")}`,
    sequence,
    type: event.type,
    date: event.date,
    playerId: event.playerId,
    importance,
    source: event.source ?? "SYSTEM",
    fromLevel: event.fromLevel ?? null,
    toLevel: event.toLevel ?? null,
    level: event.level ?? event.toLevel ?? event.fromLevel ?? null,
    fromRole: event.fromRole ?? null,
    toRole: event.toRole ?? null,
    position: event.position ?? null,
    reasonCodes: [...(event.reasonCodes ?? [])],
    momentKey,
    careerOnce: Boolean(event.careerOnce ?? momentKey !== null),
    gameId: event.gameId ?? null,
    teamId: event.teamId ?? null,
    opponentTeamId: event.opponentTeamId ?? null,
    statValue: event.statValue ?? null,
    gameContext: normalizeGameContext(event.gameContext)
  });
  state.nextSequence += 1;
  if (momentKey) state.completedMomentKeys = normalizedMomentKeys([...(state.completedMomentKeys ?? []), momentKey]);
  return state;
}

function createCareerEventState({ userPlayerId, startDate, initialLevel = "AAA" } = {}) {
  assertPlayerId(userPlayerId);
  assertIsoDate(startDate, "career startDate");
  const mutable = emptyCareerEventState();
  appendMutable(mutable, {
    type: "CAREER_STARTED",
    date: startDate,
    playerId: userPlayerId,
    importance: "CAREER",
    source: "CAREER_INIT",
    level: initialLevel
  });
  appendMutable(mutable, {
    type: "LEVEL_ASSIGNED",
    date: startDate,
    playerId: userPlayerId,
    importance: "NORMAL",
    source: "CAREER_INIT",
    toLevel: initialLevel,
    level: initialLevel,
    reasonCodes: ["INITIAL_ASSIGNMENT"]
  });
  return freeze(mutable);
}

function appendCareerEvent(state, event) {
  const normalized = normalizeCareerEventState(state, {
    userPlayerId: event?.playerId,
    startDate: event?.date,
    initialLevel: event?.fromLevel ?? event?.toLevel ?? event?.level ?? "AAA",
    organizationTransactions: []
  });
  const mutable = {
    schemaVersion: normalized.schemaVersion,
    nextSequence: normalized.nextSequence,
    completedMomentKeys: [...(normalized.completedMomentKeys ?? [])],
    events: normalized.events.map((row) => ({ ...row, reasonCodes: [...(row.reasonCodes ?? [])] }))
  };
  appendMutable(mutable, event);
  return freeze(mutable);
}

function recordOrganizationCareerEvents(state, transactionEvents, { userPlayerId } = {}) {
  let next = state;
  for (const event of transactionEvents ?? []) {
    if (!event || event.playerId !== userPlayerId) continue;
    if (!["PLAYER_PROMOTED", "PLAYER_DEMOTED"].includes(event.type)) continue;
    next = appendCareerEvent(next, {
      type: event.type,
      date: event.date,
      playerId: event.playerId,
      importance: importanceForTransaction(event.type, event.fromLevel, event.toLevel),
      source: "ORGANIZATION_TRANSACTION",
      fromLevel: event.fromLevel,
      toLevel: event.toLevel,
      position: event.position ?? null,
      reasonCodes: event.reasonCodes ?? []
    });
  }
  return next;
}

function recordRoleChangeCareerEvent(state, { playerId, date, level, fromRole, toRole } = {}) {
  if (!fromRole || !toRole || fromRole === toRole) return state;
  return appendCareerEvent(state, {
    type: "ROLE_CHANGED",
    date,
    playerId,
    importance: "NORMAL",
    source: "ROLE_SYSTEM",
    level,
    fromRole,
    toRole
  });
}

function careerMomentSpec(type, statValue = null) {
  const specs = {
    PRO_DEBUT: { importance: "MAJOR", reasonCodes: ["FIRST_PRO_APPEARANCE"] },
    MLB_DEBUT: { importance: "CAREER", reasonCodes: ["FIRST_MLB_APPEARANCE"] },
    FIRST_MLB_HIT: { importance: "MAJOR", reasonCodes: ["FIRST_MLB_HIT"] },
    FIRST_MLB_HR: { importance: "CAREER", reasonCodes: ["FIRST_MLB_HOME_RUN"] },
    FIRST_MLB_RBI: { importance: "MAJOR", reasonCodes: ["FIRST_MLB_RBI"] },
    FIRST_MLB_SB: { importance: "MAJOR", reasonCodes: ["FIRST_MLB_STEAL"] }
  };
  const spec = specs[type];
  if (!spec) throw new RangeError(`지원하지 않는 career moment type입니다: ${type}`);
  return { ...spec, statValue };
}

/**
 * Completed official game results are the trigger source for early-career
 * moments. The function is career-once: each momentKey is recorded at most once
 * even if save/load or finalization is retried.
 */
function recordGameCareerMoments(state, {
  playerId,
  date,
  level,
  gameId,
  appeared = false,
  battingLine = null,
  teamId = null,
  opponentTeamId = null,
  momentContexts = null
} = {}) {
  if (!appeared) return state;
  assertPlayerId(playerId);
  assertIsoDate(date, "career moment date");
  const line = battingLine ?? {};
  const context = { date, playerId, source: "OFFICIAL_GAME_RESULT", level, gameId, teamId, opponentTeamId, careerOnce: true };
  let next = state;
  const add = (type, statValue = null) => {
    const spec = careerMomentSpec(type, statValue);
    const gameContext = momentContexts?.[type] ?? (["PRO_DEBUT", "MLB_DEBUT"].includes(type) ? (momentContexts?.APPEARANCE ?? null) : null);
    next = appendCareerEvent(next, { ...context, type, momentKey: type, importance: spec.importance, reasonCodes: spec.reasonCodes, statValue, gameContext });
  };

  add("PRO_DEBUT");
  if (level !== "MLB") return next;
  add("MLB_DEBUT");
  if (Number(line.H ?? 0) > 0) add("FIRST_MLB_HIT", Number(line.H));
  if (Number(line.HR ?? 0) > 0) add("FIRST_MLB_HR", Number(line.HR));
  if (Number(line.RBI ?? 0) > 0) add("FIRST_MLB_RBI", Number(line.RBI));
  if (Number(line.SB ?? 0) > 0) add("FIRST_MLB_SB", Number(line.SB));
  return next;
}

function seedCompletedCareerMoments(state, completedMomentKeys = []) {
  const normalized = normalizeCareerEventState(state, {
    userPlayerId: state?.events?.[0]?.playerId,
    startDate: state?.events?.[0]?.date,
    initialLevel: state?.events?.[0]?.level ?? "AAA",
    organizationTransactions: []
  });
  const merged = normalizedMomentKeys([...(normalized.completedMomentKeys ?? []), ...completedMomentKeys]);
  return freeze({ ...normalized, completedMomentKeys: merged });
}

function validateStoredEvent(event, expectedSequence, userPlayerId) {
  if (!event || typeof event !== "object") throw new TypeError("career event object가 필요합니다.");
  if (event.schemaVersion !== 1) throw new RangeError("career event schema가 호환되지 않습니다.");
  if (event.sequence !== expectedSequence) throw new RangeError("career event sequence가 연속적이지 않습니다.");
  if (event.eventId !== `career_event_${String(expectedSequence).padStart(6, "0")}`) throw new RangeError("career eventId와 sequence가 일치하지 않습니다.");
  if (!CAREER_EVENT_TYPES.includes(event.type)) throw new RangeError(`지원하지 않는 career event type입니다: ${event.type}`);
  if (!CAREER_EVENT_IMPORTANCE.includes(event.importance)) throw new RangeError(`지원하지 않는 career event importance입니다: ${event.importance}`);
  assertIsoDate(event.date, "career event date");
  assertPlayerId(event.playerId);
  if (userPlayerId && event.playerId !== userPlayerId) throw new RangeError("career timeline에는 사용자 선수 event만 저장할 수 있습니다.");
  if (!Array.isArray(event.reasonCodes ?? [])) throw new TypeError("career event reasonCodes는 배열이어야 합니다.");
  if (event.momentKey !== null && event.momentKey !== undefined && !CAREER_MOMENT_KEYS.includes(event.momentKey)) throw new RangeError(`지원하지 않는 career moment key입니다: ${event.momentKey}`);
  if (event.careerOnce !== undefined && typeof event.careerOnce !== "boolean") throw new TypeError("career event careerOnce는 boolean이어야 합니다.");
  normalizeGameContext(event.gameContext);
}

function inferredInitialLevel(initialLevel, organizationTransactions, userPlayerId) {
  const first = [...(organizationTransactions ?? [])]
    .filter((event) => event?.playerId === userPlayerId && ["PLAYER_PROMOTED", "PLAYER_DEMOTED"].includes(event.type))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  return first?.fromLevel ?? initialLevel ?? "AAA";
}

function normalizeCareerEventState(state, {
  userPlayerId,
  startDate,
  initialLevel = "AAA",
  organizationTransactions = [],
  completedMomentKeys = []
} = {}) {
  assertPlayerId(userPlayerId);
  assertIsoDate(startDate, "career startDate");
  if (state && typeof state === "object" && state.schemaVersion === 1 && Array.isArray(state.events)) {
    state.events.forEach((event, index) => validateStoredEvent(event, index + 1, userPlayerId));
    const nextSequence = state.events.length + 1;
    if (state.nextSequence !== nextSequence) throw new RangeError("career event nextSequence가 events와 일치하지 않습니다.");
    const eventKeys = state.events.map((event) => event.momentKey ?? (CAREER_MOMENT_KEYS.includes(event.type) ? event.type : null)).filter(Boolean);
    return freeze({
      schemaVersion: 1,
      nextSequence,
      completedMomentKeys: normalizedMomentKeys([...(state.completedMomentKeys ?? []), ...eventKeys, ...completedMomentKeys]),
      events: state.events.map((event) => ({
        ...event,
        reasonCodes: [...(event.reasonCodes ?? [])],
        momentKey: event.momentKey ?? (CAREER_MOMENT_KEYS.includes(event.type) ? event.type : null),
        careerOnce: Boolean(event.careerOnce ?? CAREER_MOMENT_KEYS.includes(event.type)),
        gameId: event.gameId ?? null,
        teamId: event.teamId ?? null,
        opponentTeamId: event.opponentTeamId ?? null,
        statValue: event.statValue ?? null,
        gameContext: normalizeGameContext(event.gameContext)
      }))
    });
  }

  const startLevel = inferredInitialLevel(initialLevel, organizationTransactions, userPlayerId);
  let rebuilt = createCareerEventState({ userPlayerId, startDate, initialLevel: startLevel });
  const transactions = [...organizationTransactions]
    .filter((event) => event?.playerId === userPlayerId && ["PLAYER_PROMOTED", "PLAYER_DEMOTED"].includes(event.type))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.type === "PLAYER_PROMOTED" ? -1 : 1));
  rebuilt = recordOrganizationCareerEvents(rebuilt, transactions, { userPlayerId });
  if (completedMomentKeys.length) rebuilt = seedCompletedCareerMoments(rebuilt, completedMomentKeys);
  return rebuilt;
}

function getCareerTimelinePublicView(state) {
  if (!state) return freeze({ totalEvents: 0, events: [] });
  return freeze({
    totalEvents: state.events.length,
    events: [...state.events].sort((a, b) => b.sequence - a.sequence).map((event) => ({
      eventId: event.eventId,
      sequence: event.sequence,
      type: event.type,
      date: event.date,
      importance: event.importance,
      fromLevel: event.fromLevel,
      toLevel: event.toLevel,
      level: event.level,
      fromRole: event.fromRole,
      toRole: event.toRole,
      position: event.position,
      reasonCodes: [...(event.reasonCodes ?? [])],
      gameId: event.gameId ?? null,
      teamId: event.teamId ?? null,
      opponentTeamId: event.opponentTeamId ?? null,
      statValue: event.statValue ?? null,
      gameContext: normalizeGameContext(event.gameContext)
    }))
  });
}

export { CAREER_EVENT_TYPES, CAREER_EVENT_IMPORTANCE, CAREER_MOMENT_KEYS, createCareerEventState, appendCareerEvent, recordOrganizationCareerEvents, recordRoleChangeCareerEvent, recordGameCareerMoments, seedCompletedCareerMoments, normalizeCareerEventState, getCareerTimelinePublicView };
