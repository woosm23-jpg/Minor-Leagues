const pitchingCalibration = Object.freeze({
  id: "phase1_pitching_calibration_v1",
  referenceSeason: 2025,
  targetPitchesPerPA: 3.88,
  targetStarterPitchesPerGame: 85,
  targetStarterInningsPerGame: 5.2,
  targetPitchersUsedPerTeamGame: 4.29,
  targetCompleteGameRate: 29 / 4860,
  pitchCountByPAOutcome: Object.freeze({
    BIP: Object.freeze({
      values: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
      probabilities: Object.freeze([0.09, 0.18, 0.26, 0.25, 0.13, 0.06, 0.03])
    }),
    K: Object.freeze({
      values: Object.freeze([3, 4, 5, 6, 7, 8]),
      probabilities: Object.freeze([0.26, 0.28, 0.21, 0.13, 0.08, 0.04])
    }),
    BB: Object.freeze({
      values: Object.freeze([4, 5, 6, 7, 8, 9]),
      probabilities: Object.freeze([0.29, 0.27, 0.20, 0.12, 0.07, 0.05])
    }),
    HBP: Object.freeze({
      values: Object.freeze([1, 2, 3, 4, 5]),
      probabilities: Object.freeze([0.30, 0.27, 0.21, 0.14, 0.08])
    })
  }),
  fatigue: Object.freeze({
    starterCapacityPitchesAt50Stamina: 100,
    starterCapacityPitchesPerLatent: 12,
    relieverCapacityPitchesAt50Stamina: 30,
    relieverCapacityPitchesPerLatent: 5,
    commandPenaltyAt100: 8,
    movementPenaltyAt100: 7,
    stuffPenaltyAt100: 9,
    velocityPenaltyMphAt100: 2.2,
    relieverEffortVelocityBonusMph: 0.7,
    relieverEffortStuffBonus: 2
  }),
  usage: Object.freeze({
    starterSoftLimitAt50Stamina: 85,
    starterSoftLimitPerLatent: 9,
    relieverSoftLimitAt50Stamina: 20,
    relieverSoftLimitPerLatent: 3,
    starterEmergencyRunThreshold: 6,
    starterEmergencyMinimumPitches: 55,
    starterMinimumPitchesBeforeFatigueHook: 68,
    starterFinishGameLimitAt50Stamina: 105,
    starterFinishGameLimitPerLatent: 8,
    starterFinishGameMaxRuns: 3,
    relieverMinimumBatters: 3,
    highFatigueThreshold: 82
  })
});

export { pitchingCalibration };
