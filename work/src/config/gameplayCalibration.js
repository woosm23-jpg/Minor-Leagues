const gameplayCalibration = Object.freeze({
  id: "phase1_gameplay_calibration_v3",
  referenceSeason: 2025,
  neutralRunsPerTeamGame: 4.45,
  runnerAdvancement: Object.freeze({
    groundBallDoublePlayProbabilityByOuts: Object.freeze([0.34, 0.39, 0]),
    groundOutFromThirdScoreByOuts: Object.freeze([0.28, 0.34, 0]),
    groundOutFromSecondToThirdByOuts: Object.freeze([0.46, 0.54, 0]),
    groundOutFromFirstToSecondByOuts: Object.freeze([0.44, 0.50, 0])
  }),
  stealing: Object.freeze({
    // 2025 MLB baseline: 3,440 SB + 989 CS = 4,429 attempts; 77.67% success.
    // Attempt probabilities are per clean steal opportunity before a PA and are
    // calibrated again at the complete-game level rather than copied directly.
    targets: Object.freeze({
      second: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.091, 0.103, 0.072]),
        neutralSuccessProbability: 0.777,
        neutralPickoffOutProbability: 0.0024
      }),
      third: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.021, 0.028, 0.014]),
        neutralSuccessProbability: 0.805,
        neutralPickoffOutProbability: 0.0016
      })
    }),
    execution: Object.freeze({
      stealingLogitScale: 0.42,
      speedLogitScale: 0.30,
      baserunningLogitScale: 0.08,
      holdRunnerLogitScale: 0.24,
      catcherLogitScale: 0.30
    }),
    decision: Object.freeze({
      stealingAggressionLogitScale: 0.72,
      speedAwarenessLogitScale: 0.12,
      opportunityQualityLogitScale: 5.0,
      baserunningSharpnessScale: 0.24,
      holdDeterrenceLogitScale: 0.12,
      catcherDeterrenceLogitScale: 0.10
    }),
    pickoff: Object.freeze({
      holdRunnerLogitScale: 0.55,
      baserunningLogitScale: 0.26,
      leadAggressionLogitScale: 0.12
    })
  }),
  detailedBaserunning: Object.freeze({
    // 2025 MLB Baseball-Reference aggregate advancement anchors:
    // 1st->3rd on 1B ~32%, 1st->home on 2B ~39%, 2nd->home on 1B ~60%, XBT ~42%.
    outfieldBoundaryDegrees: 15,
    angleLogitScale: 0.16,
    decision: Object.freeze({
      opportunityQualityLogitScale: 7.0,
      baserunningSharpnessScale: 0.28,
      speedAwarenessLogitScale: 0.05
    }),
    execution: Object.freeze({
      speedLogitScale: 0.36,
      baserunningRouteLogitScale: 0.08,
      armStrengthLogitScale: 0.24,
      armAccuracyLogitScale: 0.16
    }),
    opportunities: Object.freeze({
      FIRST_THIRD_SINGLE: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.209, 0.272, 0.435]),
        neutralSuccessProbability: 0.965,
        referenceDistanceFt: 205,
        distanceScaleFt: 75,
        depthSuccessLogitScale: 0.42
      }),
      SECOND_HOME_SINGLE: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.468, 0.559, 0.771]),
        neutralSuccessProbability: 0.943,
        referenceDistanceFt: 210,
        distanceScaleFt: 75,
        depthSuccessLogitScale: 0.46
      }),
      FIRST_HOME_DOUBLE: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.259, 0.320, 0.484]),
        neutralSuccessProbability: 0.929,
        referenceDistanceFt: 300,
        distanceScaleFt: 70,
        depthSuccessLogitScale: 0.42
      }),
      TAG_HOME: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.78, 0.82, 0]),
        neutralSuccessProbability: 0.955,
        referenceDistanceFt: 285,
        distanceScaleFt: 60,
        depthSuccessLogitScale: 0.58
      }),
      TAG_SECOND_THIRD: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.22, 0.30, 0]),
        neutralSuccessProbability: 0.965,
        referenceDistanceFt: 290,
        distanceScaleFt: 60,
        depthSuccessLogitScale: 0.46
      }),
      TAG_FIRST_SECOND: Object.freeze({
        neutralAttemptProbabilityByOuts: Object.freeze([0.08, 0.12, 0]),
        neutralSuccessProbability: 0.970,
        referenceDistanceFt: 300,
        distanceScaleFt: 60,
        depthSuccessLogitScale: 0.38
      })
    }),
    tagUp: Object.freeze({ minProjectedDistanceFt: 210 })
  })
});

export { gameplayCalibration };
