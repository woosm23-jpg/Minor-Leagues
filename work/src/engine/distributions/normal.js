/**
 * Deterministic standard-normal sample using Box-Muller.
 * Two RNG values are consumed per sample; no hidden cache is used so RNG state
 * remains easy to reason about and checkpoint.
 */
function sampleStandardNormal(rng) {
  if (!rng || typeof rng.next !== "function") {
    throw new TypeError("sampleStandardNormal에는 next()를 제공하는 RNG가 필요합니다.");
  }

  // rng.next() is [0, 1). Avoid log(0) without changing the deterministic
  // consumption count.
  const u1 = Math.max(Number.MIN_VALUE, rng.next());
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export { sampleStandardNormal };
