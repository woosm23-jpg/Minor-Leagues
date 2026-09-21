const ruleset2026 = Object.freeze({
  id: "ruleset_2026",
  displayName: "2026 기준 규칙셋",
  innings: 9,
  regularSeasonAutomaticRunnerInExtras: true,
  roster: {
    active: 26
  },
  ratingScale: {
    min: 20,
    max: 99,
    mlbAverageReference: 50
  },
  // 계약/서비스타임/포스트시즌 등 세부 수치는 구현 시 최신 검증 후 확정.
  serviceTime: {
    daysPerYear: 172
  }
});

export { ruleset2026 };
