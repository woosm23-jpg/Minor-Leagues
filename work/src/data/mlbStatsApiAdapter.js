const LEVEL_BY_SPORT = Object.freeze({ 1: "MLB", 11: "AAA", 12: "AA", 13: "HIGH_A", 14: "A" });
export const MLB_STATS_SPORT_IDS = Object.freeze([1, 11, 12, 13, 14]);
export const MLB_STATS_BASE_URL = "https://statsapi.mlb.com/api/v1";

function text(value) { return value == null ? null : String(value); }
function levelForSport(sportId) { return LEVEL_BY_SPORT[Number(sportId)] ?? null; }
function sourceId(kind, sportId = null) { return sportId == null ? `mlb_stats_${kind}` : `mlb_stats_${kind}_sport_${sportId}`; }

export function masterSnapshotSourceCatalog({ season, retrievedAt }) {
  return Object.freeze([
    Object.freeze({ id: "mlb_stats_teams", name: "MLB Stats API — teams/affiliates", url: `${MLB_STATS_BASE_URL}/teams`, retrievedAt, notes: `season=${season}; sportIds=${MLB_STATS_SPORT_IDS.join(",")}` }),
    Object.freeze({ id: "mlb_stats_rosters", name: "MLB Stats API — team rosters", url: `${MLB_STATS_BASE_URL}/teams/{teamId}/roster`, retrievedAt, notes: `season=${season}` }),
    Object.freeze({ id: "mlb_stats_stats", name: "MLB Stats API — standard player stats", url: `${MLB_STATS_BASE_URL}/stats`, retrievedAt, notes: `season=${season}; groups=hitting,pitching,fielding` }),
    Object.freeze({ id: "mlb_stats_schedule", name: "MLB Stats API — schedules", url: `${MLB_STATS_BASE_URL}/schedule`, retrievedAt, notes: `season=${season}; gameTypes=R` }),
    Object.freeze({ id: "mlb_stats_venues", name: "MLB Stats API — venue field geometry", url: `${MLB_STATS_BASE_URL}/venues/{venueId}`, retrievedAt, notes: `season=${season}; MLB home venues` })
  ]);
}

export function normalizeTeamsResponse(raw, { sportId }) {
  const level = levelForSport(sportId);
  if (!level) throw new RangeError(`지원하지 않는 sportId입니다: ${sportId}`);
  return (raw?.teams ?? []).map((team) => ({
    id: text(team.id), name: team.name, abbreviation: team.abbreviation ?? team.teamCode ?? "", level,
    parentOrganizationId: level === "MLB" ? text(team.id) : text(team.parentOrg?.id ?? team.parentOrganization?.id ?? team.parentOrgId),
    leagueId: text(team.league?.id), divisionId: text(team.division?.id), venueId: text(team.venue?.id), active: team.active !== false,
    sourceId: sourceId("teams", sportId)
  }));
}

export function normalizeRosterResponse(raw, { team, sportId }) {
  const level = levelForSport(sportId);
  if (!level) throw new RangeError(`지원하지 않는 sportId입니다: ${sportId}`);
  return (raw?.roster ?? []).map((row) => {
    const p = row.person ?? {};
    return {
      id: text(p.id), fullName: p.fullName ?? p.fullFMLName ?? `Player ${p.id}`, teamId: text(team.id), level,
      status: row.status?.description ?? row.status?.code ?? "UNKNOWN", position: row.position?.abbreviation ?? p.primaryPosition?.abbreviation ?? "UNK",
      birthDate: p.birthDate ?? null, age: p.currentAge ?? null, bats: p.batSide?.code ?? null, throws: p.pitchHand?.code ?? null,
      height: p.height ?? null, weight: p.weight ?? null, mlbDebutDate: p.mlbDebutDate ?? null, active: p.active !== false,
      sourceId: sourceId("rosters", sportId)
    };
  });
}

export function normalizeStatsResponse(raw, { sportId, group, season }) {
  const level = levelForSport(sportId);
  if (!level) throw new RangeError(`지원하지 않는 sportId입니다: ${sportId}`);
  const rows = [];
  for (const block of raw?.stats ?? []) {
    for (const split of block?.splits ?? []) {
      const person = split.player ?? split.person ?? {};
      if (person.id == null) continue;
      rows.push({
        playerId: text(person.id), teamId: text(split.team?.id), level, season: Number(split.season ?? season), group,
        gameType: split.gameType ?? "R", position: split.position?.abbreviation ?? split.position?.code ?? null, values: { ...(split.stat ?? {}) }, sourceId: sourceId("stats", sportId)
      });
    }
  }
  return rows;
}

