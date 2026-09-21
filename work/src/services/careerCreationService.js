import { SeededRng } from "../engine/rng.js";
import { BODY_TYPES, STARTING_ARCHETYPES, USER_PRIMARY_POSITIONS, VISIBLE_TRAITS, generateAmateurPositionPlayer, getAmateurProfilePreview } from "../engine/player/amateurProfile.js";
import { getDemoOrganizationOptions } from "./demoSeasonFactory.js";

const CAREER_CREATION_VERSION = 1;

const BAT_OPTIONS = Object.freeze(["R", "L", "S"]);
const THROW_OPTIONS = Object.freeze(["R", "L"]);
const ORGANIZATION_MODES = Object.freeze(["RANDOM", "FAVORITE"]);

const ARCHETYPE_LABELS = Object.freeze({
  HIT_FIRST: "컨택 우선",
  POWER_FIRST: "파워 우선",
  POWER_SPEED: "파워-스피드",
  GLOVE_FIRST: "수비 우선",
  ATHLETIC: "운동능력",
  DISCIPLINE_FIRST: "선구안 우선",
  RAW_TOOLS: "원석형",
  BALANCED: "균형형"
});

const ARCHETYPE_DESCRIPTIONS = Object.freeze({
  HIT_FIRST: "배트 컨트롤과 컨택에 조금 더 무게를 둡니다.",
  POWER_FIRST: "장타 생산에 재능을 더 배분합니다.",
  POWER_SPEED: "파워와 스피드를 함께 노리는 유형입니다.",
  GLOVE_FIRST: "수비·반응·송구 쪽 비중이 높습니다.",
  ATHLETIC: "스피드와 반응, 전반적 운동능력 중심입니다.",
  DISCIPLINE_FIRST: "선구안과 존 관리 능력에 무게를 둡니다.",
  RAW_TOOLS: "거친 대신 파워·운동능력의 폭이 큰 유형입니다.",
  BALANCED: "특정 도구에 과하게 치우치지 않습니다."
});

const BODY_TYPE_LABELS = Object.freeze({
  LEAN: "슬림",
  AVERAGE: "보통",
  ATHLETIC: "애슬레틱",
  STURDY: "탄탄",
  POWER_FRAME: "파워 프레임"
});

const BODY_TYPE_DESCRIPTIONS = Object.freeze({
  LEAN: "스피드·반응 쪽에 아주 작은 경향을 줍니다.",
  AVERAGE: "체형으로 인한 추가 기울기가 없습니다.",
  ATHLETIC: "스피드·수비·반응에 약한 경향을 줍니다.",
  STURDY: "파워·송구 쪽에 약한 경향을 줍니다.",
  POWER_FRAME: "파워 쪽에 약한 경향, 스피드 쪽에 작은 트레이드오프가 있습니다."
});

const TRAIT_LABELS = Object.freeze({
  QUICK_BAT: "빠른 배트",
  RAW_STRENGTH: "원초적 힘",
  ADVANCED_APPROACH: "성숙한 어프로치",
  TWO_STRIKE_HITTER: "투스트라이크 대응",
  PULL_POWER: "당겨치기 파워",
  ALL_FIELDS_HITTER: "전 방향 타격",
  FASTBALL_HUNTER: "패스트볼 헌터",
  BREAKING_BALL_HITTER: "변화구 대응",
  SOFT_HANDS: "부드러운 핸드",
  QUICK_FIRST_STEP: "빠른 첫발",
  STRONG_ARM: "강한 어깨",
  ACCURATE_ARM: "정확한 송구",
  VERSATILE: "멀티 포지션",
  ELITE_BURST: "폭발적 스타트",
  AGGRESSIVE_RUNNER: "공격적 주루",
  SMART_BASERUNNER: "영리한 주루",
  BASE_STEALER: "도루 감각"
});

function normalizeText(value, label, { max = 32, fallback = "" } = {}) {
  const raw = value == null ? fallback : String(value);
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) throw new RangeError(`${label}을(를) 입력해주세요.`);
  if (text.length > max) throw new RangeError(`${label}은(는) ${max}자 이하여야 합니다.`);
  return text;
}

function normalizeInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new RangeError(`${label}은(는) ${min}~${max} 범위의 정수여야 합니다.`);
  }
  return number;
}

function assertChoice(value, choices, label) {
  if (!choices.includes(value)) throw new RangeError(`${label} 값이 올바르지 않습니다: ${value}`);
  return value;
}

function normalizeTraits(value) {
  const traits = Array.isArray(value) ? value : [];
  const unique = [...new Set(traits)];
  if (unique.length !== traits.length) throw new RangeError("특성은 중복 선택할 수 없습니다.");
  if (unique.length > 2) throw new RangeError("특성은 최대 2개까지 선택할 수 있습니다.");
  unique.forEach((trait) => assertChoice(trait, VISIBLE_TRAITS, "특성"));
  return unique;
}

