const GENERATED_SOURCE_ID = "generated_random_fallback";

const GENERATED_PITCH_POOL = Object.freeze([
  Object.freeze({ pitchType: "FF", minVelocity: 90, maxVelocity: 100 }),
  Object.freeze({ pitchType: "SI", minVelocity: 89, maxVelocity: 99 }),
  Object.freeze({ pitchType: "FC", minVelocity: 85, maxVelocity: 96 }),
  Object.freeze({ pitchType: "SL", minVelocity: 78, maxVelocity: 92 }),
  Object.freeze({ pitchType: "ST", minVelocity: 78, maxVelocity: 91 }),
  Object.freeze({ pitchType: "CU", minVelocity: 70, maxVelocity: 86 }),
  Object.freeze({ pitchType: "KC", minVelocity: 72, maxVelocity: 88 }),
  Object.freeze({ pitchType: "CH", minVelocity: 76, maxVelocity: 92 }),
  Object.freeze({ pitchType: "FS", minVelocity: 80, maxVelocity: 94 }),
  Object.freeze({ pitchType: "SV", minVelocity: 78, maxVelocity: 91 })
]);

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

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function fnv1aUnit(text) {
  return fnv1a32(text) / 0x100000000;
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

function normalizeUsage(row, totalPitches) {
  const explicit = finite(row?.usage);
  if (explicit != null && explicit >= 0) {
    return explicit > 1.000001 ? explicit / 100 : explicit;
  }
  const pitches = finite(row?.samples?.pitches);
  return pitches != null && pitches > 0 && totalPitches > 0
    ? pitches / totalPitches
    : 0;
}

function normalizePitchArsenalRows(rows, {
  playerId,
  level,
  season = 2026
} = {}) {
  const id = String(playerId ?? "");
  const targetLevel = String(level ?? "");

  const matching = (rows ?? []).filter(
    (row) =>
      String(row?.playerId) === id &&
      String(row?.level) === targetLevel &&
      Number(row?.season) <= Number(season)
  );

  if (!matching.length) return Object.freeze([]);

  const latestSeason = Math.max(
    ...matching.map((row) => Number(row.season))
  );
  const latest = matching
    .filter((row) => Number(row.season) === latestSeason)
    .sort(
      (a, b) =>
        String(a.pitchType).localeCompare(String(b.pitchType))
    );

  const totalPitches = latest.reduce(
    (sum, row) =>
      sum + Math.max(0, finite(row?.samples?.pitches) ?? 0),
    0
  );

  const staged = latest.map((row) => {
    const mean = finite(row?.velocity?.mean);
    const sd = finite(row?.velocity?.sd);
    return {
      pitchType: String(row.pitchType ?? "UNK").toUpperCase(),
      season: latestSeason,
      level: targetLevel,
      usage: Math.max(0, normalizeUsage(row, totalPitches)),
      velocityMph:
        mean == null ? null : clamp(mean, 55, 110),
      velocitySdMph:
        sd == null ? null : clamp(sd, 0, 12),
      movement: row?.movement ?? null,
      whiff: row?.whiff ?? null,
      location: row?.location ?? null,
      samples: row?.samples ?? null,
      sourceId: row?.sourceId ?? null,
      generated: false
    };
  });

  const positiveUsage = staged.reduce(
    (sum, row) => sum + row.usage,
    0
  );

  const normalized = staged.map((row) => ({
    ...row,
    usage:
      positiveUsage > 0
        ? row.usage / positiveUsage
        : 1 / Math.max(1, staged.length)
  }));

  return freeze(normalized);
}

function buildProductionPitchArsenalIndex(rows, {
  season = 2026
} = {}) {
  const keys = new Map();

  for (const row of rows ?? []) {
    const key =
      `${String(row?.level ?? "")}:${String(row?.playerId ?? "")}`;
    if (!keys.has(key)) {
      keys.set(key, {
        playerId: String(row?.playerId ?? ""),
        level: String(row?.level ?? "")
      });
    }
  }

  const index = new Map();
  for (const [key, meta] of keys.entries()) {
    const arsenal = normalizePitchArsenalRows(rows, {
      ...meta,
      season
    });
    if (arsenal.length) index.set(key, arsenal);
  }
  return index;
}

function createGeneratedRandomArsenal({
  playerId,
  seed = "",
  level = "UNKNOWN",
  season = 2026
} = {}) {
  const id = String(playerId ?? "");
  if (!id) throw new TypeError("generated arsenal에는 playerId가 필요합니다.");

  const rng = mulberry32(
    fnv1a32(`GENERATED_RANDOM_ARSENAL_V1:${seed}:${id}`)
  );
  const pool = [...GENERATED_PITCH_POOL];

  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const pitchCount = 3 + Math.floor(rng() * 3);
  const selected = pool.slice(0, pitchCount);
  const rawWeights = selected.map(() => 0.15 + rng());
  const weightTotal = rawWeights.reduce((sum, value) => sum + value, 0);

  return freeze(
    selected.map((pitch, index) => {
      const velocity =
        pitch.minVelocity +
        rng() * (pitch.maxVelocity - pitch.minVelocity);
      return {
        pitchType: pitch.pitchType,
        season: Number(season),
        level: String(level),
        usage: rawWeights[index] / weightTotal,
        velocityMph: Number(velocity.toFixed(2)),
        velocitySdMph: Number((0.6 + rng() * 2.2).toFixed(2)),
        movement: null,
        whiff: null,
        location: null,
        samples: null,
        sourceId: GENERATED_SOURCE_ID,
        generated: true
      };
    })
  );
}

function normalizeInferredPitchArsenal(
  inference,
  { level = "UNKNOWN", season = 2026 } = {}
) {
  const source = Array.isArray(inference?.pitchArsenal)
    ? inference.pitchArsenal
    : [];

  const staged = source
    .map((row) => {
      const velocity = finite(row?.velocity);
      if (velocity == null || velocity < 55 || velocity > 110) {
        return null;
      }
      return {
        pitchType: String(row?.type ?? "UNK").toUpperCase(),
        season: Number(
          row?.seasonsUsed?.[0] ?? season
        ),
        level: String(
          row?.levelsUsed?.[0] ?? level
        ),
        usage: Math.max(0, finite(row?.usage) ?? 0),
        velocityMph: clamp(velocity, 55, 110),
        velocitySdMph: null,
        movement: {
          horizontal:
            finite(row?.horizontalMovement),
          vertical:
            finite(row?.verticalMovement)
        },
        whiff: finite(row?.whiffQuality),
        location: null,
        samples: row?.samples ?? null,
        sourceId: "real_world_inference_pitch_arsenal",
        generated: false
      };
    })
    .filter(Boolean);

  if (!staged.length) return Object.freeze([]);

  const total = staged.reduce(
    (sum, row) => sum + row.usage,
    0
  );

  return freeze(
    staged.map((row) => ({
      ...row,
      usage:
        total > 0
          ? row.usage / total
          : 1 / staged.length
    }))
  );
}

function selectPitchFromArsenal({
  arsenal,
  seed = "",
  state,
  pitcherId,
  batterId
} = {}) {
  const eligible = (arsenal ?? []).filter(
    (row) =>
      Number.isFinite(Number(row?.velocityMph)) &&
      Number(row.velocityMph) >= 55 &&
      Number(row.velocityMph) <= 110
  );
  if (!eligible.length) return null;

  const total = eligible.reduce(
    (sum, row) => sum + Math.max(0, Number(row.usage ?? 0)),
    0
  );
  const key = [
    seed,
    state?.gameId ?? "",
    state?.plateAppearances ?? 0,
    pitcherId ?? "",
    batterId ?? ""
  ].join(":");
  let roll = fnv1aUnit(key);

  for (let index = 0; index < eligible.length; index += 1) {
    const row = eligible[index];
    const probability =
      total > 0
        ? Math.max(0, Number(row.usage ?? 0)) / total
        : 1 / eligible.length;

    if (roll < probability || index === eligible.length - 1) {
      return freeze({
        pitchType: row.pitchType,
        velocityMph: Number(row.velocityMph),
        usage: probability,
        season: row.season,
        level: row.level,
        sourceId: row.sourceId,
        generated: row.generated === true
      });
    }
    roll -= probability;
  }

  return null;
}


const PITCH_VELOCITY_REFERENCE = Object.freeze({
  FF: 94.0,
  SI: 93.0,
  FC: 89.5,
  SL: 85.0,
  ST: 84.0,
  CU: 79.0,
  KC: 81.0,
  CH: 85.0,
  FS: 86.0,
  SV: 83.0
});

const PITCH_WHIFF_REFERENCE = Object.freeze({
  FF: 0.22,
  SI: 0.16,
  FC: 0.22,
  SL: 0.30,
  ST: 0.31,
  CU: 0.28,
  KC: 0.29,
  CH: 0.30,
  FS: 0.34,
  SV: 0.30
});

function fallbackPitchQualityZ(pitch) {
  const type = String(pitch?.pitchType ?? "FF").toUpperCase();
  const velocity = finite(pitch?.velocityMph);
  const whiff = finite(pitch?.whiff);
  let score = 0;
  let weight = 0;

  if (velocity != null) {
    const reference = PITCH_VELOCITY_REFERENCE[type] ?? 88;
    score += clamp((velocity - reference) / 3.5, -2, 2) * 0.65;
    weight += 0.65;
  }

  if (whiff != null) {
    const reference = PITCH_WHIFF_REFERENCE[type] ?? 0.26;
    score += clamp((whiff - reference) / 0.07, -2, 2) * 0.35;
    weight += 0.35;
  }

  return weight > 0 ? score / weight : 0;
}

function pitchQualityZ(pitch) {
  const real = finite(pitch?.qualityZ);
  return real == null
    ? fallbackPitchQualityZ(pitch)
    : clamp(real, -2.5, 2.5);
}

function arsenalAverageQualityZ(arsenal) {
  const rows = (arsenal ?? []).filter(
    (row) => Number(row?.usage) > 0
  );
  if (!rows.length) return 0;

  const total = rows.reduce(
    (sum, row) => sum + Number(row.usage),
    0
  );
  if (!(total > 0)) return 0;

  return rows.reduce(
    (sum, row) =>
      sum +
      pitchQualityZ(row) *
        (Number(row.usage) / total),
    0
  );
}

function resolveDynamicPitchStuff({
  baseStuff,
  selectedPitch,
  arsenal
} = {}) {
  const base = finite(baseStuff);
  if (base == null) {
    throw new TypeError("Dynamic Stuff에는 baseStuff가 필요합니다.");
  }
  if (!selectedPitch) return clamp(Math.round(base), 20, 99);

  const selectedQuality = pitchQualityZ(selectedPitch);
  const averageQuality = arsenalAverageQualityZ(arsenal);
  const delta = selectedQuality - averageQuality;

  const rawSamples = finite(selectedPitch?.samples);
  const sampleReliability =
    rawSamples == null
      ? selectedPitch?.generated === true
        ? 0.55
        : 0.72
      : clamp(rawSamples / (rawSamples + 120), 0.35, 0.98);

  const generatedScale =
    selectedPitch?.generated === true ? 0.72 : 1;
  const adjustment = clamp(
    delta * 5.5 * sampleReliability * generatedScale,
    -7,
    7
  );

  return clamp(
    Number((base + adjustment).toFixed(2)),
    20,
    99
  );
}


function createProductionPitchSelectionResolver({
  seed = ""
} = {}) {
  return ({
    state,
    pitcherId,
    batterId,
    pitcher,
    pitcherProfile
  }) => {
    const arsenal = pitcher?.pitchArsenal ?? [];
    const selected = selectPitchFromArsenal({
      arsenal,
      seed,
      state,
      pitcherId,
      batterId
    });
    if (!selected) return null;

    return freeze({
      ...selected,
      resolvedStuff: resolveDynamicPitchStuff({
        baseStuff:
          pitcherProfile?.stuff ??
          pitcher?.derived?.stuff ??
          50,
        selectedPitch: selected,
        arsenal
      })
    });
  };
}

export {
  GENERATED_SOURCE_ID,
  normalizePitchArsenalRows,
  normalizeInferredPitchArsenal,
  buildProductionPitchArsenalIndex,
  createGeneratedRandomArsenal,
  pitchQualityZ,
  arsenalAverageQualityZ,
  resolveDynamicPitchStuff,
  selectPitchFromArsenal,
  createProductionPitchSelectionResolver
};
