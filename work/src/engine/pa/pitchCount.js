import { pitchingCalibration } from "../../config/pitchingCalibration.js";

const PA_TYPES = Object.freeze(["BIP", "K", "BB", "HBP"]);

function validateDistribution(distribution, label) {
  if (!distribution || typeof distribution !== "object") {
    throw new TypeError(`${label} 분포가 필요합니다.`);
  }
  const { values, probabilities } = distribution;
  if (!Array.isArray(values) || !Array.isArray(probabilities) || values.length !== probabilities.length || values.length === 0) {
    throw new RangeError(`${label} values/probabilities 길이가 올바르지 않습니다.`);
  }
  let total = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isInteger(values[i]) || values[i] < 1) throw new RangeError(`${label} pitch count는 양의 정수여야 합니다.`);
    const p = probabilities[i];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) throw new RangeError(`${label} 확률이 유효하지 않습니다.`);
    total += p;
  }
  if (Math.abs(total - 1) > 1e-10) throw new RangeError(`${label} 확률 합이 1이 아닙니다: ${total}`);
}

function expectedPitchesForPAOutcome(paType, config = pitchingCalibration) {
  if (!PA_TYPES.includes(paType)) throw new RangeError(`지원하지 않는 PA type입니다: ${paType}`);
  const distribution = config.pitchCountByPAOutcome[paType];
  validateDistribution(distribution, paType);
  return distribution.values.reduce((sum, value, index) => sum + value * distribution.probabilities[index], 0);
}

function samplePitchCount(paType, rng, config = pitchingCalibration) {
  if (!PA_TYPES.includes(paType)) throw new RangeError(`지원하지 않는 PA type입니다: ${paType}`);
  if (!rng || typeof rng.next !== "function") throw new TypeError("pitch count sampling RNG가 필요합니다.");
  const distribution = config.pitchCountByPAOutcome[paType];
  validateDistribution(distribution, paType);
  let roll = rng.next();
  for (let i = 0; i < distribution.values.length; i += 1) {
    if (roll < distribution.probabilities[i]) return distribution.values[i];
    roll -= distribution.probabilities[i];
  }
  return distribution.values.at(-1);
}

export { expectedPitchesForPAOutcome, samplePitchCount };
