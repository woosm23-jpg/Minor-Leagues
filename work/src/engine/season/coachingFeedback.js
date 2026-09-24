const TRAINING_FOCUSES = new Set([
  "BALANCED", "CONTACT", "POWER", "PLATE_DISCIPLINE", "DEFENSE", "SPEED"
]);
const VERSATILITY_ROLES = new Set(["UTILITY", "ROTATION"]);

// Player-safe coaching advice. No hidden ceiling, growth rate, scouting truth,
// protagonist flags, or manager decision inputs are read or modified here.
function getTrainingCoachFeedback({ seasonLine = null, roleState = null, playingTime = null, currentFocus = "BALANCED" } = {}) {
  if (!TRAINING_FOCUSES.has(currentFocus)) throw new RangeError(`지원하지 않는 훈련 집중입니다: ${currentFocus}`);
  const pa = Math.max(0, Math.floor(Number(seasonLine?.PA ?? 0) || 0));
  const strikeouts = Math.max(0, Number(seasonLine?.SO ?? 0) || 0);
  const walks = Math.max(0, Number(seasonLine?.BB ?? 0) || 0);
  const secondaryGames = Math.max(0, Number(playingTime?.secondaryGames ?? 0) || 0);
  let recommendedFocus = "BALANCED";
  let reasonCode = pa < 60 ? "SMALL_SAMPLE" : "GENERAL_DEVELOPMENT";

  if (VERSATILITY_ROLES.has(roleState?.role) && secondaryGames >= 2) {
    recommendedFocus = "DEFENSE";
    reasonCode = "SECONDARY_POSITION_USAGE";
  } else if (pa >= 60 && strikeouts / pa >= 0.28) {
    recommendedFocus = "CONTACT";
    reasonCode = "STRIKEOUT_RATE";
  } else if (pa >= 60 && walks / pa <= 0.045) {
    recommendedFocus = "PLATE_DISCIPLINE";
    reasonCode = "WALK_RATE";
  }

  return Object.freeze({
    recommendedFocus,
    reasonCode,
    selectedFocus: currentFocus,
    aligned: recommendedFocus === currentFocus,
    effect: "DEVELOPMENT_ALLOCATION_ONLY",
    samplePA: pa
  });
}

export { getTrainingCoachFeedback };
