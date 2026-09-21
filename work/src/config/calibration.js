const MLB_2025_PA = 182_926;
const MLB_2025_BB = 15_379;
const MLB_2025_HBP = 1_928;
const MLB_2025_SO = 40_645;
const MLB_2025_BIP = 118_676;
const MLB_2025_HR = 5_650;
const MLB_2025_H = 40_138;
const MLB_2025_1B = 26_115;
const MLB_2025_2B = 7_745;
const MLB_2025_3B = 628;
const MLB_2025_STATCAST_BBE = 124_888;
const MLB_2025_AVG_EV_MPH = 89.4;
const MLB_2025_HARD_HIT_RATE = 0.409;
const MLB_2025_AVG_LA_DEGREES = 13.5;
const MLB_2025_GB_RATE = 0.424;
const MLB_2025_FB_RATE = 0.266;
const MLB_2025_LD_RATE = 0.239;
const MLB_2025_PU_RATE = 0.071;
const MLB_2025_LA_SWEET_SPOT_RATE = 0.341;
const MLB_2025_PULL_RATE = 0.392;
const MLB_2025_STRAIGHT_RATE = 0.364;
// Statcast publishes 24.5% Oppo overall, while its rounded GB+AIR cells sum to
// 24.4%. Phase 0 uses the joint GB/AIR directional cells as the internally
// coherent calibration source and records the published 24.5% separately.
const MLB_2025_OPPO_PUBLISHED_RATE = 0.245;
const MLB_2025_OPPO_JOINT_RATE = 0.244;
const MLB_2025_PULL_GB_RATE = 0.210;
const MLB_2025_STRAIGHT_GB_RATE = 0.162;
const MLB_2025_OPPO_GB_RATE = 0.052;
const MLB_2025_PULL_AIR_RATE = 0.182;
const MLB_2025_STRAIGHT_AIR_RATE = 0.202;
const MLB_2025_OPPO_AIR_RATE = 0.192;

// Sacrifice bunts and rare miscellaneous PA are not part of the initial Quick
// AB four-way competition. Normalize only the modeled population so those PA
// are not silently converted into ordinary batted balls. Sacrifice flies are
// already included in Baseball-Reference BIP.
const MLB_2025_MODELED_PA = MLB_2025_BB + MLB_2025_HBP + MLB_2025_SO + MLB_2025_BIP + MLB_2025_HR;

const MLB_2025_CONTACT_BRANCH = MLB_2025_BIP + MLB_2025_HR;

const neutralBattedBallResult = Object.freeze({
  OUT: (MLB_2025_CONTACT_BRANCH - MLB_2025_H) / MLB_2025_CONTACT_BRANCH,
  "1B": MLB_2025_1B / MLB_2025_CONTACT_BRANCH,
  "2B": MLB_2025_2B / MLB_2025_CONTACT_BRANCH,
  "3B": MLB_2025_3B / MLB_2025_CONTACT_BRANCH,
  HR: MLB_2025_HR / MLB_2025_CONTACT_BRANCH
});

const neutralPAOutcome = Object.freeze({
  BB: MLB_2025_BB / MLB_2025_MODELED_PA,
  HBP: MLB_2025_HBP / MLB_2025_MODELED_PA,
  K: MLB_2025_SO / MLB_2025_MODELED_PA,
  // Phase 0 "BIP" means the contact/batted-ball branch. HR is intentionally
  // folded into this branch and must emerge later from EV/LA/spray/park.
  BIP: (MLB_2025_BIP + MLB_2025_HR) / MLB_2025_MODELED_PA
});

