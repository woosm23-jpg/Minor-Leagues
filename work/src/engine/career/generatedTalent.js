import { SeededRng } from "../rng.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../player/playerFixtures.js";

const GENERATED_TALENT_VERSION = 5;
const HITTER_POSITIONS = Object.freeze(["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"]);
const CLASS_TYPES = Object.freeze(["BALANCED", "TOP_HEAVY", "DEEP", "PITCHING_HEAVY", "HITTING_HEAVY", "WEAK"]);
const BACKGROUNDS = Object.freeze(["HIGH_SCHOOL", "COLLEGE", "JUCO", "INTERNATIONAL"]);

const FIRST_NAMES = Object.freeze(["Alex","Jordan","Mateo","Luis","Diego","Noah","Ethan","Mason","Leo","Nico","Jae","Min","Jun","Kai","Dylan","Carter","Eli","Adrian","Marco","Rafael","Tomas","Victor","Andre","Caleb"]);
const LAST_NAMES = Object.freeze(["Garcia","Rodriguez","Martinez","Lee","Kim","Park","Smith","Johnson","Brown","Wilson","Lopez","Gonzalez","Rivera","Torres","Diaz","Ramirez","Miller","Davis","Clark","Lewis","Walker","Young","Hall","Allen"]);

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === "object") return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}
function centered(rng) { return (rng.next() + rng.next() + rng.next() - 1.5) / 1.5; }
function grade(v) { return Math.round(clamp(v, 20, 99)); }

function classShape(type) {
  return {
    BALANCED: { mean: 0, spread: 1, pitcherShare: 0.61 },
    TOP_HEAVY: { mean: 0.05, spread: 1.28, pitcherShare: 0.61 },
    DEEP: { mean: 0.14, spread: 0.82, pitcherShare: 0.61 },
    PITCHING_HEAVY: { mean: 0.04, spread: 1.00, pitcherShare: 0.70 },
    HITTING_HEAVY: { mean: 0.04, spread: 1.00, pitcherShare: 0.50 },
    WEAK: { mean: -0.42, spread: 0.90, pitcherShare: 0.61 }
  }[type] ?? { mean: 0, spread: 1, pitcherShare: 0.61 };
}

function chooseClassType(rng, previousStrength = 0) {
  const roll = rng.next();
  // Mean reversion: a very strong previous class makes another top-heavy/deep class less likely.
  if (previousStrength > 0.45 && roll < 0.28) return "WEAK";
  if (previousStrength < -0.45 && roll < 0.28) return "DEEP";
  if (roll < 0.13) return "TOP_HEAVY";
  if (roll < 0.26) return "DEEP";
  if (roll < 0.38) return "PITCHING_HEAVY";
  if (roll < 0.50) return "HITTING_HEAVY";
  if (roll < 0.62) return "WEAK";
  return "BALANCED";
}

function backgroundForPath(rng, entryPath) {
  if (entryPath === "INTERNATIONAL") return "INTERNATIONAL";
  const x = rng.next();
  if (x < 0.43) return "HIGH_SCHOOL";
  if (x < 0.86) return "COLLEGE";
  return "JUCO";
}

function ageForBackground(rng, background) {
  if (background === "INTERNATIONAL") return rng.int(16, 19);
  if (background === "HIGH_SCHOOL") return rng.int(18, 19);
  if (background === "JUCO") return rng.int(19, 21);
  return rng.int(20, 22);
}

function playerName(rng) {
  return `${FIRST_NAMES[rng.int(0, FIRST_NAMES.length - 1)]} ${LAST_NAMES[rng.int(0, LAST_NAMES.length - 1)]}`;
}

function positionForHitter(rng) {
  const x = rng.next();
  if (x < 0.12) return "C";
  if (x < 0.23) return "1B";
  if (x < 0.35) return "2B";
  if (x < 0.47) return "3B";
  if (x < 0.60) return "SS";
  if (x < 0.73) return "LF";
  if (x < 0.87) return "CF";
  return "RF";
}

