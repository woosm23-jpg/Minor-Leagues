import { SeededRng, hashSeed } from "../rng.js";

const INJURY_STATE_VERSION = 1;
const INJURY_FAMILIES = Object.freeze(["LOWER_BODY", "UPPER_BODY", "HAND_WRIST", "BACK_CORE", "HEAD", "GENERAL"]);
const INJURY_SEVERITIES = Object.freeze(["DAY_TO_DAY", "MINOR", "MODERATE", "MAJOR", "SEASON_ENDING"]);

const SEVERITY_WINDOWS = Object.freeze({
  DAY_TO_DAY: Object.freeze([1, 3]),
  MINOR: Object.freeze([4, 14]),
  MODERATE: Object.freeze([14, 42]),
  MAJOR: Object.freeze([60, 180]),
  SEASON_ENDING: Object.freeze([120, 240])
});

const POSITION_FAMILY_WEIGHTS = Object.freeze({
  LOWER_BODY: 0.35,
  UPPER_BODY: 0.18,
  HAND_WRIST: 0.15,
  BACK_CORE: 0.12,
  HEAD: 0.05,
  GENERAL: 0.15
});

const PITCHER_FAMILY_WEIGHTS = Object.freeze({
  LOWER_BODY: 0.20,
  UPPER_BODY: 0.45,
  HAND_WRIST: 0.08,
  BACK_CORE: 0.15,
  HEAD: 0.02,
  GENERAL: 0.10
});