const calibrationConfig = Object.freeze({
  id: "phase0_baseline_v8",
  reference: Object.freeze({
    environment: "MLB 2025 completed regular season",
    battingSource: "Baseball-Reference Major League Batting Year-by-Year Averages",
    battingSourceUrl: "https://www.baseball-reference.com/leagues/majors/bat.shtml",
    statcastSource: "Baseball Savant League Statcast Stats",
    statcastSourceUrl: "https://baseballsavant.mlb.com/league?season=2025",
    retrievedForProject: "2026-09-18",
    totals: Object.freeze({
      PA: MLB_2025_PA,
      BB: MLB_2025_BB,
      HBP: MLB_2025_HBP,
      SO: MLB_2025_SO,
      BIP: MLB_2025_BIP,
      HR: MLB_2025_HR,
      H: MLB_2025_H,
      "1B": MLB_2025_1B,
      "2B": MLB_2025_2B,
      "3B": MLB_2025_3B,
      modeledPA: MLB_2025_MODELED_PA,
      excludedPA: MLB_2025_PA - MLB_2025_MODELED_PA,
      statcastBBE: MLB_2025_STATCAST_BBE,
      contactBranch: MLB_2025_CONTACT_BRANCH
    }),
    statcast: Object.freeze({
      avgExitVelocityMph: MLB_2025_AVG_EV_MPH,
      hardHitThresholdMph: 95,
      hardHitRate: MLB_2025_HARD_HIT_RATE,
      avgLaunchAngleDegrees: MLB_2025_AVG_LA_DEGREES,
      launchAngleSweetSpotRate: MLB_2025_LA_SWEET_SPOT_RATE,
      battedBallProfile: Object.freeze({
        GB: MLB_2025_GB_RATE,
        LD: MLB_2025_LD_RATE,
        FB: MLB_2025_FB_RATE,
        PU: MLB_2025_PU_RATE
      }),
      sprayProfile: Object.freeze({
        pull: MLB_2025_PULL_RATE,
        straight: MLB_2025_STRAIGHT_RATE,
        oppoPublished: MLB_2025_OPPO_PUBLISHED_RATE,
        oppoFromJointCells: MLB_2025_OPPO_JOINT_RATE,
        jointRates: Object.freeze({
          GB: Object.freeze({
            PULL: MLB_2025_PULL_GB_RATE,
            CENTER: MLB_2025_STRAIGHT_GB_RATE,
            OPPO: MLB_2025_OPPO_GB_RATE
          }),
          AIR: Object.freeze({
            PULL: MLB_2025_PULL_AIR_RATE,
            CENTER: MLB_2025_STRAIGHT_AIR_RATE,
            OPPO: MLB_2025_OPPO_AIR_RATE
          })
        })
      })
    })
  }),
  neutral: Object.freeze({
    hitterRating: 50,
    pitcherRating: 50,
    paOutcome: neutralPAOutcome,
    exitVelocity: Object.freeze({
      averageMph: MLB_2025_AVG_EV_MPH,
      hardHitRate: MLB_2025_HARD_HIT_RATE
    }),
    launchAngle: Object.freeze({
      averageDegrees: MLB_2025_AVG_LA_DEGREES,
      sweetSpotRate: MLB_2025_LA_SWEET_SPOT_RATE,
      typeRates: Object.freeze({
        GB: MLB_2025_GB_RATE,
        LD: MLB_2025_LD_RATE,
        FB: MLB_2025_FB_RATE,
        PU: MLB_2025_PU_RATE
      })
    }),
    battedBallResult: neutralBattedBallResult,
    spray: Object.freeze({
      // Overall rates implied by the rounded Statcast GB/AIR joint cells.
      // These sum exactly to 1.000 and preserve the observed launch/spray
      // correlation instead of forcing spray to be independent of BIP type.
      zoneRates: Object.freeze({
        PULL: MLB_2025_PULL_GB_RATE + MLB_2025_PULL_AIR_RATE,
        CENTER: MLB_2025_STRAIGHT_GB_RATE + MLB_2025_STRAIGHT_AIR_RATE,
        OPPO: MLB_2025_OPPO_GB_RATE + MLB_2025_OPPO_AIR_RATE
      }),
      publishedOverallRates: Object.freeze({
        PULL: MLB_2025_PULL_RATE,
        CENTER: MLB_2025_STRAIGHT_RATE,
        OPPO: MLB_2025_OPPO_PUBLISHED_RATE
      })
    })
  }),
  contactQuality: Object.freeze({
    // Phase 0 v7 coefficients after the 10-tool sensitivity pass. Contact remains
    // the dominant hitter input to BIP quality, while Raw Power stays mostly in
    // the EV ceiling/location stage. Movement/Command are intentionally smaller
    // than v6 so a single pitcher tool cannot create implausibly huge EV swings.
    battleScale: 0.38,
    noiseStdDev: 1.0,
    hitterWeights: Object.freeze({
      contact: 0.36,
      rawPower: 0.05,
      powerUtilization: 0.10
    }),
    pitcherDefenseWeights: Object.freeze({
      movement: 0.32,
      command: 0.14
    }),
    approachMeanAdjustments: Object.freeze({
      BALANCED: 0.00,
      AGGRESSIVE: 0.09,
      CONTACT: -0.10,
      PATIENT: -0.02
    }),
    // At a neutral mean=0 and sd=1 these produce approximately:
    // Poor 12%, Weak 21%, Normal 35%, Solid 24%, Perfect 8%.
    bucketThresholds: Object.freeze({
      poorMax: -1.18,
      weakMax: -0.45,
      normalMax: 0.45,
      solidMax: 1.41
    })
  }),
  exitVelocity: Object.freeze({
    // Neutral shape is fitted as a Phase 0 starting point to the completed 2025
    // MLB Statcast environment: 89.4 mph average EV and 40.9% Hard-Hit rate.
    // The asymmetric Contact Quality transfer is deliberate: mishits lose much
    // more EV than perfect contact can add before the physical ceiling binds.
    neutralContactCenterMph: 93.8,
    contactQualityPositiveMphPerLatent: 7.0,
    contactQualityNegativeMphPerLatent: 18.0,
    residualStdDevMph: 3.2,

    // Raw Power owns most of the physical top-end and therefore Max EV.
    rawPowerMphPerLatent: 1.8,
    powerUtilizationMphPerLatent: 0.9,
    neutralMaxMph: 111.0,
    maxMphPerRawPowerLatent: 4.6,
    globalMinMaxMph: 98.0,
    globalMaxMph: 124.0,
    // Rare events may exceed the hitter soft ceiling, but only a small fraction
    // of the raw overshoot is retained to avoid an unrealistic hard-cap pileup.
    ceilingOvershootRetention: 0.18,

    // Incoming pitch velocity has a small physical transfer effect. Phase 0
    // Quick AB can omit it and use this neutral reference until pitch selection
    // is introduced.
    referencePitchVelocityMph: 93.5,
    incomingPitchVelocityTransfer: 0.12,

    globalMinMph: 20.0,
    hardHitThresholdMph: 95.0
  }),
  launchAngle: Object.freeze({
    // 2025 MLB Statcast reference: 13.5° mean LA, 42.4% GB, 23.9% LD,
    // 26.6% FB, 7.1% PU, and 34.1% in the 8–32° LA sweet spot.
    neutralTypeRates: Object.freeze({
      GB: MLB_2025_GB_RATE,
      LD: MLB_2025_LD_RATE,
      FB: MLB_2025_FB_RATE,
      PU: MLB_2025_PU_RATE
    }),
    sweetSpotDegrees: Object.freeze({ min: 8, max: 32 }),
    tendencyScale: 0.35,
    tendencyLogitLoadings: Object.freeze({
      GB: -0.80,
      LD: -0.05,
      FB: 0.65,
      PU: 0.85
    }),
    approachLogitAdjustments: Object.freeze({
      BALANCED: Object.freeze({ GB: 0.00, LD: 0.00, FB: 0.00, PU: 0.00 }),
      AGGRESSIVE: Object.freeze({ GB: -0.08, LD: 0.00, FB: 0.06, PU: 0.02 }),
      CONTACT: Object.freeze({ GB: 0.07, LD: 0.03, FB: -0.07, PU: -0.03 }),
      PATIENT: Object.freeze({ GB: 0.01, LD: 0.01, FB: -0.01, PU: -0.01 })
    }),
    // Ranges align exactly with MLB's public LA-type guidelines. Triangular
    // modes are calibrated so the neutral mixture also reproduces mean LA and
    // LA Sweet-Spot% without creating threshold spikes.
    typeProfiles: Object.freeze({
      GB: Object.freeze({
        min: -40.0,
        mode: -0.5,
        max: 10.0,
        qualityModeShiftPerLatent: 1.00
      }),
      LD: Object.freeze({
        min: 10.0,
        mode: 17.0,
        max: 25.0,
        qualityModeShiftPerLatent: 0.15
      }),
      FB: Object.freeze({
        min: 25.0,
        mode: 29.0,
        max: 50.0,
        qualityModeShiftPerLatent: -1.20
      }),
      PU: Object.freeze({
        min: 50.000001,
        mode: 58.0,
        max: 80.0,
        qualityModeShiftPerLatent: -0.75
      })
    })
  }),
  spray: Object.freeze({
    // Statcast 2025 joint spray profile. Ground balls are much more pull-heavy
    // than airborne contact, so Phase 0 conditions the baseline spray mix on
    // GB versus AIR (LD/FB/PU) rather than sampling direction independently.
    neutralJointRates: Object.freeze({
      GB: Object.freeze({
        PULL: MLB_2025_PULL_GB_RATE / MLB_2025_GB_RATE,
        CENTER: MLB_2025_STRAIGHT_GB_RATE / MLB_2025_GB_RATE,
        OPPO: MLB_2025_OPPO_GB_RATE / MLB_2025_GB_RATE
      }),
      AIR: Object.freeze({
        PULL: MLB_2025_PULL_AIR_RATE / (1 - MLB_2025_GB_RATE),
        CENTER: MLB_2025_STRAIGHT_AIR_RATE / (1 - MLB_2025_GB_RATE),
        OPPO: MLB_2025_OPPO_AIR_RATE / (1 - MLB_2025_GB_RATE)
      })
    }),
    // Pull/Center/Oppo are style ratings on the same latent transform as other
    // hidden tendencies. All 50s reproduce the league baseline. Their effects
    // are deliberately modest so one tendency cannot collapse a zone to zero.
    tendencyScale: 0.42,
    approachLogitAdjustments: Object.freeze({
      BALANCED: Object.freeze({ PULL: 0.00, CENTER: 0.00, OPPO: 0.00 }),
      AGGRESSIVE: Object.freeze({ PULL: 0.06, CENTER: -0.02, OPPO: -0.04 }),
      CONTACT: Object.freeze({ PULL: -0.05, CENTER: 0.03, OPPO: 0.02 }),
      PATIENT: Object.freeze({ PULL: -0.01, CENTER: 0.01, OPPO: 0.00 })
    }),
    // Internal continuous field geometry. These are game-model sectors, not
    // claimed Statcast public angle cutoffs. Batter-relative + means pull;
    // absolute field-angle - is LF and + is RF.
    zoneProfiles: Object.freeze({
      OPPO: Object.freeze({ min: -45.0, mode: -27.0, max: -15.0 }),
      CENTER: Object.freeze({ min: -15.0, mode: 0.0, max: 15.0 }),
      PULL: Object.freeze({ min: 15.0, mode: 28.0, max: 45.0 })
    })
  }),
  park: Object.freeze({
    neutralPark: Object.freeze({
      id: "neutral_phase0",
      name: "Phase 0 Neutral Park",
      carryFactor: 1.0,
      // Five-point symmetric geometry. Later real parks can replace this with
      // versioned park snapshots without changing the trajectory resolver.
      wallProfile: Object.freeze([
        Object.freeze({ angleDegrees: -45, distanceFt: 330, heightFt: 8 }),
        Object.freeze({ angleDegrees: -22.5, distanceFt: 375, heightFt: 8 }),
        Object.freeze({ angleDegrees: 0, distanceFt: 400, heightFt: 8 }),
        Object.freeze({ angleDegrees: 22.5, distanceFt: 375, heightFt: 8 }),
        Object.freeze({ angleDegrees: 45, distanceFt: 330, heightFt: 8 })
      ])
    }),
    trajectory: Object.freeze({
      // Calibrated Phase 0 carry surrogate. HR still requires deterministic
      // wall clearance from EV + numeric LA + sampled spray angle.
      interceptFt: 54.55,
      feetPerMph: 3.15,
      optimalLaunchAngleDegrees: 28.0,
      anglePenaltyFtPerDegreeSquared: 0.115,
      wallHeightDistanceFactor: 0.72,
      homeRunLaunchAngleMin: 18.0,
      homeRunLaunchAngleMax: 50.0
    })
  }),
  defense: Object.freeze({
    neutralDefense: Object.freeze({
      infieldRange: 50,
      outfieldRange: 50,
      fielding: 50
    }),
    referenceExitVelocityMph: MLB_2025_AVG_EV_MPH,
    rangeWeight: 0.72,
    fieldingWeight: 0.28,
    neutralHitProbabilityByType: Object.freeze({
      GB: 0.232,
      LD: 0.631,
      FB: 0.122,
      PU: 0.017
    }),
    evLogitPer10Mph: Object.freeze({
      GB: 0.24,
      LD: 0.32,
      FB: 0.15,
      PU: 0.08
    }),
    lineAngleLogitBonus: Object.freeze({
      GB: 0.10,
      LD: 0.05,
      FB: 0.08,
      PU: 0.00
    }),
    defenseLogitScale: Object.freeze({
      GB: 0.24,
      LD: 0.18,
      FB: 0.26,
      PU: 0.14
    }),
    hardLineDriveLogitBonus: 0.10,
    weakAirLogitPenalty: 0.18,
    fielderSpecific: Object.freeze({
      // Decompose the calibrated average-fielder out probability into
      // Reach -> clean field -> throw/race stages. At all-50 ratings the
      // product returns to the existing neutral-defense out probability.
      neutralCleanProbabilityByType: Object.freeze({
        GB: 0.985,
        LD: 0.992,
        FB: 0.995,
        PU: 0.993
      }),
      neutralGroundBallThrowProbability: 0.985,
      reachWeightsByType: Object.freeze({
        GB: Object.freeze({ reaction: 0.62, speed: 0.38 }),
        LD: Object.freeze({ reaction: 0.55, speed: 0.45 }),
        FB: Object.freeze({ reaction: 0.42, speed: 0.58 }),
        PU: Object.freeze({ reaction: 0.70, speed: 0.30 })
      }),
      reachLogitScaleByType: Object.freeze({ GB: 0.12, LD: 0.10, FB: 0.14, PU: 0.08 }),
      fieldingLogitScale: 0.10,
      groundBallThrow: Object.freeze({
        armStrengthWeight: 0.42,
        armAccuracyWeight: 0.58,
        armLogitScale: 0.09,
        batterSpeedLogitScale: 0.12
      }),
      // Official-error layer. Phase 0's historical OUT bucket included all
      // non-hit BIP, including reaches on error. Phase 1 partitions a small
      // share of would-be outs into ROE while preserving the calibrated hit
      // probabilities. Neutral values are tuned to the 2025 MLB fielding-error
      // environment (2,451 team errors over 4,860 team-games).
      error: Object.freeze({
        neutralProbabilityOnWouldBeOutByType: Object.freeze({
          GB: 0.049,
          LD: 0.010,
          FB: 0.006,
          PU: 0.012
        }),
        fieldingSkillLogitScale: 0.34,
        armAccuracySkillLogitScale: 0.18,
        routineOpportunityLogitScale: 0.32,
        referenceReachProbability: 0.72,
        groundBallThrowErrorShare: 0.28,
        throwShareAccuracyLogitScale: 0.42
      }),
      // Fair-territory geometry used only to assign the most likely primary
      // fielder. Exact coordinates/positioning arrive in the deeper defense pass.
      geometry: Object.freeze({
        pitcherGroundBallHalfAngle: 4.0,
        thirdBaseBoundary: -27.0,
        shortstopBoundary: -6.0,
        secondBaseBoundary: 16.0,
        outfieldLeftBoundary: -15.0,
        outfieldRightBoundary: 15.0,
        shallowLineDriveFt: 180,
        shallowFlyBallFt: 155,
        catcherPopupFt: 70,
        catcherPopupHalfAngle: 10.0
      })
    }),
    extraBase: Object.freeze({
      depthFloorFt: 150,
      gapCenterDegrees: 22.5,
      gapHalfWidthDegrees: 18,
      centerTripleHalfWidthDegrees: 24,
      doubleDepthBoost: 0.50,
      doubleGapBoost: 0.30,
      tripleDepthBoost: 0.90,
      tripleGapBoost: 0.90,
      tripleCenterBoost: 0.60,
      baseWeightsByType: Object.freeze({
        GB: Object.freeze({ "1B": 0.9728, "2B": 0.0260, "3B": 0.0012 }),
        LD: Object.freeze({ "1B": 0.784, "2B": 0.204, "3B": 0.012 }),
        FB: Object.freeze({ "1B": 0.377, "2B": 0.593, "3B": 0.030 }),
        PU: Object.freeze({ "1B": 0.9518, "2B": 0.0470, "3B": 0.0012 })
      })
    })
  }),
  paOutcome: Object.freeze({
    // Named calibration parameters only. These are starting coefficients for
    // monotonic behavior and will be fitted further during Phase 0 matrices.
    battleScales: Object.freeze({
      walk: 0.42,
      strikeout: 0.36
    }),
    walkDefenseWeights: Object.freeze({
      control: 0.75,
      pitchability: 0.25
    }),
    strikeoutDefenseWeights: Object.freeze({
      vision: 0.85,
      contact: 0.15
    }),
    approachLogitAdjustments: Object.freeze({
      BALANCED: Object.freeze({ BB: 0, HBP: 0, K: 0, BIP: 0 }),
      AGGRESSIVE: Object.freeze({ BB: -0.16, HBP: 0, K: 0.12, BIP: 0.04 }),
      CONTACT: Object.freeze({ BB: -0.03, HBP: 0, K: -0.18, BIP: 0.06 }),
      PATIENT: Object.freeze({ BB: 0.18, HBP: 0, K: 0.08, BIP: -0.06 })
    })
  })
});

export { calibrationConfig };
