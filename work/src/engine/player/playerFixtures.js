/**
 * Development-only Player builders used by Phase 1 tests/calibration.
 * Production player creation/import will live elsewhere.
 */
function createPhase1Hitter({
  id,
  bats = "R",
  throws = "R",
  contactR = 50,
  contactL = 50,
  rawPower = 50,
  vision = 50,
  discipline = 50,
  powerUtilizationR = 50,
  powerUtilizationL = 50,
  launchTendency = 50,
  sprayPull = 50,
  sprayCenter = 50,
  sprayOppo = 50,
  speed = 50,
  stealing = 50,
  baserunning = 50,
  fielding = 50,
  reaction = 50,
  armStrength = 50,
  armAccuracy = 50,
  ovr = 50,
  holdRunner = 50,
  primaryPosition = "DH",
  secondaryPositions = {},
  adaptability = 50
}) {
  return Object.freeze({
    id,
    bats,
    throws,
    ovr,
    hitting: Object.freeze({ contactR, contactL, rawPower, vision, discipline }),
    tendencies: Object.freeze({
      powerUtilizationR,
      powerUtilizationL,
      launchTendency,
      sprayPull,
      sprayCenter,
      sprayOppo
    }),
    fielding: Object.freeze({ fielding, reaction, armStrength, armAccuracy }),
    running: Object.freeze({ speed, stealing, baserunning }),
    positioning: Object.freeze({
      primaryPosition,
      familiarity: Object.freeze({ [primaryPosition]: 1, ...secondaryPositions }),
      adaptability
    }),
    pitching: Object.freeze({ control: 50, command: 50, movement: 50, pitchability: 50, stamina: 20, role: "RP", holdRunner }),
    derived: Object.freeze({ stuff: 50 })
  });
}

function createPhase1Pitcher({
  id,
  throws = "R",
  control = 50,
  command = 50,
  movement = 50,
  pitchability = 50,
  stuff = 50,
  pitchVelocityMph = null,
  stamina = 50,
  role = "SP",
  speed = 35,
  fielding = 50,
  reaction = 50,
  armStrength = 55,
  armAccuracy = 50,
  ovr = 50,
  holdRunner = 50
}) {
  return Object.freeze({
    id,
    bats: "R",
    throws,
    ovr,
    hitting: Object.freeze({
      contactR: 20,
      contactL: 20,
      rawPower: 20,
      vision: 20,
      discipline: 20
    }),
    tendencies: Object.freeze({
      powerUtilizationR: 20,
      powerUtilizationL: 20,
      launchTendency: 50,
      sprayPull: 50,
      sprayCenter: 50,
      sprayOppo: 50
    }),
    fielding: Object.freeze({ fielding, reaction, armStrength, armAccuracy }),
    running: Object.freeze({ speed, stealing: 20, baserunning: 30 }),
    pitching: Object.freeze({ control, command, movement, pitchability, pitchVelocityMph, stamina, role, holdRunner }),
    derived: Object.freeze({ stuff })
  });
}

export { createPhase1Hitter, createPhase1Pitcher };
