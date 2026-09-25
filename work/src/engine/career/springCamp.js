// A pre-camp *outlook*, not an exhibition result or an Opening Day decision.
// No scouting ceiling, user boost, RNG, game record or roster transaction here.
const SPRING_CHOICES = Object.freeze(["OPEN", "MLB_BENCH", "AAA_EVERYDAY"]);
const SECURITY = Object.freeze(["LOCKED", "LIKELY", "BUBBLE", "LONG_SHOT"]);
const FIELD_POSITIONS = new Set(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "DH"]);

function validateSpringRolePreference(value, label = "springRolePreference") {
  if (value == null) return true; // Historical saves predate the player choice.
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !SPRING_CHOICES.includes(value.mode) ||
      typeof value.requestedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.requestedDate)) {
    throw new RangeError(`${label} 스프링 역할 선호가 잘못되었습니다.`);
  }
  return true;
}

function setSpringRolePreference(state, mode, date) {
  if (!state?.playerId || !SPRING_CHOICES.includes(mode) ||
      typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError("스프링 역할 선호 선택이 잘못되었습니다.");
  }
  if (state.springRolePreference?.mode === mode) return state;
  return Object.freeze({ ...state, springRolePreference: Object.freeze({mode, requestedDate:date}) });
}

function buildSpringCampOutlook({ organization, playerId, playerState,
  roleState = null, rosterControl = null, targetYear, date } = {}) {
  if (!organization?.levels || !playerState || playerState.playerId !== playerId ||
      !Number.isInteger(targetYear) || typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TypeError("스프링 예비평가에 선수와 조직·연도·날짜가 필요합니다.");
  }
  validateSpringRolePreference(playerState.springRolePreference ?? null);
  const level = organization.userLevel ?? roleState?.level ?? "AAA";
  const roster = organization.levels[level]?.roster;
  const player = roster?.players?.[playerId];
  if (!player) throw new RangeError("스프링 예비평가 선수가 현재 조직 로스터에 없습니다.");
  const position = playerState.primaryPosition ?? player.positioning?.primaryPosition ?? "DH";
  if (!FIELD_POSITIONS.has(position)) throw new RangeError("스프링 포지션이 지원되지 않습니다.");
  const mlbRoster = organization.levels.MLB?.roster;
  const directMlbCompetition = (mlbRoster?.positionPlayers ?? []).filter((id) => {
    if (String(id) === String(playerId)) return false;
    const other = mlbRoster.players?.[id];
    return other?.positioning?.primaryPosition === position;
  }).length;
  const injured = Number(playerState.health?.activeInjury?.daysRemaining ?? 0) > 0;
  const on40Man = rosterControl?.on40Man === true;
  const role = roleState?.role ?? null;
  let security = "LONG_SHOT";
  if (!injured && level === "MLB" && on40Man && role === "STARTER" &&
      Number(roleState?.gamesTracked ?? 0) >= 20 && directMlbCompetition === 0) security = "LOCKED";
  else if (!injured && level === "MLB" && on40Man && role === "STARTER") security = "LIKELY";
  else if (!injured && (level === "MLB" || (level === "AAA" && on40Man))) security = "BUBBLE";
  const preference = playerState.springRolePreference?.mode ?? "OPEN";
  return Object.freeze({
    schemaVersion: 1, status: "PRE_CAMP_OUTLOOK", targetYear, evaluatedDate:date,
    level, primaryPosition:position, rosterSecurity:security,
    on40Man, injured, currentRole:role,
    directMlbCompetition, preference,
    springGamesPlayed:0, springStats:null,
    regularSeasonStatsAffected:false,
    rosterDecisionMade:false,
    evidence:"CURRENT_ORGANIZATION_ROSTER_AND_ASSIGNED_ROLE"
  });
}

function validateSpringCampOutlook(value, label = "springCampOutlook") {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.status !== "PRE_CAMP_OUTLOOK" ||
      !Number.isInteger(value.targetYear) || !SECURITY.includes(value.rosterSecurity) ||
      !SPRING_CHOICES.includes(value.preference) || !FIELD_POSITIONS.has(value.primaryPosition) ||
      !Number.isInteger(value.directMlbCompetition) || value.directMlbCompetition < 0 ||
      value.springGamesPlayed !== 0 || value.springStats !== null ||
      value.regularSeasonStatsAffected !== false || value.rosterDecisionMade !== false) {
    throw new RangeError(`${label} 스프링 예비평가 데이터가 잘못되었습니다.`);
  }
  return true;
}

export {SPRING_CHOICES, validateSpringRolePreference, setSpringRolePreference,
  buildSpringCampOutlook, validateSpringCampOutlook};