export function normalizeScheduleResponse(raw, { sportId }) {
  const level = levelForSport(sportId);
  if (!level) throw new RangeError(`지원하지 않는 sportId입니다: ${sportId}`);
  const games = [];
  for (const date of raw?.dates ?? []) {
    for (const game of date?.games ?? []) {
      games.push({
        gamePk: text(game.gamePk), date: String(date.date ?? game.officialDate).slice(0, 10), level, gameType: game.gameType ?? "R",
        status: game.status?.abstractGameState ?? game.status?.detailedState ?? "SCHEDULED",
        awayTeamId: text(game.teams?.away?.team?.id), homeTeamId: text(game.teams?.home?.team?.id),
        awayScore: game.teams?.away?.score ?? null, homeScore: game.teams?.home?.score ?? null, venueId: text(game.venue?.id),
        sourceId: sourceId("schedule", sportId)
      });
    }
  }
  return games;
}

function collectTeamLike(value, out = []) {
  if (Array.isArray(value)) for (const item of value) collectTeamLike(item, out);
  else if (value && typeof value === "object") {
    if (value.id != null && value.name && (value.sport?.id != null || value.sportId != null)) out.push(value);
    for (const child of Object.values(value)) if (child && typeof child === "object") collectTeamLike(child, out);
  }
  return out;
}

export function normalizeAffiliatesResponse(raw, { organizationId, season }) {
  const seen = new Set();
  const rows = [];
  for (const team of collectTeamLike(raw)) {
    const level = levelForSport(team.sport?.id ?? team.sportId);
    const teamId = text(team.id);
    if (!level || level === "MLB" || !teamId || seen.has(`${level}:${teamId}`)) continue;
    seen.add(`${level}:${teamId}`);
    rows.push({ organizationId: text(organizationId), mlbTeamId: text(organizationId), level, teamId, effectiveSeason: Number(season), sourceId: "mlb_stats_teams" });
  }
  return rows;
}

export function normalizeAffiliationsFromTeams(teams, { season }) {
  return teams.filter((team) => team.level !== "MLB" && team.parentOrganizationId).map((team) => ({
    organizationId: String(team.parentOrganizationId), mlbTeamId: String(team.parentOrganizationId), level: team.level,
    teamId: String(team.id), effectiveSeason: Number(season), sourceId: team.sourceId ?? "mlb_stats_teams"
  }));
}

function parkNumber(value) {
  if (value == null || value === "") return null;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

/** Normalize MLB Stats API venue fieldInfo into v46 park geometry input. */
export function normalizeVenueResponse(raw, { team = null } = {}) {
  const venue = raw?.venues?.[0] ?? raw?.venue ?? raw;
  if (!venue?.id) return null;
  const f = venue.fieldInfo ?? {};
  const geometry = {
    lfLine: parkNumber(f.leftLine), lfGap: parkNumber(f.leftCenter), cf: parkNumber(f.center),
    rfGap: parkNumber(f.rightCenter), rfLine: parkNumber(f.rightLine)
  };
  if (Object.values(geometry).some((value) => value == null)) return null;
  return {
    venueId: text(venue.id), teamId: team?.id == null ? null : text(team.id), name: venue.name ?? team?.name ?? `Venue ${venue.id}`,
    geometry, wallHeights: {}, empiricalFactors: null, carryDistanceFeet: 0, sourceId: "mlb_stats_venues"
  };
}

/** Merge exported Baseball Savant park-factor rows. Factors remain calibration references. */
export function mergeSavantParkFactors(parks, rows = []) {
  const byVenue = new Map();
  for (const row of rows ?? []) {
    const venueId = text(row.venueId ?? row.venue_id ?? row.venueID);
    if (!venueId) continue;
    byVenue.set(venueId, {
      window: row.window ?? row.seasonWindow ?? null,
      overall: Number(row.overall ?? row.parkFactor ?? row.index_wOBA ?? 100), runs: Number(row.runs ?? row.R ?? 100),
      singles: Number(row.singles ?? row["1B"] ?? 100), doubles: Number(row.doubles ?? row["2B"] ?? 100), triples: Number(row.triples ?? row["3B"] ?? 100),
      homeRuns: Number(row.homeRuns ?? row.HR ?? 100), handedness: row.handedness ?? row.batSide ?? "ALL"
    });
  }
  return (parks ?? []).map((park) => ({ ...park, empiricalFactors: byVenue.get(String(park.venueId)) ?? park.empiricalFactors ?? null }));
}