function readiness(background, age) {
  const base = background === "COLLEGE" ? 4.5 : background === "JUCO" ? 2.8 : background === "HIGH_SCHOOL" ? -1.5 : -3.0;
  return base + (age - 18) * 0.9;
}

function uncertainty(background) {
  if (background === "INTERNATIONAL") return 0.86;
  if (background === "HIGH_SCHOOL") return 0.78;
  if (background === "JUCO") return 0.62;
  return 0.48;
}


function developmentTrait(rng) {
  const traits = ["LATE_BLOOMER", "EARLY_DEVELOPER", "HIGH_VARIANCE", "POLISHED"];
  return traits[rng.int(0, traits.length - 1)];
}

function developmentMeta(rng, trait) {
  const rateShift = trait === "EARLY_DEVELOPER" ? 0.04 : trait === "LATE_BLOOMER" ? -0.02 : trait === "POLISHED" ? 0.02 : 0;
  return {
    hiddenDevelopmentTrait: trait,
    developmentRate: Number(clamp(1.02 + rng.next() * 0.28 + rateShift, 0.72, 1.28).toFixed(4)),
    workEthic: Number((0.86 + rng.next() * 0.28).toFixed(4))
  };
}

function makeHitter({ id, name, age, background, talentZ, rng, entryPath }) {
  const pos = positionForHitter(rng);
  const currentBase = 31 + readiness(background, age) + talentZ * 5.4;
  const backgroundRoom = background === "INTERNATIONAL" ? 6.0 : background === "HIGH_SCHOOL" ? 2.5 : background === "JUCO" ? 1.0 : 0;
  const futureRoom = clamp(20 + (20 - age) * 1.4 + backgroundRoom + Math.max(0, talentZ) * 5 + centered(rng) * 3, 4, 39);
  const contact = grade(currentBase + centered(rng) * 6);
  const power = grade(currentBase + centered(rng) * 7 + (pos === "1B" || pos === "LF" || pos === "RF" ? 2 : 0));
  const vision = grade(currentBase + centered(rng) * 5 + (background === "COLLEGE" ? 2 : 0));
  const discipline = grade(currentBase + centered(rng) * 5 + (background === "COLLEGE" ? 3 : 0));
  const defense = grade(currentBase + centered(rng) * 7 + (["C","SS","CF"].includes(pos) ? 2 : 0));
  const reaction = grade(defense + centered(rng) * 4);
  const arm = grade(currentBase + centered(rng) * 8 + (["C","3B","SS","RF"].includes(pos) ? 3 : 0));
  const speed = grade(currentBase + centered(rng) * 8 + (["SS","CF","2B"].includes(pos) ? 4 : 0) - (pos === "C" || pos === "1B" ? 4 : 0));
  const ovr = grade((contact + power + vision + discipline + defense + reaction + arm + speed) / 8);
  const player = createPhase1Hitter({
    id, bats: rng.next() < 0.28 ? "L" : rng.next() < 0.08 ? "S" : "R", throws: pos === "1B" || pos === "RF" || pos === "CF" || pos === "LF" ? (rng.next() < 0.18 ? "L" : "R") : "R",
    contactR: contact, contactL: grade(contact + centered(rng) * 3), rawPower: power, vision, discipline,
    powerUtilizationR: grade(power - 2 + centered(rng) * 3), powerUtilizationL: grade(power - 2 + centered(rng) * 3),
    speed, stealing: grade(speed - 2 + centered(rng) * 4), baserunning: grade((speed + vision) / 2 + centered(rng) * 3),
    fielding: defense, reaction, armStrength: arm, armAccuracy: grade((arm + defense) / 2 + centered(rng) * 3),
    primaryPosition: pos, adaptability: grade(47 + centered(rng) * 12), ovr
  });
  const ceilings = {
    contact: grade(contact + futureRoom + centered(rng) * 3), power: grade(power + futureRoom + centered(rng) * 4), vision: grade(vision + futureRoom * 0.8 + centered(rng) * 3),
    discipline: grade(discipline + futureRoom * 0.8 + centered(rng) * 3), defense: grade(defense + futureRoom * 0.65 + centered(rng) * 3), reaction: grade(reaction + futureRoom * 0.65 + centered(rng) * 3),
    arm: grade(arm + futureRoom * 0.45 + centered(rng) * 3), speed: grade(speed + futureRoom * 0.35 + centered(rng) * 3)
  };
  const trait = developmentTrait(rng);
  const dev = developmentMeta(rng, trait);
  const reachableProjection = {
    contact: grade(contact + (ceilings.contact-contact) * 0.82), power: grade(power + (ceilings.power-power) * 0.82),
    vision: grade(vision + (ceilings.vision-vision) * 0.86), discipline: grade(discipline + (ceilings.discipline-discipline) * 0.86),
    defense: grade(Math.max(defense,reaction) + (Math.max(ceilings.defense,ceilings.reaction)-Math.max(defense,reaction)) * 0.80),
    speed: grade(speed + (ceilings.speed-speed) * 0.78)
  };
  return freeze({
    ...player, fullName: name, physical: { age, durability: grade(50 + centered(rng) * 13) }, generated: true,
    generatedProfile: { version: GENERATED_TALENT_VERSION, entryPath, background, talentZ: Number(talentZ.toFixed(4)), uncertainty: uncertainty(background), ...dev, ceilings, reachableProjection, trueCeilingOvr: grade(Object.values(ceilings).reduce((a,b)=>a+b,0)/8) }
  });
}

