import { createNeutralPark } from "../engine/pa/parkGeometry.js";

const WALL_KEYS = Object.freeze([
  ["lfLine", -45],
  ["lfGap", -22.5],
  ["cf", 0],
  ["rfGap", 22.5],
  ["rfLine", 45]
]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freeze(item)])));
  }
  return value;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sourceWallHeight(sourcePark, key, fallback) {
  const aliases = {
    lfLine: ["lfLine", "leftLine", "LF", "leftField"],
    lfGap: ["lfGap", "leftCenter", "LCF"],
    cf: ["cf", "center", "CF"],
    rfGap: ["rfGap", "rightCenter", "RCF"],
    rfLine: ["rfLine", "rightLine", "RF", "rightField"]
  };
  for (const alias of aliases[key] ?? [key]) {
    const n = finite(sourcePark?.wallHeights?.[alias]);
    if (n != null) return clamp(n, 0, 60);
  }
  return fallback;
}

function sourceCarryFactor(sourcePark) {
  const empirical = sourcePark?.empiricalFactors ?? null;
  const factor = finite(empirical?.homeRuns) ?? finite(empirical?.overall);
  if (factor != null && factor > 0) {
    const normalized = factor > 2 ? factor / 100 : factor;
    return clamp(normalized, 0.85, 1.15);
  }
  return 1;
}

function buildEngineParkFromSnapshotPark(sourcePark) {
  if (!sourcePark || typeof sourcePark !== "object") return null;
  const neutral = createNeutralPark();
  const geometry = sourcePark.geometry ?? {};
  const wallProfile = [];

  for (let index = 0; index < WALL_KEYS.length; index += 1) {
    const [key, angleDegrees] = WALL_KEYS[index];
    const distanceFt = finite(geometry[key]);
    if (distanceFt == null || distanceFt < 250 || distanceFt > 500) return null;
    wallProfile.push({
      angleDegrees,
      distanceFt,
      heightFt: sourceWallHeight(sourcePark, key, neutral.wallProfile[index].heightFt)
    });
  }

  return freeze({
    id: `MLB_VENUE_${String(sourcePark.venueId)}`,
    sourceVenueId: String(sourcePark.venueId),
    sourceTeamId: sourcePark.teamId == null ? null : String(sourcePark.teamId),
    name: sourcePark.name ?? `Venue ${sourcePark.venueId}`,
    carryFactor: sourceCarryFactor(sourcePark),
    wallProfile,
    source: "PRODUCTION_SNAPSHOT"
  });
}

function resolveProductionGamePark({
  parks,
  scheduleGame,
  homeTeamId = scheduleGame?.homeTeamId ?? null,
  level = null
} = {}) {
  if (level != null && level !== "MLB") return null;
  if (!Array.isArray(parks) || parks.length === 0) return null;

  const venueId = scheduleGame?.venueId == null ? null : String(scheduleGame.venueId);
  const teamId = homeTeamId == null ? null : String(homeTeamId);

  const sourcePark =
    (venueId ? parks.find((park) => String(park?.venueId) === venueId) : null) ??
    (teamId ? parks.find((park) => String(park?.teamId) === teamId) : null) ??
    null;

  return buildEngineParkFromSnapshotPark(sourcePark);
}

export { buildEngineParkFromSnapshotPark, resolveProductionGamePark };
