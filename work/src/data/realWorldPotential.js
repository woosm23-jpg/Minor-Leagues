import { hashSeed } from "../engine/rng.js";

const REAL_WORLD_POTENTIAL_MODEL_ID = "real_player_potential_v2_d4";
const POTENTIAL_PROFILE_VERSION = 1;
const POSITION_TOOLS = Object.freeze(["contact", "power", "vision", "discipline", "defense", "speed"]);
const PITCHER_TOOLS = Object.freeze(["control", "command", "movement", "pitchability", "stamina", "stuff", "velocityMph"]);
const LEVEL_TARGET_AGE = Object.freeze({ A: 20, HIGH_A: 21, AA: 22, AAA: 24, MLB: 26 });
const LEVEL_GROWTH_FACTOR = Object.freeze({ A: 1.15, HIGH_A: 1.08, AA: 1.00, AAA: 0.84, MLB: 0.55 });
const HIDDEN_TRAITS = Object.freeze(["LATE_BLOOMER", "EARLY_DEVELOPER", "HIGH_VARIANCE", "POLISHED"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function finite(value, fallback) { if (value == null || value === "") return fallback; const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function round(value, digits = 2) { const m = 10 ** digits; return Math.round(value * m) / m; }
function unit(seed, playerId, salt) { return (hashSeed(`potential-d1:${seed || "legacy"}:${playerId}:${salt}`) % 10001) / 10000; }
function signed(seed, playerId, salt) { return unit(seed, playerId, salt) * 2 - 1; }
function snapGrade(value) { return clamp(Math.round(value / 5) * 5, 20, 80); }

function gradeToInternal(grade) {
  const g = clamp(finite(grade, 50), 20, 80);
  const points = [[20,20],[30,25],[40,35],[50,50],[55,58],[60,65],[65,73],[70,80],[75,88],[80,95]];
  for (let i = 1; i < points.length; i += 1) {
    const [g1, r1] = points[i - 1], [g2, r2] = points[i];
    if (g <= g2) return r1 + ((g - g1) / Math.max(1e-9, g2 - g1)) * (r2 - r1);
  }
  return 95;
}

function ageGrowthFactor(age) {
  const a = finite(age, 24);
  if (a <= 18) return 1.06;
  if (a === 19) return 1.01;
  if (a === 20) return 0.96;
  if (a === 21) return 0.90;
  if (a === 22) return 0.82;
  if (a === 23) return 0.72;
  if (a === 24) return 0.62;
  if (a === 25) return 0.51;
  if (a === 26) return 0.40;
  if (a === 27) return 0.29;
  if (a === 28) return 0.19;
  if (a === 29) return 0.11;
  if (a === 30) return 0.065;
  if (a <= 32) return 0.035;
  return 0;
}

function ageToLevelFactor(age, level) {
  const target = LEVEL_TARGET_AGE[level] ?? 23;
  const delta = target - finite(age, target);
  if (delta >= 3) return 1.34;
  if (delta === 2) return 1.24;
  if (delta === 1) return 1.13;
  if (delta === 0) return 1.00;
  if (delta === -1) return 0.86;
  if (delta === -2) return 0.70;
  if (delta === -3) return 0.55;
  return 0.40;
}

function hiddenTrait(seed, playerId, age, level) {
  const u = unit(seed, playerId, "trait");
  const young = age <= 23 && level !== "MLB";
  if (young && u < 0.18) return "HIGH_VARIANCE";
  if (u < 0.37) return "LATE_BLOOMER";
  if (u < 0.57) return "EARLY_DEVELOPER";
  return "POLISHED";
}

function developmentRate(seed, playerId, age, level, trait) {
  const base = 0.91 + unit(seed, playerId, "development-rate") * 0.18;
  const ageAdj = age <= 23 ? 0.025 : age >= 30 ? -0.035 : age >= 27 ? -0.012 : 0;
  const levelAdj = level === "A" || level === "HIGH_A" ? 0.018 : level === "MLB" ? -0.008 : 0;
  const traitAdj = trait === "EARLY_DEVELOPER" ? 0.025 : trait === "LATE_BLOOMER" ? -0.012 : trait === "POLISHED" ? 0.012 : 0;
  return round(clamp(base + ageAdj + levelAdj + traitAdj, 0.78, 1.18), 4);
}

function workEthic(seed, playerId) {
  return round(clamp(0.91 + unit(seed, playerId, "work-ethic") * 0.18, 0.82, 1.18), 4);
}

function normalizedConfidence(value, fallback = null) {
  const raw = String(value ?? "").toUpperCase();
  return ["HIGH","GOOD","FAIR","LOW"].includes(raw) ? raw : fallback;
}

function normalizedRisk(value, fallback = null) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "MED" || raw === "MEDIUM") return "MEDIUM";
  if (["LOW","HIGH","EXTREME"].includes(raw)) return raw;
  return fallback;
}

function publicGradeEvidence(raw, fallbackConfidence = null) {
  if (raw == null) return null;
  const objectValue = raw && typeof raw === "object" ? raw : null;
  const grade = objectValue
    ? finite(objectValue.future ?? objectValue.grade ?? objectValue.value ?? objectValue.fv, null)
    : finite(raw, null);
  if (grade == null) return null;
  const low = objectValue ? finite(objectValue.low ?? objectValue.range?.low, null) : null;
  const high = objectValue ? finite(objectValue.high ?? objectValue.range?.high, null) : null;
  return freeze({
    grade: snapGrade(grade),
    confidence: normalizedConfidence(objectValue?.confidence, fallbackConfidence),
    range: low == null || high == null ? null : freeze({ low: snapGrade(Math.min(low, high)), high: snapGrade(Math.max(low, high)) })
  });
}

function publicFutureToolEvidence(publicScouting, aliases) {
  const source = publicScouting?.futureTools ?? publicScouting?.tools ?? publicScouting?.future ?? null;
  if (!source || typeof source !== "object") return null;
  const fallbackConfidence = normalizedConfidence(publicScouting?.confidence, null);
  for (const key of aliases) {
    const evidence = publicGradeEvidence(source[key], fallbackConfidence);
    if (evidence) return evidence;
  }
  return null;
}

function publicFutureTool(publicScouting, aliases) {
  return publicFutureToolEvidence(publicScouting, aliases)?.grade ?? null;
}

function publicFutureInternal(publicScouting, aliases) {
  const grade = publicFutureTool(publicScouting, aliases);
  return grade == null ? null : gradeToInternal(grade);
}

function publicFutureValueEvidence(publicScouting) {
  return publicGradeEvidence(publicScouting?.futureValue ?? publicScouting?.fv ?? null, normalizedConfidence(publicScouting?.confidence, null));
}

function confidenceBand(publicScouting, inference) {
  const raw = normalizedConfidence(publicScouting?.confidence, null);
  if (raw) return raw;
  const fvEvidence = publicFutureValueEvidence(publicScouting);
  if (fvEvidence?.confidence) return fvEvidence.confidence;
  if (fvEvidence) return "GOOD";
  const inf = normalizedConfidence(inference?.confidence, null);
  if (inf === "HIGH" || inf === "GOOD") return "FAIR";
  return "LOW";
}

function publicEvidenceNoiseScale(publicScouting, inference) {
  return ({ HIGH: 0.40, GOOD: 0.58, FAIR: 0.78, LOW: 1.00 })[confidenceBand(publicScouting, inference)] ?? 1;
}

function currentPositionTools(player) {
  const h = player?.hitting ?? {}, f = player?.fielding ?? {}, r = player?.running ?? {}, t = player?.tendencies ?? {};
  return {
    contact: Math.max(finite(h.contactR, 50), finite(h.contactL, 50)),
    power: Math.max(finite(h.rawPower, 50), finite(t.powerUtilizationR, 50), finite(t.powerUtilizationL, 50)),
    vision: finite(h.vision, 50), discipline: finite(h.discipline, 50),
    defense: Math.max(finite(f.fielding, 50), finite(f.reaction, 50)), speed: finite(r.speed, 50)
  };
}

function currentPitcherTools(player) {
  const p = player?.pitching ?? {};
  return {
    control: finite(p.control, 50), command: finite(p.command, 50), movement: finite(p.movement, 50),
    pitchability: finite(p.pitchability, 50), stamina: finite(p.stamina, 50), stuff: finite(player?.derived?.stuff, 50),
    velocityMph: finite(p.pitchVelocityMph, 92)
  };
}

function veteranRoom(age, tool, pitcher = false) {
  if (age < 29) return null;
  if (pitcher) {
    const byTool = age >= 34
      ? { command: 0.8, pitchability: 1.0, control: 0.3, movement: 0, stuff: 0, stamina: 0, velocityMph: 0 }
      : age >= 31
        ? { command: 1.2, pitchability: 1.5, control: 0.5, movement: 0.2, stuff: 0, stamina: 0, velocityMph: 0 }
        : { command: 1.8, pitchability: 1.9, control: 0.8, movement: 0.5, stuff: 0.4, stamina: 0.2, velocityMph: 0.15 };
    return byTool[tool] ?? 0;
  }
  const byTool = age >= 34
    ? { contact: 0.2, power: 0, vision: 0.8, discipline: 0.9, defense: 0, speed: 0 }
    : age >= 31
      ? { contact: 0.4, power: 0.2, vision: 1.2, discipline: 1.3, defense: 0.1, speed: 0 }
      : { contact: 0.9, power: 0.6, vision: 1.8, discipline: 1.8, defense: 0.5, speed: 0.1 };
  return byTool[tool] ?? 0;
}

function toolRoom({ seed, playerId, tool, current, age, level, baseRoom, publicInternal = null, publicFVInternal = null, overall = 50, pitcher = false, confidenceScale = 1 }) {
  const vet = veteranRoom(age, tool, pitcher);
  if (vet != null) {
    if (vet <= 0) return 0;
    const noise = signed(seed, playerId, `veteran:${tool}`) * 0.35 * confidenceScale;
    return Math.max(0, vet + noise);
  }
  const growth = ageGrowthFactor(age) * (LEVEL_GROWTH_FACTOR[level] ?? 0.9) * ageToLevelFactor(age, level);
  const headroom = clamp((99 - finite(current, 50)) / 49, 0.08, 1.25);
  let room = baseRoom * growth * (0.72 + headroom * 0.28);
  if (publicFVInternal != null) {
    const fvGap = clamp(publicFVInternal - finite(overall, 50), -8, 22);
    room += Math.max(-2, fvGap * 0.16);
  }
  if (publicInternal != null) {
    const toolGap = clamp(publicInternal - finite(current, 50), -10, 28);
    room = room * 0.48 + Math.max(0, toolGap) * 0.52;
  }
  const noiseScale = (publicInternal != null ? 1.1 : 2.0) * confidenceScale;
  room += signed(seed, playerId, `ceiling:${tool}`) * noiseScale;
  return Math.max(0, room);
}

function reachableRoom(room, { age, level, rate, trait, publicInternal = null }) {
  let share = age <= 20 ? 0.84 : age <= 23 ? 0.78 : age <= 26 ? 0.68 : age <= 29 ? 0.52 : age <= 32 ? 0.34 : 0.18;
  if (level === "MLB") share -= age <= 25 ? 0.05 : 0.09;
  if (trait === "POLISHED") share += 0.04;
  if (trait === "HIGH_VARIANCE") share -= 0.03;
  if (publicInternal != null) share += 0.04;
  share *= clamp(0.90 + (rate - 0.9) * 0.7, 0.84, 1.10);
  return Math.max(0, room * clamp(share, 0.12, 0.90));
}

const POSITION_BASE_ROOM = Object.freeze({ contact: 10, power: 12, vision: 10, discipline: 9, defense: 8, speed: 5 });
const PITCHER_BASE_ROOM = Object.freeze({ control: 10, command: 12, movement: 9, pitchability: 10, stamina: 8, stuff: 11, velocityMph: 2.0 });
const POSITION_ALIASES = Object.freeze({
  contact: ["contact","hit","hitTool"], power: ["power","gamePower","rawPower"], vision: ["vision","batToBall"],
  discipline: ["discipline","plateDiscipline"], defense: ["defense","fielding"], speed: ["speed","run"]
});
const PITCHER_ALIASES = Object.freeze({
  control: ["control"], command: ["command"], movement: ["movement","break"], pitchability: ["pitchability"],
  stamina: ["stamina"], stuff: ["stuff"], velocityMph: ["velocityMph","futureVelocityMph"]
});

const PITCH_FAMILY_ALIASES = Object.freeze({
  fastball: ["fastball","fb"], slider: ["slider","sl"], curveball: ["curveball","curve","cb"],
  changeup: ["changeup","change","ch"], splitter: ["splitter","split","fs"], cutter: ["cutter","fc"]
});
const PITCH_TYPE_FAMILY = Object.freeze({
  FF:"fastball", FA:"fastball", FT:"fastball", SI:"fastball",
  FC:"cutter", SL:"slider", ST:"slider", SV:"slider",
  CU:"curveball", KC:"curveball", CS:"curveball",
  CH:"changeup", SC:"changeup", FS:"splitter", FO:"splitter"
});

function publicPitchEvidence(publicScouting, family) {
  const aliases = PITCH_FAMILY_ALIASES[family] ?? [family];
  return publicFutureToolEvidence(publicScouting, aliases);
}

function pitchVelocityRoom(age, family, seed, playerId, type) {
  const a = finite(age, 24);
  let base = a <= 18 ? 2.4 : a === 19 ? 2.0 : a === 20 ? 1.6 : a === 21 ? 1.25 : a === 22 ? 0.9 : a === 23 ? 0.6 : a === 24 ? 0.35 : a <= 27 ? 0.15 : 0;
  if (family !== "fastball" && family !== "cutter") base *= 0.42;
  if (a >= 29) base = 0;
  return Math.max(0, base + signed(seed, playerId, `pitch-velo:${type}`) * Math.min(0.25, base * 0.18));
}

function inferPitchPotential({ inference, publicScouting, seed, playerId, age, level, rate, trait, confidenceScale }) {
  const arsenal = Array.isArray(inference?.pitchArsenal) ? inference.pitchArsenal : [];
  if (!arsenal.length) return freeze([]);
  return freeze(arsenal.map((pitch) => {
    const type = String(pitch?.type ?? "").toUpperCase();
    const family = PITCH_TYPE_FAMILY[type] ?? "other";
    const evidence = family === "other" ? null : publicPitchEvidence(publicScouting, family);
    const publicInternal = evidence ? gradeToInternal(evidence.grade) : null;
    const qualityZ = clamp(finite(pitch?.qualityZ, 0), -3, 3);
    const currentGrade = clamp(50 + qualityZ * 8.5, 20, 80);
    const currentInternal = gradeToInternal(currentGrade);
    const room = toolRoom({
      seed, playerId, tool:`pitch:${type || family}`, current:currentInternal, age, level,
      baseRoom:10, publicInternal, publicFVInternal:null, overall:currentInternal, pitcher:true, confidenceScale
    });
    const reachable = reachableRoom(room, { age, level, rate, trait, publicInternal });
    const currentVelocity = finite(pitch?.velocity, null);
    const veloRoom = currentVelocity == null ? 0 : pitchVelocityRoom(age, family, seed, playerId, type || family);
    return freeze({
      type, family, usage: round(finite(pitch?.usage, 0), 4),
      currentInternal: round(currentInternal, 2),
      ceiling: round(clamp(currentInternal + room, 20, 99), 2),
      reachableProjection: round(clamp(currentInternal + reachable, 20, 99), 2),
      velocityMph: currentVelocity,
      velocityCeilingMph: currentVelocity == null ? null : round(currentVelocity + veloRoom, 2),
      velocityReachableMph: currentVelocity == null ? null : round(currentVelocity + veloRoom * (age <= 23 ? 0.78 : 0.55), 2),
      publicFutureGrade: evidence?.grade ?? null,
      publicConfidence: evidence?.confidence ?? null
    });
  }));
}

function inferRealPlayerPotentialProfile({ player, sourcePlayer = null, inference = null, seed = "" } = {}) {
  if (!player?.id) throw new TypeError("potential profile에는 player.id가 필요합니다.");
  const level = String(sourcePlayer?.assignedLevel ?? sourcePlayer?.level ?? player?.realWorld?.sourceLevel ?? inference?.level ?? "AA");
  const age = clamp(Math.round(finite(sourcePlayer?.age, player?.physical?.age ?? 24)), 16, 50);
  const inferenceType = String(inference?.type ?? "").toUpperCase();
  const pitcher = inferenceType
    ? inferenceType === "PITCHER"
    : Boolean(player?.pitching) && !player?.positioning;
  const role = inference?.role ?? player?.pitching?.role ?? null;
  const current = pitcher ? currentPitcherTools(player) : currentPositionTools(player);
  const tools = pitcher ? PITCHER_TOOLS : POSITION_TOOLS;
  const baseRoom = pitcher ? PITCHER_BASE_ROOM : POSITION_BASE_ROOM;
  const aliases = pitcher ? PITCHER_ALIASES : POSITION_ALIASES;
  const publicScouting = sourcePlayer?.publicScouting ?? null;
  const publicFVEvidence = publicFutureValueEvidence(publicScouting);
  const publicFV = publicFVEvidence?.grade ?? null;
  const publicFVInternal = publicFV == null ? null : gradeToInternal(publicFV);
  const trait = hiddenTrait(seed, String(player.id), age, level);
  const rate = developmentRate(seed, String(player.id), age, level, trait);
  const ethic = workEthic(seed, String(player.id));
  const confidenceScale = publicEvidenceNoiseScale(publicScouting, inference);
  const ceilings = {}, reachableProjection = {}, publicToolEvidence = {};

  for (const tool of tools) {
    const evidence = publicFutureToolEvidence(publicScouting, aliases[tool] ?? [tool]);
    if (evidence) publicToolEvidence[tool] = evidence;
    const publicInternal = evidence == null ? null : gradeToInternal(evidence.grade);
    const room = toolRoom({ seed, playerId: String(player.id), tool, current: current[tool], age, level, baseRoom: baseRoom[tool], publicInternal, publicFVInternal, overall: finite(inference?.overall, 50), pitcher, confidenceScale });
    const reachable = reachableRoom(room, { age, level, rate, trait, publicInternal });
    if (tool === "velocityMph") {
      ceilings[tool] = round(Math.max(current[tool], current[tool] + room), 2);
      reachableProjection[tool] = round(Math.min(ceilings[tool], Math.max(current[tool], current[tool] + reachable)), 2);
    } else {
      ceilings[tool] = round(clamp(Math.max(current[tool], current[tool] + room), 20, 99), 2);
      reachableProjection[tool] = round(clamp(Math.min(ceilings[tool], Math.max(current[tool], current[tool] + reachable)), 20, 99), 2);
    }
  }

  const pitchPotential = pitcher ? inferPitchPotential({
    inference, publicScouting, seed, playerId:String(player.id), age, level, rate, trait, confidenceScale
  }) : freeze([]);

  // A public FV is evidence, not a hidden destiny. It gently centers the
  // reachable tool distribution but never copies the grade straight into a
  // hidden ceiling or guarantees that outcome.
  const publicConfidence = confidenceBand(publicScouting, inference);
  return freeze({
    version: POTENTIAL_PROFILE_VERSION,
    model: REAL_WORLD_POTENTIAL_MODEL_ID,
    kind: pitcher ? "PITCHER" : "POSITION",
    role,
    hiddenDevelopmentTrait: trait,
    developmentRate: rate,
    workEthic: ethic,
    ceilings,
    reachableProjection,
    potentialConfidence: publicConfidence,
    publicFutureValue: publicFV == null ? null : snapGrade(publicFV),
    publicScoutingEvidence: freeze({
      confidence: publicConfidence,
      futureValue: publicFVEvidence,
      tools: freeze(publicToolEvidence),
      risk: normalizedRisk(publicScouting?.risk, null),
      source: publicScouting?.source ?? null
    }),
    ...(pitcher ? { pitchPotential } : {}),
    priorContext: freeze({ age, level, ageToLevel: round(ageToLevelFactor(age, level), 3) })
  });
}

export { REAL_WORLD_POTENTIAL_MODEL_ID, POTENTIAL_PROFILE_VERSION, inferRealPlayerPotentialProfile, gradeToInternal };