function makePitcher({ id, name, age, background, talentZ, rng, entryPath }) {
  const currentBase = 31 + readiness(background, age) + talentZ * 5.2;
  const backgroundRoom = background === "INTERNATIONAL" ? 6.0 : background === "HIGH_SCHOOL" ? 2.5 : background === "JUCO" ? 1.0 : 0;
  const futureRoom = clamp(21 + (20 - age) * 1.3 + backgroundRoom + Math.max(0, talentZ) * 5 + centered(rng) * 3, 4, 39);
  const stuff = grade(currentBase + centered(rng) * 8 + 2);
  const movement = grade(currentBase + centered(rng) * 7);
  const control = grade(currentBase + centered(rng) * 6 + (background === "COLLEGE" ? 3 : 0));
  const command = grade(currentBase + centered(rng) * 6 + (background === "COLLEGE" ? 2 : 0));
  const pitchability = grade(currentBase + centered(rng) * 5 + (background === "COLLEGE" ? 3 : 0));
  const stamina = grade(currentBase + 7 + centered(rng) * 12);
  const starterChance = clamp(0.34 + (stamina - 42) * 0.012, 0.24, 0.50);
  const role = rng.next() < starterChance ? "SP" : "RP";
  const velocity = clamp(91.0 + talentZ * 1.8 + centered(rng) * 2.4 + (background === "HIGH_SCHOOL" || background === "INTERNATIONAL" ? 0.5 : 0), 84, 101);
  const ovr = grade(stuff * 0.24 + movement * 0.17 + control * 0.18 + command * 0.16 + pitchability * 0.15 + stamina * 0.10);
  const player = createPhase1Pitcher({ id, throws: rng.next() < 0.28 ? "L" : "R", stuff, movement, control, command, pitchability, stamina, role, pitchVelocityMph: Number(velocity.toFixed(1)), ovr });
  const ceilings = {
    stuff: grade(stuff + futureRoom + centered(rng) * 4), movement: grade(movement + futureRoom * 0.8 + centered(rng) * 3), control: grade(control + futureRoom * 0.75 + centered(rng) * 3),
    command: grade(command + futureRoom * 0.7 + centered(rng) * 3), pitchability: grade(pitchability + futureRoom * 0.65 + centered(rng) * 3), stamina: grade(stamina + futureRoom * 0.45 + centered(rng) * 3),
    velocityMph: Number(clamp(velocity + Math.max(0.4, futureRoom * 0.08) + centered(rng) * 0.45, velocity, 102).toFixed(1))
  };
  const trait = developmentTrait(rng);
  const dev = developmentMeta(rng, trait);
  const reachableProjection = {
    stuff: grade(stuff + (ceilings.stuff-stuff) * 0.82), movement: grade(movement + (ceilings.movement-movement) * 0.82),
    control: grade(control + (ceilings.control-control) * 0.86), command: grade(command + (ceilings.command-command) * 0.86),
    pitchability: grade(pitchability + (ceilings.pitchability-pitchability) * 0.88), stamina: grade(stamina + (ceilings.stamina-stamina) * 0.78),
    velocityMph: Number((velocity + (ceilings.velocityMph-velocity) * 0.80).toFixed(1))
  };
  return freeze({
    ...player, fullName: name, physical: { age, durability: grade(50 + centered(rng) * 13) }, generated: true,
    generatedProfile: { version: GENERATED_TALENT_VERSION, entryPath, background, talentZ: Number(talentZ.toFixed(4)), uncertainty: uncertainty(background), ...dev, ceilings, reachableProjection, trueCeilingOvr: grade((ceilings.stuff+ceilings.movement+ceilings.control+ceilings.command+ceilings.pitchability+ceilings.stamina)/6) }
  });
}

