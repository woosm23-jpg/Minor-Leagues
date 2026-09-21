const AVAILABILITY = Object.freeze({
  ACTIVE: "ACTIVE",
  INJURED_SHORT: "INJURED_SHORT",
  INJURED_60: "INJURED_60",
  INJURED_FULL_SEASON: "INJURED_FULL_SEASON",
  REHAB: "REHAB",
  DEVELOPMENT_LIST: "DEVELOPMENT_LIST",
  RESTRICTED: "RESTRICTED",
  TEMP_INACTIVE: "TEMP_INACTIVE",
  ADMIN_LEAVE: "ADMIN_LEAVE",
  NOT_REPORTED: "NOT_REPORTED",
  UNKNOWN: "UNKNOWN"
});

const KNOWN = new Set(Object.values(AVAILABILITY));

function canonicalAvailability(status, fallback = AVAILABILITY.UNKNOWN) {
  const raw = String(status ?? "").trim();
  if (!raw) return fallback;
  const upper = raw.toUpperCase().replace(/[–—]/g, "-");
  if (KNOWN.has(upper)) return upper;
  if (/REHAB/.test(upper)) return AVAILABILITY.REHAB;
  if (/DEVELOPMENT\s+LIST/.test(upper)) return AVAILABILITY.DEVELOPMENT_LIST;
  if (/RESTRICTED/.test(upper)) return AVAILABILITY.RESTRICTED;
  if (/ADMINISTRATIVE\s+LEAVE|ADMIN\s+LEAVE/.test(upper)) return AVAILABILITY.ADMIN_LEAVE;
  if (/NOT\s+YET\s+REPORTED|NOT\s+REPORTED/.test(upper)) return AVAILABILITY.NOT_REPORTED;
  if (/TEMPORARY\s+INACTIVE|BEREAVEMENT|PATERNITY|FAMILY\s+MEDICAL|SUSPENDED|TAXI\s+SQUAD|MILITARY\s+LEAVE|VOLUNTARILY\s+RETIRED/.test(upper)) return AVAILABILITY.TEMP_INACTIVE;
  if (/FULL\s+SEASON/.test(upper) && /INJUR|DISABL/.test(upper)) return AVAILABILITY.INJURED_FULL_SEASON;
  if (/60[- ]?DAY/.test(upper) && /INJUR|DISABL/.test(upper)) return AVAILABILITY.INJURED_60;
  if (/(7|10|15)[- ]?DAY/.test(upper) && /INJUR|DISABL/.test(upper)) return AVAILABILITY.INJURED_SHORT;
  if (/INJUR|DISABL/.test(upper)) return AVAILABILITY.INJURED_SHORT;
  if (/ACTIVE|OPTIONED|MINORS|ASSIGNED/.test(upper)) return AVAILABILITY.ACTIVE;
  return fallback;
}

function playerAssignedTeamId(player) {
  const value = player?.assignedTeamId ?? player?.teamId;
  return value == null ? null : String(value);
}

function playerAssignedLevel(player) {
  return player?.assignedLevel ?? player?.level ?? null;
}

function playerRosterStatus(player) {
  return player?.rosterStatus ?? player?.status ?? "UNKNOWN";
}

function playerAvailability(player) {
  if (player?.availability != null) return canonicalAvailability(player.availability);
  const status = playerRosterStatus(player);
  if (player?.active === false) return canonicalAvailability(status, AVAILABILITY.UNKNOWN);
  if (status === "UNKNOWN" || status == null || String(status).trim() === "") return AVAILABILITY.ACTIVE;
  return canonicalAvailability(status, AVAILABILITY.UNKNOWN);
}

function isPlayerGameAvailable(player) {
  return playerAvailability(player) === AVAILABILITY.ACTIVE && player?.active !== false;
}

function playerOrganizationId(player, teamById = null) {
  if (player?.organizationId != null) return String(player.organizationId);
  const assignedTeamId = playerAssignedTeamId(player);
  const team = assignedTeamId != null && teamById instanceof Map ? teamById.get(assignedTeamId) : null;
  if (team?.level === "MLB") return String(team.id);
  return team?.parentOrganizationId == null ? null : String(team.parentOrganizationId);
}

export {
  AVAILABILITY,
  canonicalAvailability,
  playerAssignedTeamId,
  playerAssignedLevel,
  playerRosterStatus,
  playerAvailability,
  isPlayerGameAvailable,
  playerOrganizationId
};
