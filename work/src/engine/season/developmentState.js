import { hashSeed } from "../rng.js";

const DEVELOPMENT_STATE_VERSION = 2;
const POSITION_DEVELOPMENT_TOOLS = Object.freeze(["contact", "power", "vision", "discipline", "defense", "speed"]);
const PITCHER_DEVELOPMENT_TOOLS = Object.freeze(["control", "command", "movement", "pitchability", "stamina", "stuff", "velocityMph"]);
const DEVELOPMENT_TRAJECTORIES = Object.freeze(["NORMAL", "BREAKOUT", "BUST", "STAGNATION"]);

const HIDDEN_TRAITS = Object.freeze(["LATE_BLOOMER", "EARLY_DEVELOPER", "HIGH_VARIANCE", "POLISHED"]);

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, freeze(child)])));
  return value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampRating(value) { return clamp(Math.round(Number(value) || 50), 20, 99); }
function finite(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function unitFromKey(randomKey, playerId, salt) { return (hashSeed(`development-v${DEVELOPMENT_STATE_VERSION}:${randomKey}:${playerId}:${salt}`) % 10000) / 9999; }
function randomKeyFor(playerId, seed = "") { return hashSeed(`development-hidden-v${DEVELOPMENT_STATE_VERSION}:${seed || "legacy"}:${playerId}`); }

function emptyTools(keys, value = 0) { return Object.fromEntries(keys.map((key) => [key, value])); }
function normalizeTools(raw, keys, fallback = 0) {
  return Object.fromEntries(keys.map((key) => [key, finite(raw?.[key], fallback)]));
}
function normalizedProcessed(raw) {
  return [...new Set(Array.isArray(raw) ? raw.filter((value) => typeof value === "string" && value) : [])].sort();
}

function deterministicTrait(randomKey, playerId) {
  return HIDDEN_TRAITS[Math.floor(unitFromKey(randomKey, playerId, "hidden-trait") * HIDDEN_TRAITS.length) % HIDDEN_TRAITS.length];
}

function baseRate(randomKey, playerId, trait) {
  const base = 0.86 + unitFromKey(randomKey, playerId, "rate") * 0.28;
  const modifier = trait === "EARLY_DEVELOPER" ? 0.04 : trait === "LATE_BLOOMER" ? -0.02 : trait === "POLISHED" ? 0.02 : 0;
  return Number(clamp(base + modifier, 0.72, 1.28).toFixed(4));
}

function baseWorkEthic(randomKey, playerId) {
  return Number((0.86 + unitFromKey(randomKey, playerId, "work-ethic") * 0.28).toFixed(4));
}

function positionBaseRatings(player) {
  const hitting = player?.hitting ?? {};
  const fielding = player?.fielding ?? {};
  const running = player?.running ?? {};
  const tendencies = player?.tendencies ?? {};
  return {
    contact: Math.max(finite(hitting.contactR, 50), finite(hitting.contactL, 50)),
    power: Math.max(finite(hitting.rawPower, 50), finite(tendencies.powerUtilizationR, 50), finite(tendencies.powerUtilizationL, 50)),
    vision: finite(hitting.vision, 50),
    discipline: finite(hitting.discipline, 50),
    defense: Math.max(finite(fielding.fielding, 50), finite(fielding.reaction, 50)),
    speed: finite(running.speed, 50)
  };
}

function pitcherBaseRatings(player) {
  const pitching = player?.pitching ?? {};
  return {
    control: finite(pitching.control, 50),
    command: finite(pitching.command, 50),
    movement: finite(pitching.movement, 50),
    pitchability: finite(pitching.pitchability, 50),
    stamina: finite(pitching.stamina, 50),
    stuff: finite(player?.derived?.stuff, 50),
    velocityMph: finite(pitching.pitchVelocityMph, 92)
  };
}

function defaultPositionCeilings(player, randomKey) {
  const current = positionBaseRatings(player);
  return Object.fromEntries(POSITION_DEVELOPMENT_TOOLS.map((tool) => {
    const minRoom = tool === "speed" ? 1 : tool === "defense" ? 2 : 3;
    const maxRoom = tool === "speed" ? 5 : tool === "defense" ? 7 : 10;
    const room = minRoom + Math.round(unitFromKey(randomKey, player.id, `ceiling:${tool}`) * (maxRoom - minRoom));
    return [tool, clampRating(current[tool] + room)];
  }));
}

function profilePositionCeilings(player, profile, fallback) {
  const raw = profile?.ceilings;
  if (!raw) return fallback;
  const current = positionBaseRatings(player);
  return {
    contact: clampRating(Math.max(current.contact, finite(raw.contact, fallback.contact))),
    power: clampRating(Math.max(current.power, finite(raw.power, fallback.power))),
    vision: clampRating(Math.max(current.vision, finite(raw.vision, fallback.vision))),
    discipline: clampRating(Math.max(current.discipline, finite(raw.discipline, fallback.discipline))),
    defense: clampRating(Math.max(current.defense, finite(raw.defense, fallback.defense), finite(raw.reaction, fallback.defense))),
    speed: clampRating(Math.max(current.speed, finite(raw.speed, fallback.speed)))
  };
}

function positionReachableProjection(player, profile, ceilings) {
  const raw = profile?.reachableProjection;
  if (!raw) return { ...ceilings };
  const current = positionBaseRatings(player);
  return Object.fromEntries(POSITION_DEVELOPMENT_TOOLS.map((tool) => {
    const value = finite(raw?.[tool], ceilings[tool]);
    return [tool, clampRating(Math.max(current[tool], Math.min(ceilings[tool], value)))];
  }));
}

function defaultPitcherCeilings(player, randomKey) {
  const current = pitcherBaseRatings(player);
  const result = {};
  for (const tool of PITCHER_DEVELOPMENT_TOOLS) {
    if (tool === "velocityMph") {
      result[tool] = Number((current[tool] + 0.7 + unitFromKey(randomKey, player.id, "ceiling:velocity") * 1.8).toFixed(2));
      continue;
    }
    const minRoom = tool === "stamina" ? 2 : 3;
    const maxRoom = tool === "stamina" ? 7 : 10;
    result[tool] = clampRating(current[tool] + minRoom + Math.round(unitFromKey(randomKey, player.id, `ceiling:${tool}`) * (maxRoom - minRoom)));
  }
  return result;
}

function createPositionDevelopmentState(player, { seed = "", startingProfile = null } = {}) {
  if (!player?.id) throw new TypeError("position development에는 player.id가 필요합니다.");
  const randomKey = randomKeyFor(player.id, seed);
  const hiddenTrait = startingProfile?.hiddenDevelopmentTrait ?? deterministicTrait(randomKey, player.id);
  const fallbackCeilings = defaultPositionCeilings(player, randomKey);
  const ceilings = profilePositionCeilings(player, startingProfile, fallbackCeilings);
  const reachableProjection = positionReachableProjection(player, startingProfile, ceilings);
  return freeze({
    version: DEVELOPMENT_STATE_VERSION,
    focus: "BALANCED",
    randomKey,
    hiddenTrait,
    rate: Number(clamp(finite(startingProfile?.developmentRate, baseRate(randomKey, player.id, hiddenTrait)), 0.65, 1.35).toFixed(4)),
    workEthic: Number(clamp(finite(startingProfile?.workEthic, baseWorkEthic(randomKey, player.id)), 0.75, 1.25).toFixed(4)),
    trajectory: 1,
    progress: emptyTools(POSITION_DEVELOPMENT_TOOLS),
    gains: emptyTools(POSITION_DEVELOPMENT_TOOLS),
    ceilings,
    reachableProjection,
    processedOffseasons: [],
    lastOffseason: null
  });
}

function normalizePositionDevelopmentState(existing, player, options = {}) {
  const base = createPositionDevelopmentState(player, options);
  if (!existing) return base;
  return freeze({
    ...base,
    ...existing,
    version: DEVELOPMENT_STATE_VERSION,
    randomKey: Number.isInteger(existing.randomKey) ? existing.randomKey >>> 0 : base.randomKey,
    hiddenTrait: HIDDEN_TRAITS.includes(existing.hiddenTrait) ? existing.hiddenTrait : base.hiddenTrait,
    rate: Number(clamp(finite(existing.rate, base.rate), 0.65, 1.35).toFixed(4)),
    workEthic: Number(clamp(finite(existing.workEthic, base.workEthic), 0.75, 1.25).toFixed(4)),
    trajectory: Number(clamp(finite(existing.trajectory, 1), 0.65, 1.15).toFixed(4)),
    progress: normalizeTools(existing.progress, POSITION_DEVELOPMENT_TOOLS),
    gains: normalizeTools(existing.gains, POSITION_DEVELOPMENT_TOOLS),
    ceilings: Object.fromEntries(POSITION_DEVELOPMENT_TOOLS.map((tool) => {
      const value = Number(existing.ceilings?.[tool]);
      return [tool, Number.isFinite(value) ? value : base.ceilings[tool]];
    })),
    reachableProjection: Object.fromEntries(POSITION_DEVELOPMENT_TOOLS.map((tool) => {
      const ceiling = Number.isFinite(Number(existing.ceilings?.[tool])) ? Number(existing.ceilings[tool]) : base.ceilings[tool];
      const value = Number(existing.reachableProjection?.[tool]);
      const current = positionBaseRatings(player)[tool];
      return [tool, Number.isFinite(value) ? clampRating(Math.max(current, Math.min(ceiling, value))) : Math.min(ceiling, base.reachableProjection[tool])];
    })),
    processedOffseasons: normalizedProcessed(existing.processedOffseasons),
    lastOffseason: existing.lastOffseason ?? null
  });
}

function createPitcherDevelopmentState(player, { seed = "", startingProfile = null } = {}) {
  if (!player?.id) throw new TypeError("pitcher development에는 player.id가 필요합니다.");
  const randomKey = randomKeyFor(player.id, seed);
  const hiddenTrait = startingProfile?.hiddenDevelopmentTrait ?? deterministicTrait(randomKey, player.id);
  const current = pitcherBaseRatings(player);
  const fallback = defaultPitcherCeilings(player, randomKey);
  const ceilings = Object.fromEntries(PITCHER_DEVELOPMENT_TOOLS.map((tool) => {
    const raw = finite(startingProfile?.ceilings?.[tool], fallback[tool]);
    if (tool === "velocityMph") return [tool, Number(Math.max(current[tool], raw).toFixed(2))];
    return [tool, clampRating(Math.max(current[tool], raw))];
  }));
  const reachableProjection = Object.fromEntries(PITCHER_DEVELOPMENT_TOOLS.map((tool) => {
    const raw = finite(startingProfile?.reachableProjection?.[tool], ceilings[tool]);
    if (tool === "velocityMph") return [tool, Number(Math.max(current[tool], Math.min(ceilings[tool], raw)).toFixed(2))];
    return [tool, clampRating(Math.max(current[tool], Math.min(ceilings[tool], raw)))];
  }));
  return freeze({
    version: DEVELOPMENT_STATE_VERSION,
    randomKey,
    hiddenTrait,
    rate: Number(clamp(finite(startingProfile?.developmentRate, baseRate(randomKey, player.id, hiddenTrait)), 0.65, 1.35).toFixed(4)),
    workEthic: Number(clamp(finite(startingProfile?.workEthic, baseWorkEthic(randomKey, player.id)), 0.75, 1.25).toFixed(4)),
    trajectory: 1,
    progress: emptyTools(PITCHER_DEVELOPMENT_TOOLS),
    gains: emptyTools(PITCHER_DEVELOPMENT_TOOLS),
    ceilings,
    reachableProjection,
    pitchPotential: Array.isArray(startingProfile?.pitchPotential) ? startingProfile.pitchPotential : [],
    processedOffseasons: [],
    lastOffseason: null
  });
}

function normalizePitcherDevelopmentState(existing, player, options = {}) {
  const base = createPitcherDevelopmentState(player, options);
  if (!existing) return base;
  const rawCeilings = existing.ceilings ?? {};
  const ceilings = { ...base.ceilings };
  for (const tool of PITCHER_DEVELOPMENT_TOOLS) {
    const n = Number(rawCeilings[tool]);
    if (Number.isFinite(n)) ceilings[tool] = n;
  }
  const current = pitcherBaseRatings(player);
  const reachableProjection = { ...base.reachableProjection };
  for (const tool of PITCHER_DEVELOPMENT_TOOLS) {
    const n = Number(existing.reachableProjection?.[tool]);
    if (!Number.isFinite(n)) continue;
    reachableProjection[tool] = tool === "velocityMph"
      ? Number(Math.max(current[tool], Math.min(ceilings[tool], n)).toFixed(2))
      : clampRating(Math.max(current[tool], Math.min(ceilings[tool], n)));
  }
  return freeze({
    ...base,
    ...existing,
    version: DEVELOPMENT_STATE_VERSION,
    randomKey: Number.isInteger(existing.randomKey) ? existing.randomKey >>> 0 : base.randomKey,
    hiddenTrait: HIDDEN_TRAITS.includes(existing.hiddenTrait) ? existing.hiddenTrait : base.hiddenTrait,
    rate: Number(clamp(finite(existing.rate, base.rate), 0.65, 1.35).toFixed(4)),
    workEthic: Number(clamp(finite(existing.workEthic, base.workEthic), 0.75, 1.25).toFixed(4)),
    trajectory: Number(clamp(finite(existing.trajectory, 1), 0.65, 1.15).toFixed(4)),
    progress: normalizeTools(existing.progress, PITCHER_DEVELOPMENT_TOOLS),
    gains: normalizeTools(existing.gains, PITCHER_DEVELOPMENT_TOOLS),
    ceilings,
    reachableProjection,
    pitchPotential: Array.isArray(existing.pitchPotential)
      ? existing.pitchPotential
      : Array.isArray(base.pitchPotential) ? base.pitchPotential : [],
    processedOffseasons: normalizedProcessed(existing.processedOffseasons),
    lastOffseason: existing.lastOffseason ?? null
  });
}

function positionAgeCurve(age, tool) {
  const a = finite(age, 25);
  if (a <= 20) return tool === "speed" ? 1.24 : 1.36;
  if (a <= 23) return tool === "speed" ? 1.10 : 1.22;
  if (a <= 26) return tool === "speed" ? 0.72 : 0.90;
  if (a <= 29) {
    if (tool === "vision" || tool === "discipline") return 0.62;
    if (tool === "contact") return 0.52;
    if (tool === "power") return 0.45;
    if (tool === "defense") return 0.35;
    return 0.18;
  }
  if (a <= 32) {
    if (tool === "vision" || tool === "discipline") return 0.36;
    if (tool === "contact") return 0.20;
    if (tool === "power") return 0.16;
    if (tool === "defense") return 0.10;
    return 0.03;
  }
  if (a <= 35) {
    if (tool === "vision" || tool === "discipline") return 0.20;
    if (tool === "contact") return 0.08;
    if (tool === "power") return 0.05;
    if (tool === "defense") return 0.03;
    return 0;
  }
  return tool === "vision" || tool === "discipline" ? 0.08 : 0;
}

function pitcherAgeCurve(age, tool) {
  const a = finite(age, 26);
  if (a <= 20) return tool === "velocityMph" || tool === "stamina" ? 1.25 : 1.36;
  if (a <= 23) return tool === "velocityMph" ? 1.12 : 1.22;
  if (a <= 26) return tool === "velocityMph" ? 0.68 : tool === "stamina" ? 0.72 : 0.90;
  if (a <= 29) {
    if (tool === "pitchability" || tool === "command") return 0.62;
    if (tool === "control" || tool === "movement") return 0.48;
    if (tool === "stuff") return 0.30;
    if (tool === "stamina") return 0.20;
    return 0.12;
  }
  if (a <= 32) {
    if (tool === "pitchability" || tool === "command") return 0.38;
    if (tool === "control" || tool === "movement") return 0.22;
    if (tool === "stuff") return 0.10;
    if (tool === "stamina") return 0.05;
    return 0;
  }
  if (a <= 35) return tool === "pitchability" || tool === "command" ? 0.20 : tool === "control" ? 0.08 : 0;
  return tool === "pitchability" ? 0.08 : 0;
}

function hiddenTraitAgeFactor(hiddenTrait, age) {
  if (hiddenTrait === "EARLY_DEVELOPER") return age <= 23 ? 1.08 : age >= 28 ? 0.95 : 1.02;
  if (hiddenTrait === "LATE_BLOOMER") return age <= 21 ? 0.90 : age <= 27 ? 1.12 : age <= 30 ? 1.05 : 1;
  if (hiddenTrait === "POLISHED") return 1.03;
  return 1;
}

function developmentCoachingMultiplier(level = "AAA") {
  return ({ A: 1.07, HIGH_A: 1.06, AA: 1.04, AAA: 1.02, MLB: 1.00 })[level] ?? 1;
}

function remainingFactor(current, ceiling, { velocity = false } = {}) {
  const room = finite(ceiling, current) - finite(current, 50);
  if (room <= 0) return 0;
  const scale = velocity ? 1.8 : 9;
  return 0.22 + 0.78 * clamp(room / scale, 0, 1);
}

function battingPerformance(line) {
  const PA = Math.max(0, finite(line?.PA, 0));
  if (PA <= 0) return 1;
  const H = finite(line?.H, 0), doubles = finite(line?.doubles, 0), triples = finite(line?.triples, 0), HR = finite(line?.HR, 0);
  const BB = finite(line?.BB, 0), HBP = finite(line?.HBP, 0), SO = finite(line?.SO, 0);
  const singles = Math.max(0, H - doubles - triples - HR);
  const value = (singles + doubles * 1.55 + triples * 2 + HR * 2.45 + (BB + HBP) * 0.72 - SO * 0.12) / PA;
  const score = clamp((value - 0.33) / 0.55, -1, 1);
  return 1 + score * 0.06;
}

function pitchingPerformance(line) {
  const BF = Math.max(0, finite(line?.BF, 0));
  if (BF <= 0) return 1;
  const SO = finite(line?.SO, 0), BB = finite(line?.BB, 0), H = finite(line?.H, 0), HR = finite(line?.HR, 0), HBP = finite(line?.HBP, 0);
  const score = clamp(((SO * 0.55 - BB * 0.65 - H * 0.28 - HR * 0.75 - HBP * 0.25) / BF) / 0.28, -1, 1);
  return 1 + score * 0.06;
}

function appearanceFactor(type) {
  if (type === "PINCH_HIT" || type === "PINCH_RUN") return 0.48;
  if (type === "DEFENSIVE_REPLACEMENT") return 0.58;
  return 1;
}

function positionDevelopmentDelta({ player, development, battingLine, position = "DH", appearanceType = "START", age = 25, level = "AAA", currentRatings = null } = {}) {
  const PA = Math.max(0, finite(battingLine?.PA, 0));
  const H = finite(battingLine?.H, 0), doubles = finite(battingLine?.doubles, 0), triples = finite(battingLine?.triples, 0), HR = finite(battingLine?.HR, 0);
  const BB = finite(battingLine?.BB, 0), SO = finite(battingLine?.SO, 0), SB = finite(battingLine?.SB, 0);
  const XBH = doubles + triples + HR;
  const opportunity = (0.0105 + PA * 0.00125) * appearanceFactor(appearanceType);
  const common = finite(development?.rate, 1) * finite(development?.workEthic, 1) * finite(development?.trajectory, 1)
    * developmentCoachingMultiplier(level) * hiddenTraitAgeFactor(development?.hiddenTrait, age) * battingPerformance(battingLine);
  const signals = {
    contact: 1 + clamp((H / Math.max(1, PA) - 0.22) * 0.65 - SO / Math.max(1, PA) * 0.08, -0.15, 0.20),
    power: 0.90 + clamp(XBH / Math.max(1, PA) * 0.50, 0, 0.22),
    vision: 0.96 + clamp((PA - SO) / Math.max(1, PA) * 0.08, 0, 0.08),
    discipline: 0.90 + clamp(BB / Math.max(1, PA) * 0.65, 0, 0.22),
    defense: position === "DH" ? 0.16 : 1.00,
    speed: 0.58 + clamp(SB * 0.12, 0, 0.20)
  };
  const current = currentRatings ?? positionBaseRatings(player);
  return Object.fromEntries(POSITION_DEVELOPMENT_TOOLS.map((tool) => {
    const remaining = remainingFactor(current[tool], development?.ceilings?.[tool]);
    const delta = opportunity * common * signals[tool] * positionAgeCurve(age, tool) * remaining;
    return [tool, Number(Math.max(0, delta).toFixed(8))];
  }));
}

function pitcherDevelopmentDelta({ player, development, pitchingLine = null, pitchCount = 0, age = 26, level = "AAA", currentRatings = null } = {}) {
  const BF = Math.max(0, finite(pitchingLine?.BF, 0));
  const pitches = Math.max(0, finite(pitchingLine?.Pitches, pitchCount));
  const SO = finite(pitchingLine?.SO, 0), BB = finite(pitchingLine?.BB, 0), HR = finite(pitchingLine?.HR, 0);
  // Relievers throw fewer pitches than starters, but non-stamina skill development
  // should not collapse simply because of role. Normalize their per-appearance
  // opportunity while stamina remains role-sensitive below.
  const role = player?.pitching?.role ?? "RP";
  const roleOpportunity = role === "SP" ? 1 : 1.35;
  const opportunity = Math.min(0.022, (0.004 + BF * 0.00035 + pitches * 0.00008) * roleOpportunity);
  const common = finite(development?.rate, 1) * finite(development?.workEthic, 1) * finite(development?.trajectory, 1)
    * developmentCoachingMultiplier(level) * hiddenTraitAgeFactor(development?.hiddenTrait, age) * pitchingPerformance(pitchingLine);
  const signals = {
    control: 0.96 + clamp((1 - BB / Math.max(1, BF)) * 0.08, 0, 0.08),
    command: 0.94 + clamp((SO - BB) / Math.max(1, BF) * 0.10, -0.05, 0.08),
    movement: 0.95 + clamp((1 - HR / Math.max(1, BF)) * 0.07, 0, 0.07),
    pitchability: 1.00,
    stamina: (player?.pitching?.role ?? "RP") === "SP" ? 0.94 : 0.55,
    stuff: 0.94 + clamp(SO / Math.max(1, BF) * 0.18, 0, 0.12),
    velocityMph: 0.78
  };
  const current = currentRatings ?? pitcherBaseRatings(player);
  return Object.fromEntries(PITCHER_DEVELOPMENT_TOOLS.map((tool) => {
    const remaining = remainingFactor(current[tool], development?.ceilings?.[tool], { velocity: tool === "velocityMph" });
    const delta = opportunity * common * signals[tool] * pitcherAgeCurve(age, tool) * remaining;
    return [tool, Number(Math.max(0, delta).toFixed(8))];
  }));
}

function offseasonType(development, playerId, seasonKey, age) {
  const u = unitFromKey(development.randomKey, playerId, `offseason:${seasonKey}:type`);
  const variance = development.hiddenTrait === "HIGH_VARIANCE" ? 0.025 : 0;
  const late = development.hiddenTrait === "LATE_BLOOMER" && age >= 22 && age <= 28 ? 0.025 : 0;
  const polishedBustReduction = development.hiddenTrait === "POLISHED" ? 0.012 : 0;
  const ethic = clamp((development.workEthic - 1) * 0.10, -0.018, 0.018);
  const breakout = clamp(0.035 + variance + late + ethic, 0.015, 0.10);
  const bust = clamp(0.035 + variance - ethic - polishedBustReduction, 0.012, 0.09);
  const stagnation = clamp(0.085 + (development.hiddenTrait === "POLISHED" ? -0.025 : 0) - ethic * 0.5, 0.035, 0.13);
  if (u < breakout) return "BREAKOUT";
  if (u < breakout + bust) return "BUST";
  if (u < breakout + bust + stagnation) return "STAGNATION";
  return "NORMAL";
}

function selectedTools(development, playerId, seasonKey, tools, count = 2) {
  return [...tools].sort((a, b) => unitFromKey(development.randomKey, playerId, `offseason:${seasonKey}:${b}`) - unitFromKey(development.randomKey, playerId, `offseason:${seasonKey}:${a}`)).slice(0, count);
}

function applyOffseason(development, playerId, { seasonKey, age, currentRatings, tools, velocityTool = null } = {}) {
  if (typeof seasonKey !== "string" || !seasonKey) throw new TypeError("development seasonKey가 필요합니다.");
  if (development.processedOffseasons.includes(seasonKey)) return freeze({ development, applied: false, outcome: null });
  const type = offseasonType(development, playerId, seasonKey, age);
  let rate = development.rate;
  let trajectory = 1;
  const ceilings = { ...development.ceilings };
  const reachableProjection = { ...(development.reachableProjection ?? development.ceilings) };
  const changes = {};
  if (type === "BREAKOUT") {
    rate = clamp(rate + 0.04, 0.65, 1.35);
    trajectory = 1.08;
    for (const tool of selectedTools(development, playerId, seasonKey, tools)) {
      const amount = tool === velocityTool ? 0.35 : 1 + Math.floor(unitFromKey(development.randomKey, playerId, `breakout:${seasonKey}:${tool}`) * 2);
      ceilings[tool] = tool === velocityTool ? Number((ceilings[tool] + amount).toFixed(2)) : clampRating(ceilings[tool] + amount);
      reachableProjection[tool] = tool === velocityTool
        ? Number(Math.min(ceilings[tool], finite(reachableProjection[tool], ceilings[tool]) + amount * 0.8).toFixed(2))
        : clampRating(Math.min(ceilings[tool], finite(reachableProjection[tool], ceilings[tool]) + amount * 0.8));
      changes[tool] = amount;
    }
  } else if (type === "BUST") {
    rate = clamp(rate - 0.04, 0.65, 1.35);
    trajectory = 0.92;
    for (const tool of selectedTools(development, playerId, seasonKey, tools)) {
      const amount = tool === velocityTool ? 0.25 : 1;
      const floor = finite(currentRatings?.[tool], tool === velocityTool ? 90 : 20);
      ceilings[tool] = tool === velocityTool
        ? Number(Math.max(floor, ceilings[tool] - amount).toFixed(2))
        : clampRating(Math.max(floor, ceilings[tool] - amount));
      reachableProjection[tool] = tool === velocityTool
        ? Number(Math.max(floor, Math.min(ceilings[tool], finite(reachableProjection[tool], ceilings[tool]) - amount * 0.8)).toFixed(2))
        : clampRating(Math.max(floor, Math.min(ceilings[tool], finite(reachableProjection[tool], ceilings[tool]) - amount * 0.8)));
      changes[tool] = -amount;
    }
  } else if (type === "STAGNATION") {
    trajectory = 0.72;
  }
  const lastOffseason = freeze({ seasonKey, type, rateBefore: development.rate, rateAfter: Number(rate.toFixed(4)), trajectory: Number(trajectory.toFixed(4)), ceilingChanges: changes });
  const next = freeze({
    ...development,
    rate: Number(rate.toFixed(4)),
    trajectory: Number(trajectory.toFixed(4)),
    ceilings,
    reachableProjection,
    processedOffseasons: [...development.processedOffseasons, seasonKey].sort(),
    lastOffseason
  });
  return freeze({ development: next, applied: true, outcome: lastOffseason });
}

function applyAnnualPositionDevelopment(development, player, { seasonKey, age, currentRatings } = {}) {
  return applyOffseason(development, player.id, { seasonKey, age, currentRatings, tools: POSITION_DEVELOPMENT_TOOLS });
}

function applyAnnualPitcherDevelopment(development, player, { seasonKey, age, currentRatings } = {}) {
  return applyOffseason(development, player.id, { seasonKey, age, currentRatings, tools: PITCHER_DEVELOPMENT_TOOLS, velocityTool: "velocityMph" });
}

export { DEVELOPMENT_STATE_VERSION, POSITION_DEVELOPMENT_TOOLS, PITCHER_DEVELOPMENT_TOOLS, DEVELOPMENT_TRAJECTORIES, createPositionDevelopmentState, normalizePositionDevelopmentState, createPitcherDevelopmentState, normalizePitcherDevelopmentState, developmentCoachingMultiplier, positionDevelopmentDelta, pitcherDevelopmentDelta, applyAnnualPositionDevelopment, applyAnnualPitcherDevelopment };