function generateAmateurClass({ seed, year, size = 600, classType = null, previousClassStrength = 0, entryPath = "DRAFT", idOffset = 0 } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("generated class seed가 필요합니다.");
  if (!Number.isInteger(year) || year < 1900) throw new RangeError("generated class year가 올바르지 않습니다.");
  if (!Number.isInteger(size) || size < 0 || size > 5000) throw new RangeError("generated class size가 올바르지 않습니다.");
  if (!Number.isInteger(idOffset) || idOffset < 0) throw new RangeError("idOffset이 올바르지 않습니다.");
  const rng = new SeededRng(`generated-class-v${GENERATED_TALENT_VERSION}:${seed}:${year}:${entryPath}:${idOffset}`);
  const resolvedType = classType ?? chooseClassType(rng, previousClassStrength);
  if (!CLASS_TYPES.includes(resolvedType)) throw new RangeError(`지원하지 않는 classType: ${resolvedType}`);
  const shape = classShape(resolvedType);
  const players = [];
  let talentSum = 0;
  for (let i = 0; i < size; i += 1) {
    const serial = idOffset + i + 1;
    const id = `gen_${year}_${String(serial).padStart(6, "0")}`;
    const background = backgroundForPath(rng, entryPath);
    const age = ageForBackground(rng, background);
    let talentZ = shape.mean + centered(rng) * 1.55 * shape.spread;
    if (resolvedType === "TOP_HEAVY" && rng.next() < 0.055) talentZ += 1.25 + rng.next() * 0.75;
    if (resolvedType !== "WEAK" && rng.next() < 0.05) talentZ += 1.00 + rng.next() * 0.60;
    if (resolvedType === "DEEP") talentZ += centered(rng) * 0.25;
    talentZ = clamp(talentZ, -2.2, 2.6);
    talentSum += talentZ;
    const common = { id, name: playerName(rng), age, background, talentZ, rng, entryPath };
    players.push(rng.next() < shape.pitcherShare ? makePitcher(common) : makeHitter(common));
  }
  return freeze({
    version: GENERATED_TALENT_VERSION, year, entryPath, classType: resolvedType, players,
    classStrength: size ? Number((talentSum / size).toFixed(4)) : 0
  });
}

export { GENERATED_TALENT_VERSION, CLASS_TYPES, BACKGROUNDS, generateAmateurClass };
