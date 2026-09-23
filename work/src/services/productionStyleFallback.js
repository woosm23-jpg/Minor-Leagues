function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, freeze(item)])
      )
    );
  }
  return value;
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

function randomInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function rngFor(seed, playerId, namespace) {
  return mulberry32(
    fnv1a32(
      `PRODUCTION_STYLE_FALLBACK_V1:${namespace}:${seed}:${playerId}`
    )
  );
}

function createGeneratedHitterStyle({
  seed = "",
  playerId
} = {}) {
  const id = String(playerId ?? "");
  if (!id) {
    throw new TypeError(
      "generated hitter style에는 playerId가 필요합니다."
    );
  }
  const rng = rngFor(seed, id, "HITTER");
  return freeze({
    source: "GENERATED_RANDOM_FALLBACK",
    version: 1,
    launchTendency: randomInt(rng, 30, 70),
    sprayPull: randomInt(rng, 28, 72),
    sprayCenter: randomInt(rng, 32, 68),
    sprayOppo: randomInt(rng, 28, 72)
  });
}

function createGeneratedPitcherStyle({
  seed = "",
  playerId
} = {}) {
  const id = String(playerId ?? "");
  if (!id) {
    throw new TypeError(
      "generated pitcher style에는 playerId가 필요합니다."
    );
  }
  const rng = rngFor(seed, id, "PITCHER");
  return freeze({
    source: "GENERATED_RANDOM_FALLBACK",
    version: 1,
    holdRunner: randomInt(rng, 30, 70),
    fielding: randomInt(rng, 32, 68),
    reaction: randomInt(rng, 32, 68),
    armStrength: randomInt(rng, 42, 78),
    armAccuracy: randomInt(rng, 32, 68)
  });
}

export {
  createGeneratedHitterStyle,
  createGeneratedPitcherStyle
};
