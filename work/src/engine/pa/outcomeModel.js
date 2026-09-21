import { calibrationConfig } from "../../config/calibration.js";
import { ratingToLatent } from "../ratings/latentRating.js";

const PA_OUTCOMES = Object.freeze(["BB", "HBP", "K", "BIP"]);
const PA_APPROACHES = Object.freeze(["BALANCED", "AGGRESSIVE", "CONTACT", "PATIENT"]);

function assertProbability(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new RangeError(`${label} 확률은 0과 1 사이의 유한한 값이어야 합니다.`);
  }
}

function assertResolvedContext(context) {
  if (!context || typeof context !== "object") {
    throw new TypeError("PA context가 필요합니다.");
  }

  if (!context.hitter || !context.pitcher) {
    throw new TypeError("PA context에는 hitter와 pitcher가 필요합니다.");
  }

  for (const key of ["contact", "vision", "discipline"]) {
    ratingToLatent(context.hitter[key]);
  }

  for (const key of ["control", "pitchability", "stuff"]) {
    ratingToLatent(context.pitcher[key]);
  }

  const approach = context.approach ?? "BALANCED";
  if (!PA_APPROACHES.includes(approach)) {
    throw new RangeError(`지원하지 않는 PA approach입니다: ${approach}`);
  }
}

function softmax(logits) {
  const maxLogit = Math.max(...Object.values(logits));
  const exponentials = Object.fromEntries(
    Object.entries(logits).map(([key, value]) => [key, Math.exp(value - maxLogit)])
  );
  const denominator = Object.values(exponentials).reduce((sum, value) => sum + value, 0);

  return Object.freeze(
    Object.fromEntries(
      Object.entries(exponentials).map(([key, value]) => [key, value / denominator])
    )
  );
}

/**
 * Returns the Phase 0 BB/HBP/K/BIP competition probabilities.
 *
 * Important: pitcher.stuff is a RESOLVED/DERIVED matchup input. It is not a
 * foundational stored pitcher rating. A later PAContext builder will derive it
 * from the pitch arsenal/role before calling this pure outcome model.
 */
function getPAOutcomeProbabilities(context, config = calibrationConfig) {
  assertResolvedContext(context);

  const target = config.neutral.paOutcome;
  for (const outcome of PA_OUTCOMES) {
    assertProbability(target[outcome], `neutral.${outcome}`);
  }

  const approach = context.approach ?? "BALANCED";
  const approachAdjustment = config.paOutcome.approachLogitAdjustments[approach];

  const disciplineZ = ratingToLatent(context.hitter.discipline);
  const visionZ = ratingToLatent(context.hitter.vision);
  const contactZ = ratingToLatent(context.hitter.contact);
  const controlZ = ratingToLatent(context.pitcher.control);
  const pitchabilityZ = ratingToLatent(context.pitcher.pitchability);
  const stuffZ = ratingToLatent(context.pitcher.stuff);

  const walkWeights = config.paOutcome.walkDefenseWeights;
  const strikeoutWeights = config.paOutcome.strikeoutDefenseWeights;

  const walkBattle =
    disciplineZ -
    (walkWeights.control * controlZ + walkWeights.pitchability * pitchabilityZ);

  const strikeoutBattle =
    stuffZ -
    (strikeoutWeights.vision * visionZ + strikeoutWeights.contact * contactZ);

  // log(target) makes a neutral 50-vs-50 BALANCED matchup reproduce the
  // reference environment exactly before sampling variance.
  const logits = {
    BB:
      Math.log(target.BB) +
      config.paOutcome.battleScales.walk * walkBattle +
      approachAdjustment.BB,
    HBP: Math.log(target.HBP) + approachAdjustment.HBP,
    K:
      Math.log(target.K) +
      config.paOutcome.battleScales.strikeout * strikeoutBattle +
      approachAdjustment.K,
    BIP: Math.log(target.BIP) + approachAdjustment.BIP
  };

  return softmax(logits);
}

function samplePAOutcome(probabilities, rng) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("samplePAOutcome에는 next()를 제공하는 RNG가 필요합니다.");
  }

  let total = 0;
  for (const outcome of PA_OUTCOMES) {
    const probability = probabilities[outcome];
    if (typeof probability !== "number" || probability < 0 || !Number.isFinite(probability)) {
      throw new TypeError(`유효하지 않은 ${outcome} 확률입니다.`);
    }
    total += probability;
  }

  if (Math.abs(total - 1) > 1e-10) {
    throw new RangeError(`PA outcome 확률 합이 1이 아닙니다: ${total}`);
  }

  let roll = rng.next();
  for (const outcome of PA_OUTCOMES) {
    const probability = probabilities[outcome];
    if (roll < probability) return outcome;
    roll -= probability;
  }

  // Floating-point residue only.
  return "BIP";
}

export { PA_OUTCOMES, PA_APPROACHES, getPAOutcomeProbabilities, samplePAOutcome };