const SEVERITY_WEIGHTS = Object.freeze({
  DAY_TO_DAY: 0.58,
  MINOR: 0.29,
  MODERATE: 0.10,
  MAJOR: 0.028,
  SEASON_ENDING: 0.002
});

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`유효한 날짜가 아닙니다: ${isoDate}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weightedChoice(rng, weights) {
  const rows = Object.entries(weights);
  const total = rows.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.next() * total;
  for (const [key, weight] of rows) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return rows[rows.length - 1][0];
}

function deterministicDurability(playerId, kind) {
  const hash = hashSeed(`injury-durability-v${INJURY_STATE_VERSION}:${kind}:${playerId}`);
  return 48 + (hash % 31); // 48-78; stable hidden physical availability tool for pre-real-data fixtures.
}

function deterministicAge(playerId, kind) {
  const hash = hashSeed(`injury-age-v${INJURY_STATE_VERSION}:${kind}:${playerId}`);
  return kind === "PITCHER" ? 21 + (hash % 14) : 19 + (hash % 15);
}

function emptyHistory() {
  return { total: 0, major: 0, byFamily: Object.fromEntries(INJURY_FAMILIES.map((family) => [family, 0])), recent: [] };
}

function createHealthState(player, { kind = "POSITION" } = {}) {
  if (!player?.id) throw new TypeError("health state에는 player.id가 필요합니다.");
  const explicit = Number(player?.physical?.durability);
  const durability = Number.isFinite(explicit) ? clamp(Math.round(explicit), 20, 99) : deterministicDurability(player.id, kind);
  const explicitAge = Number(player?.physical?.age);
  const age = Number.isFinite(explicitAge) ? clamp(Math.round(explicitAge), 16, 50) : deterministicAge(player.id, kind);
  return freeze({
    version: INJURY_STATE_VERSION,
    durability,
    age,
    activeInjury: null,
    history: emptyHistory()
  });
}

function normalizeHealthState(health, player, { kind = "POSITION" } = {}) {
  const base = createHealthState(player, { kind });
  if (!health) return base;
  const history = {
    ...base.history,
    ...(health.history ?? {}),
    byFamily: { ...base.history.byFamily, ...(health.history?.byFamily ?? {}) },
    recent: Array.isArray(health.history?.recent) ? health.history.recent.slice(-12) : []
  };
  const active = health.activeInjury ? {
    ...health.activeInjury,
    daysRemaining: Math.max(0, Math.round(Number(health.activeInjury.daysRemaining ?? 0)))
  } : null;
  return freeze({
    ...base,
    ...health,
    version: INJURY_STATE_VERSION,
    durability: clamp(Math.round(Number(health.durability ?? base.durability)), 20, 99),
    age: clamp(Math.round(Number(health.age ?? base.age)), 16, 50),
    activeInjury: active && active.daysRemaining > 0 ? active : null,
    history
  });
}

function healthAvailability(health) {
  return health?.activeInjury?.daysRemaining > 0 ? "INJURED" : "AVAILABLE";
}

function isHealthAvailable(health) {
  return healthAvailability(health) === "AVAILABLE";
}

function advanceHealthState(health, days = 1) {
  if (!Number.isInteger(days) || days < 0) throw new RangeError("days는 0 이상의 정수여야 합니다.");
  if (days === 0 || !health?.activeInjury) return health;
  const remaining = Math.max(0, Number(health.activeInjury.daysRemaining ?? 0) - days);
  if (remaining <= 0) return freeze({ ...health, activeInjury: null });
  return freeze({ ...health, activeInjury: { ...health.activeInjury, daysRemaining: remaining } });
}

function baseRisk(activity) {
  if (activity === "PITCHER_START") return 0.0032;
  if (activity === "PITCHER_RELIEF") return 0.0022;
  if (activity === "CATCHER_START") return 0.0020;
  if (activity === "POSITION_START") return 0.0015;
  if (activity === "DEFENSIVE_REPLACEMENT") return 0.0008;
  if (activity === "PINCH_RUN") return 0.00065;
  if (activity === "PINCH_HIT") return 0.00045;
  return 0.0010;
}

function ageFactor(age) {
  const value = Number.isFinite(Number(age)) ? Number(age) : 26;
  if (value <= 22) return 0.92;
  if (value <= 29) return 1.0;
  if (value <= 34) return 1.14;
  return 1.30;
}

function riskFor({ health, fatigue = 0, age = null, activity = "POSITION_START" }) {
  const resolvedAge = Number.isFinite(Number(age)) ? Number(age) : Number(health?.age ?? 26);
  const fatigueFactor = 0.78 + clamp(Number(fatigue) || 0, 0, 100) / 100 * 1.28;
  const durability = clamp(Number(health?.durability ?? 60), 20, 99);
  const durabilityFactor = 1.52 - durability / 100;
  const historyFactor = 1 + Math.min(5, Number(health?.history?.total ?? 0)) * 0.08;
  return clamp(baseRisk(activity) * fatigueFactor * durabilityFactor * ageFactor(resolvedAge) * historyFactor, 0, 0.025);
}

function severityFor(rng, health) {
  const history = Number(health?.history?.major ?? 0);
  if (history <= 0) return weightedChoice(rng, SEVERITY_WEIGHTS);
  // Prior major injuries very slightly shift future injuries toward longer absences without making recurrence deterministic.
  return weightedChoice(rng, {
    DAY_TO_DAY: Math.max(0.50, SEVERITY_WEIGHTS.DAY_TO_DAY - history * 0.02),
    MINOR: SEVERITY_WEIGHTS.MINOR,
    MODERATE: SEVERITY_WEIGHTS.MODERATE + history * 0.012,
    MAJOR: SEVERITY_WEIGHTS.MAJOR + history * 0.007,
    SEASON_ENDING: SEVERITY_WEIGHTS.SEASON_ENDING + history * 0.001
  });
}

function durationFor(rng, severity) {
  const [min, max] = SEVERITY_WINDOWS[severity] ?? SEVERITY_WINDOWS.MINOR;
  return rng.int(min, max);
}

function maybeApplyInjury(health, player, {
  seed,
  date,
  fatigue = 0,
  age = null,
  activity = "POSITION_START",
  kind = "POSITION",
  force = null
} = {}) {
  if (!health || !player?.id) throw new TypeError("injury check에는 health와 player가 필요합니다.");
  if (health.activeInjury) return freeze({ health, event: null, risk: 0 });
  if (typeof seed !== "string" || !seed) throw new TypeError("injury check seed가 필요합니다.");
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("injury check date가 필요합니다.");

  const rng = new SeededRng(`injury-v${INJURY_STATE_VERSION}:${seed}:${player.id}`);
  const risk = riskFor({ health, fatigue, age, activity });
  const forcedSeverity = force?.severity ?? null;
  if (!forcedSeverity && rng.next() >= risk) return freeze({ health, event: null, risk });

  const familyWeights = kind === "PITCHER" ? PITCHER_FAMILY_WEIGHTS : POSITION_FAMILY_WEIGHTS;
  const family = force?.family ?? weightedChoice(rng, familyWeights);
  const severity = forcedSeverity ?? severityFor(rng, health);
  if (!INJURY_FAMILIES.includes(family)) throw new RangeError(`지원하지 않는 injury family입니다: ${family}`);
  if (!INJURY_SEVERITIES.includes(severity)) throw new RangeError(`지원하지 않는 injury severity입니다: ${severity}`);
  const days = force?.days ?? durationFor(rng, severity);
  const injuryId = `inj_${hashSeed(`${seed}:${player.id}:${date}:${family}:${severity}`)}`;
  const activeInjury = Object.freeze({
    injuryId,
    family,
    severity,
    startDate: date,
    expectedReturnDate: addDays(date, days),
    daysRemaining: days,
    activity,
    reinjuryRisk: Number(clamp(0.04 + (health.history?.byFamily?.[family] ?? 0) * 0.025 + (severity === "MAJOR" || severity === "SEASON_ENDING" ? 0.04 : 0), 0.04, 0.22).toFixed(3))
  });
  const history = {
    total: Number(health.history?.total ?? 0) + 1,
    major: Number(health.history?.major ?? 0) + (["MAJOR", "SEASON_ENDING"].includes(severity) ? 1 : 0),
    byFamily: { ...emptyHistory().byFamily, ...(health.history?.byFamily ?? {}), [family]: Number(health.history?.byFamily?.[family] ?? 0) + 1 },
    recent: [...(health.history?.recent ?? []), { injuryId, family, severity, startDate: date, expectedReturnDate: activeInjury.expectedReturnDate, days }].slice(-12)
  };
  const next = freeze({ ...health, activeInjury, history });
  return freeze({ health: next, event: activeInjury, risk });
}

function getHealthPublicView(health) {
  if (!health) return null;
  const injury = health.activeInjury;
  return freeze({
    availability: healthAvailability(health),
    durability: Number(health.durability ?? 60),
    injury: injury ? {
      injuryId: injury.injuryId,
      family: injury.family,
      severity: injury.severity,
      startDate: injury.startDate,
      expectedReturnDate: injury.expectedReturnDate,
      daysRemaining: injury.daysRemaining,
      reinjuryRisk: injury.reinjuryRisk
    } : null,
    history: {
      total: Number(health.history?.total ?? 0),
      major: Number(health.history?.major ?? 0),
      recent: Object.freeze((health.history?.recent ?? []).slice(-5).map((row) => Object.freeze({ ...row })))
    }
  });
}

export { INJURY_STATE_VERSION, INJURY_FAMILIES, INJURY_SEVERITIES, createHealthState, normalizeHealthState, healthAvailability, isHealthAvailable, advanceHealthState, maybeApplyInjury, getHealthPublicView };
