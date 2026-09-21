/**
 * THE CALL-UP deterministic RNG.
 *
 * Algorithm is intentionally versioned because save files persist RNG state.
 * Once careers exist in the wild, changing the algorithm requires a migration
 * strategy rather than silently changing the generated sequence.
 */
const RNG_ALGORITHM = "mulberry32-v1";
const RNG_SNAPSHOT_VERSION = 1;

const UINT32_MAX = 0xffffffff;
const UINT32_RANGE = 0x100000000;
const FALLBACK_STATE = 0x6d2b79f5;

/**
 * FNV-1a style 32-bit hash used to normalize arbitrary seed values.
 * @param {unknown} input
 * @returns {number} unsigned 32-bit seed hash
 */
function hashSeed(input) {
  const text = String(input);
  let hash = 2166136261 >>> 0;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function assertSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new TypeError("유효한 RNG snapshot이 아닙니다.");
  }

  if (snapshot.version !== RNG_SNAPSHOT_VERSION) {
    throw new RangeError(`지원하지 않는 RNG snapshot 버전입니다: ${snapshot.version}`);
  }

  if (snapshot.algorithm !== RNG_ALGORITHM) {
    throw new RangeError(`지원하지 않는 RNG 알고리즘입니다: ${snapshot.algorithm}`);
  }

  if (
    !Number.isInteger(snapshot.state) ||
    snapshot.state < 0 ||
    snapshot.state > UINT32_MAX
  ) {
    throw new TypeError("RNG snapshot.state는 uint32 정수여야 합니다.");
  }

  if (!Number.isSafeInteger(snapshot.counter) || snapshot.counter < 0) {
    throw new TypeError("RNG snapshot.counter는 0 이상의 안전한 정수여야 합니다.");
  }
}

class SeededRng {
  constructor(seed = "THE_CALL_UP") {
    this.state = hashSeed(seed) || FALLBACK_STATE;
    this.counter = 0;
  }

  /**
   * @returns {number} [0, 1) deterministic random value
   */
  next() {
    this.state = (this.state + FALLBACK_STATE) >>> 0;

    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    const value = ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    this.counter += 1;
    return value;
  }

  /**
   * Inclusive integer range.
   */
  int(min, maxInclusive) {
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(maxInclusive) ||
      maxInclusive < min
    ) {
      throw new RangeError("유효한 정수 범위를 입력하세요.");
    }

    const span = maxInclusive - min + 1;
    if (!Number.isSafeInteger(span) || span <= 0) {
      throw new RangeError("정수 범위가 너무 큽니다.");
    }

    return min + Math.floor(this.next() * span);
  }

  /**
   * Save-file-safe, JSON-serializable RNG state.
   */
  snapshot() {
    return {
      version: RNG_SNAPSHOT_VERSION,
      algorithm: RNG_ALGORITHM,
      state: this.state >>> 0,
      counter: this.counter
    };
  }

  restore(snapshot) {
    assertSnapshot(snapshot);
    this.state = snapshot.state >>> 0;
    this.counter = snapshot.counter;
    return this;
  }

  static fromSnapshot(snapshot) {
    return new SeededRng().restore(snapshot);
  }
}

export { RNG_ALGORITHM, RNG_SNAPSHOT_VERSION, hashSeed, SeededRng };
