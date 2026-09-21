import { SeededRng } from "../rng.js";

const RETIREMENT_MODEL_VERSION = 1;

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function finite(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function playerAge(player) {
  return clamp(Math.round(finite(player?.physical?.age ?? player?.age, 27)), 16, 50);
}

function playerOverall(player) {
  return clamp(finite(player?.ovr ?? player?.overall, 50), 20, 99);
}

function agePressure(age) {
  if (age <= 29) return 0.002;
  if (age === 30) return 0.006;
  if (age === 31) return 0.012;
  if (age === 32) return 0.025;
  if (age === 33) return 0.045;
  if (age === 34) return 0.075;
  if (age === 35) return 0.125;
  if (age === 36) return 0.20;
  if (age === 37) return 0.31;
  if (age === 38) return 0.44;
  if (age === 39) return 0.58;
  if (age === 40) return 0.70;
  if (age === 41) return 0.80;
  if (age === 42) return 0.88;
  return clamp(0.91 + (age - 43) * 0.02, 0, 0.98);
}

function abilityAdjustment(ovr) {
  if (ovr >= 75) return -0.18;
  if (ovr >= 65) return -0.12;
  if (ovr >= 58) return -0.075;
  if (ovr >= 50) return -0.025;
  if (ovr >= 43) return 0.025;
  if (ovr >= 36) return 0.075;
  return 0.13;
}

function marketAdjustment(market = {}) {
  const majorOffers = Math.max(0, Math.round(finite(market.majorLeagueOffers, 0)));
  const minorOffers = Math.max(0, Math.round(finite(market.minorLeagueOffers, 0)));
  if (majorOffers > 0) return -0.17;
  if (minorOffers > 0) return 0.035;
  // Missing market evidence is unknown, not "zero offers". Retirement pressure
  // only gets the no-market penalty after the veteran actually tests the market.
  if (market.testedMarket !== true) return 0;
  return 0.16;
}

function opportunityAdjustment(context = {}) {
  const opportunity = clamp(finite(context.playingTimeOpportunity, 0.5), 0, 1);
  const role = String(context.role ?? "").toUpperCase();
  let value = (0.5 - opportunity) * 0.16;
  if (["MLB_STARTER", "STARTER", "CLOSER", "MLB_REGULAR"].includes(role)) value -= 0.045;
  if (["DEPTH", "BENCH", "MINORS", "OUT_OF_ORG"].includes(role)) value += 0.04;
  return value;
}

function declineAdjustment(context = {}) {
  const decline = clamp(finite(context.recentOvrDecline, 0), 0, 20);
  return clamp(decline * 0.012, 0, 0.16);
}

function injuryAdjustment(player, context = {}) {
  const durability = clamp(finite(context.durability ?? player?.physical?.durability, 50), 20, 99);
  const missedShare = clamp(finite(context.recentInjuryMissedShare, 0), 0, 1);
  const majorInjury = context.majorInjury === true ? 1 : 0;
  return clamp((50 - durability) * 0.002 + missedShare * 0.12 + majorInjury * 0.06, -0.05, 0.18);
}

function evaluateRetirementPressure({ player, context = {}, market = {}, seasonKey = "", seed = "", isUser = false } = {}) {
  if (!player?.id) throw new TypeError("retirement 평가에는 player.id가 필요합니다.");
  const age = playerAge(player);
  const overall = playerOverall(player);
  const components = {
    age: agePressure(age),
    ability: abilityAdjustment(overall),
    market: marketAdjustment(market),
    opportunity: opportunityAdjustment(context),
    decline: declineAdjustment(context),
    injury: injuryAdjustment(player, context)
  };
  let probability = Object.values(components).reduce((a, b) => a + b, 0);
  if (age < 30) probability = Math.min(probability, 0.02);
  if (age < 27) probability = Math.min(probability, 0.003);
  probability = clamp(probability, 0, 0.985);

  const reasonCodes = [];
  if (age >= 36) reasonCodes.push("AGE");
  if (overall < 43) reasonCodes.push("ABILITY_DECLINE");
  if (finite(context.recentOvrDecline, 0) >= 3) reasonCodes.push("RECENT_DECLINE");
  if (market.testedMarket === true && finite(market.majorLeagueOffers, 0) <= 0 && finite(market.minorLeagueOffers, 0) <= 0) reasonCodes.push("NO_MARKET");
  if (clamp(finite(context.playingTimeOpportunity, 0.5), 0, 1) < 0.25) reasonCodes.push("LOW_OPPORTUNITY");
  if (finite(context.recentInjuryMissedShare, 0) >= 0.35 || context.majorInjury === true) reasonCodes.push("INJURY");

  const rng = new SeededRng(`retirement-v${RETIREMENT_MODEL_VERSION}:${seed}:${seasonKey}:${player.id}`);
  const roll = rng.next();
  const wouldRetire = roll < probability;
  return freeze({
    version: RETIREMENT_MODEL_VERSION,
    playerId: String(player.id),
    age,
    overall: Number(overall.toFixed(2)),
    probability: Number(probability.toFixed(6)),
    roll: Number(roll.toFixed(6)),
    forcedRetirement: isUser ? false : wouldRetire,
    userMayChooseRetirement: isUser && (age >= 30 || market.testedMarket === true),
    reasonCodes,
    components
  });
}

function evaluateAiRetirements(players, options = {}) {
  if (!Array.isArray(players)) throw new TypeError("players 배열이 필요합니다.");
  const contextById = options.contextById instanceof Map ? options.contextById : new Map(Object.entries(options.contextById ?? {}));
  const marketById = options.marketById instanceof Map ? options.marketById : new Map(Object.entries(options.marketById ?? {}));
  const decisions = players.map((player) => evaluateRetirementPressure({
    player,
    context: contextById.get(String(player.id)) ?? {},
    market: marketById.get(String(player.id)) ?? {},
    seasonKey: options.seasonKey ?? "",
    seed: options.seed ?? "",
    isUser: String(player.id) === String(options.userPlayerId ?? "")
  }));
  return freeze({ decisions, retiredIds: decisions.filter((d) => d.forcedRetirement).map((d) => d.playerId) });
}

export { RETIREMENT_MODEL_VERSION, evaluateRetirementPressure, evaluateAiRetirements };