function organizationById(id, options = getDemoOrganizationOptions()) {
  return options.find((team) => String(team.id) === String(id)) ?? null;
}

function resolveOrganization(seed, mode, favoriteOrganizationId, options = getDemoOrganizationOptions()) {
  assertChoice(mode, ORGANIZATION_MODES, "조직 선택 방식");
  let team;
  if (mode === "FAVORITE") {
    team = organizationById(favoriteOrganizationId, options);
    if (!team) throw new RangeError("선호 조직을 선택해주세요.");
  } else {
    const rng = new SeededRng(`career-organization-v${CAREER_CREATION_VERSION}:${seed}`);
    team = options[Math.floor(rng.next() * options.length)];
  }
  return Object.freeze({
    mode,
    teamId: team.id,
    teamName: team.name,
    teamShortName: team.shortName,
    pool: team.pool ?? "DEV_8",
    provisional: team.provisional ?? true
  });
}

function getCareerCreationCatalog({ organizations = null } = {}) {
  return Object.freeze({
    version: CAREER_CREATION_VERSION,
    ages: Object.freeze([18, 19, 20, 21, 22]),
    positions: USER_PRIMARY_POSITIONS,
    bats: BAT_OPTIONS,
    throws: THROW_OPTIONS,
    bodyTypes: Object.freeze(BODY_TYPES.map((key) => Object.freeze({ key, label: BODY_TYPE_LABELS[key], description: BODY_TYPE_DESCRIPTIONS[key] }))),
    archetypes: Object.freeze(STARTING_ARCHETYPES.map((key) => Object.freeze({ key, label: ARCHETYPE_LABELS[key], description: ARCHETYPE_DESCRIPTIONS[key] }))),
    traits: Object.freeze(VISIBLE_TRAITS.map((key) => Object.freeze({ key, label: TRAIT_LABELS[key] ?? key }))),
    organizationModes: ORGANIZATION_MODES,
    organizations: Object.freeze([...(organizations ?? getDemoOrganizationOptions())])
  });
}

function normalizeCareerCreationInput(input = {}) {
  const identity = Object.freeze({
    name: normalizeText(input.name, "이름", { max: 24 }),
    nationality: normalizeText(input.nationality, "국적", { max: 24 }),
    hometown: normalizeText(input.hometown, "출신지", { max: 36 }),
    age: normalizeInteger(input.age, "나이", 18, 22),
    heightCm: normalizeInteger(input.heightCm, "키", 160, 205),
    weightKg: normalizeInteger(input.weightKg, "몸무게", 55, 125),
    bats: assertChoice(input.bats, BAT_OPTIONS, "타석"),
    throws: assertChoice(input.throws, THROW_OPTIONS, "송구손"),
    primaryPosition: assertChoice(input.primaryPosition, USER_PRIMARY_POSITIONS, "주포지션"),
    bodyType: assertChoice(input.bodyType, BODY_TYPES, "체형")
  });
  return Object.freeze({
    identity,
    archetype: assertChoice(input.archetype, STARTING_ARCHETYPES, "선수 유형"),
    visibleTraits: Object.freeze(normalizeTraits(input.visibleTraits)),
    organizationMode: assertChoice(input.organizationMode ?? "RANDOM", ORGANIZATION_MODES, "조직 선택 방식"),
    favoriteOrganizationId: input.favoriteOrganizationId == null ? null : String(input.favoriteOrganizationId)
  });
}

function buildCareerCreationPlan({ seed, input, organizations = null } = {}) {
  if (typeof seed !== "string" || !seed) throw new TypeError("새 커리어 seed가 필요합니다.");
  const normalized = normalizeCareerCreationInput(input);
  const generated = generateAmateurPositionPlayer({
    seed,
    id: "user_001",
    age: normalized.identity.age,
    bats: normalized.identity.bats,
    throws: normalized.identity.throws,
    primaryPosition: normalized.identity.primaryPosition,
    bodyType: normalized.identity.bodyType,
    archetype: normalized.archetype,
    visibleTraits: normalized.visibleTraits
  });
  const organization = resolveOrganization(seed, normalized.organizationMode, normalized.favoriteOrganizationId, organizations ?? getDemoOrganizationOptions());
  const preview = getAmateurProfilePreview(generated);
  return Object.freeze({
    version: CAREER_CREATION_VERSION,
    identity: normalized.identity,
    organization,
    generated,
    publicPreview: Object.freeze({
      version: CAREER_CREATION_VERSION,
      identity: normalized.identity,
      organization,
      archetype: normalized.archetype,
      archetypeLabel: ARCHETYPE_LABELS[normalized.archetype],
      visibleTraits: Object.freeze(normalized.visibleTraits.map((key) => Object.freeze({ key, label: TRAIT_LABELS[key] ?? key }))),
      profile: preview
    })
  });
}

export { CAREER_CREATION_VERSION, getCareerCreationCatalog, normalizeCareerCreationInput, buildCareerCreationPlan };
