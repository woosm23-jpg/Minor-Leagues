const organizationCalibration = Object.freeze({
  id: "phase3_high_a_ladder_v29",
  reviewCadenceDays: 7,
  minimumAaaGames: 4,
  minimumAaaPA: 12,
  minimumMlbGames: 6,
  minimumMlbPA: 20,
  transactionCooldownDays: 14,
  promotionMargin: 1.5,
  readiness: Object.freeze({ mlbReadyDepthScore: 63, nearDepthScore: 59 }),
  path: Object.freeze({ blockedGap: 4, competitiveGap: 1.5 }),
  performance: Object.freeze({
    referenceOPS: 0.720,
    opsScale: 6.0,
    maxAdjustment: 2.4,
    aaaReliabilityPA: 48,
    mlbReliabilityPA: 60,
    notableAdjustment: 0.65
  }),
  roleMomentumScale: 0.9,
  incumbentMomentumScale: 0.45,
  fatiguePenaltyAt100: 1.5,
  incumbentRoleBonus: Object.freeze({ STARTER: 1.5, PLATOON: 0.9, ROTATION: 0.5, BENCH: 0.15, UTILITY: 0.35 }),
  rosterNeed: Object.freeze({ weakIncumbentScore: 65, scale: 0.35, maxBonus: 2.0 }),
  ladder: Object.freeze({
    adjacentPairs: Object.freeze([
      Object.freeze({ fromLevel: "A", toLevel: "HIGH_A" }),
      Object.freeze({ fromLevel: "HIGH_A", toLevel: "AA" }),
      Object.freeze({ fromLevel: "AA", toLevel: "AAA" })
    ]),
    promotionMargin: Object.freeze({ "A_HIGH_A": 2.15, "HIGH_A_AA": 2.0, "AA_AAA": 1.7 }),
    readyDepthScore: Object.freeze({ HIGH_A: 45, AA: 49, AAA: 55 }),
    nearDepthScore: Object.freeze({ HIGH_A: 41, AA: 45, AAA: 51 }),
    incumbentRoleBonus: 0.65,
    performanceWeight: 0.85,
    upperPerformanceWeight: 0.55,
    roleMomentumScale: 0.55,
    fatiguePenaltyAt100: 1.2,
    weakIncumbentScore: Object.freeze({ HIGH_A: 48, AA: 52, AAA: 58 }),
    needScale: 0.28,
    maxNeedBonus: 1.4,
    pitcherPromotionMargin: Object.freeze({
      "A_HIGH_A_SP": 2.2, "A_HIGH_A_RP": 1.75,
      "HIGH_A_AA_SP": 2.05, "HIGH_A_AA_RP": 1.60,
      "AA_AAA_SP": 1.8, "AA_AAA_RP": 1.40
    }),
    pitcherIncumbentRoleBonus: Object.freeze({ SP: 0.85, RP: 0.45 }),
    pitcherPerformanceWeight: 0.80,
    pitcherUpperPerformanceWeight: 0.50
  }),
  pitcher: Object.freeze({
    readiness: Object.freeze({ mlbReadyDepthScore: 64, nearDepthScore: 60 }),
    promotionMargin: Object.freeze({ SP: 1.8, RP: 1.25 }),
    incumbentRoleBonus: Object.freeze({ SP: 1.15, RP: 0.65 }),
    fatiguePenaltyAt100: 2.2,
    unavailableFatigue: 72,
    limitedFatigue: 42,
    performance: Object.freeze({
      referenceRA9: 4.45,
      referenceWHIP: 1.30,
      referenceKMinusBB: 0.14,
      ra9Weight: 0.34,
      whipWeight: 1.05,
      kMinusBbWeight: 4.2,
      maxAdjustment: 2.6,
      notableAdjustment: 0.70,
      minAaaBF: Object.freeze({ SP: 32, RP: 14 }),
      minMlbBF: Object.freeze({ SP: 40, RP: 18 }),
      minAaaOuts: Object.freeze({ SP: 21, RP: 6 }),
      minMlbOuts: Object.freeze({ SP: 27, RP: 9 }),
      reliabilityBF: Object.freeze({ AAA_SP: 72, AAA_RP: 36, MLB_SP: 84, MLB_RP: 42 })
    })
  })
});

export { organizationCalibration };
