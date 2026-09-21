import { createGameState } from "../engine/game/gameState.js";
import { createPhase1Hitter, createPhase1Pitcher } from "../engine/player/playerFixtures.js";

function hitter(id, overrides = {}) {
  return createPhase1Hitter({ id, ...overrides });
}

function pitcher(id, overrides = {}) {
  return createPhase1Pitcher({ id, ...overrides });
}

/**
 * Development-only single-game fixture for the first Quick AB UI.
 * It deliberately uses the production Phase 1 GameState/Player shapes so the UI
 * does not own baseball math or a second mock game model.
 */
function createQuickABDemoFixture({ seed = "THE_CALL_UP_QUICK_AB_V1" } = {}) {
  const userPlayerId = "user_001";

  const homeLineup = [
    "home_ss",
    userPlayerId,
    "home_1b",
    "home_dh",
    "home_rf",
    "home_3b",
    "home_2b",
    "home_c",
    "home_lf"
  ];
  const awayLineup = [
    "away_ss",
    "away_cf",
    "away_1b",
    "away_dh",
    "away_rf",
    "away_3b",
    "away_2b",
    "away_c",
    "away_lf"
  ];

  const players = {
    // Home hitters
    home_ss: hitter("home_ss", { bats: "L", contactR: 60, contactL: 52, vision: 62, discipline: 58, speed: 68, baserunning: 64, fielding: 70, reaction: 72, armStrength: 62, armAccuracy: 68 }),
    [userPlayerId]: hitter(userPlayerId, { bats: "R", contactR: 58, contactL: 55, rawPower: 64, vision: 57, discipline: 55, powerUtilizationR: 63, powerUtilizationL: 60, launchTendency: 57, sprayPull: 60, sprayCenter: 52, sprayOppo: 46, speed: 69, stealing: 64, baserunning: 65, fielding: 64, reaction: 66, armStrength: 63, armAccuracy: 61 }),
    home_1b: hitter("home_1b", { bats: "L", contactR: 57, contactL: 50, rawPower: 72, vision: 51, discipline: 60, powerUtilizationR: 70, powerUtilizationL: 66, launchTendency: 65, speed: 34, fielding: 58 }),
    home_dh: hitter("home_dh", { bats: "R", contactR: 55, contactL: 58, rawPower: 76, vision: 48, discipline: 57, powerUtilizationR: 70, powerUtilizationL: 72, launchTendency: 67, speed: 31 }),
    home_rf: hitter("home_rf", { bats: "L", contactR: 55, contactL: 47, rawPower: 61, vision: 54, discipline: 56, speed: 62, fielding: 63, reaction: 62, armStrength: 72, armAccuracy: 66 }),
    home_3b: hitter("home_3b", { bats: "R", contactR: 53, contactL: 56, rawPower: 59, vision: 52, discipline: 51, speed: 46, fielding: 62, reaction: 58, armStrength: 70, armAccuracy: 60 }),
    home_2b: hitter("home_2b", { bats: "S", contactR: 54, contactL: 54, rawPower: 45, vision: 61, discipline: 58, speed: 61, fielding: 68, reaction: 69, armStrength: 54, armAccuracy: 68 }),
    home_c: hitter("home_c", { bats: "R", contactR: 49, contactL: 52, rawPower: 55, vision: 49, discipline: 56, speed: 28, stealing: 25, baserunning: 45, fielding: 68, reaction: 67, armStrength: 75, armAccuracy: 70 }),
    home_lf: hitter("home_lf", { bats: "R", contactR: 51, contactL: 55, rawPower: 57, vision: 53, discipline: 49, speed: 57, fielding: 56, reaction: 55, armStrength: 57, armAccuracy: 55 }),

    // Away hitters
    away_ss: hitter("away_ss", { bats: "R", contactR: 58, contactL: 60, vision: 63, discipline: 57, speed: 66, baserunning: 65, fielding: 72, reaction: 73, armStrength: 65, armAccuracy: 69 }),
    away_cf: hitter("away_cf", { bats: "L", contactR: 61, contactL: 49, rawPower: 58, vision: 60, discipline: 61, speed: 73, stealing: 70, baserunning: 70, fielding: 71, reaction: 74, armStrength: 62, armAccuracy: 64 }),
    away_1b: hitter("away_1b", { bats: "L", contactR: 55, contactL: 48, rawPower: 74, vision: 50, discipline: 60, powerUtilizationR: 71, powerUtilizationL: 65, launchTendency: 66, speed: 30, fielding: 60 }),
    away_dh: hitter("away_dh", { bats: "R", contactR: 54, contactL: 57, rawPower: 73, vision: 50, discipline: 54, launchTendency: 64, speed: 35 }),
    away_rf: hitter("away_rf", { bats: "R", contactR: 57, contactL: 59, rawPower: 64, vision: 55, discipline: 52, speed: 58, fielding: 64, reaction: 62, armStrength: 74, armAccuracy: 67 }),
    away_3b: hitter("away_3b", { bats: "L", contactR: 52, contactL: 46, rawPower: 60, vision: 55, discipline: 62, speed: 45, fielding: 61, reaction: 59, armStrength: 69, armAccuracy: 61 }),
    away_2b: hitter("away_2b", { bats: "R", contactR: 53, contactL: 56, rawPower: 43, vision: 62, discipline: 55, speed: 64, fielding: 69, reaction: 70, armStrength: 55, armAccuracy: 68 }),
    away_c: hitter("away_c", { bats: "R", contactR: 48, contactL: 51, rawPower: 57, vision: 50, discipline: 55, speed: 27, stealing: 24, baserunning: 43, fielding: 70, reaction: 69, armStrength: 77, armAccuracy: 72 }),
    away_lf: hitter("away_lf", { bats: "S", contactR: 51, contactL: 52, rawPower: 52, vision: 57, discipline: 53, speed: 59, fielding: 57, reaction: 57, armStrength: 56, armAccuracy: 57 }),

    // Pitching staffs
    home_sp: pitcher("home_sp", { throws: "R", control: 60, command: 59, movement: 61, pitchability: 61, stuff: 63, pitchVelocityMph: 94.8, stamina: 61, holdRunner: 58, fielding: 58, reaction: 57 }),
    home_rp1: pitcher("home_rp1", { throws: "R", control: 57, command: 58, movement: 64, pitchability: 58, stuff: 68, pitchVelocityMph: 96.1, stamina: 40, role: "RP", holdRunner: 55 }),
    home_rp2: pitcher("home_rp2", { throws: "L", control: 54, command: 56, movement: 67, pitchability: 57, stuff: 66, pitchVelocityMph: 94.1, stamina: 38, role: "RP", holdRunner: 61 }),
    home_rp3: pitcher("home_rp3", { throws: "R", control: 62, command: 63, movement: 61, pitchability: 64, stuff: 70, pitchVelocityMph: 96.8, stamina: 37, role: "CL", holdRunner: 58 }),
    away_sp: pitcher("away_sp", { throws: "L", control: 58, command: 61, movement: 63, pitchability: 62, stuff: 65, pitchVelocityMph: 93.9, stamina: 63, holdRunner: 60, fielding: 55, reaction: 56 }),
    away_rp1: pitcher("away_rp1", { throws: "R", control: 55, command: 57, movement: 65, pitchability: 59, stuff: 67, pitchVelocityMph: 95.7, stamina: 40, role: "RP", holdRunner: 53 }),
    away_rp2: pitcher("away_rp2", { throws: "L", control: 59, command: 60, movement: 62, pitchability: 61, stuff: 66, pitchVelocityMph: 94.4, stamina: 39, role: "RP", holdRunner: 62 }),
    away_rp3: pitcher("away_rp3", { throws: "R", control: 61, command: 62, movement: 64, pitchability: 63, stuff: 71, pitchVelocityMph: 97.0, stamina: 36, role: "CL", holdRunner: 57 })
  };

  const homeDefense = {
    C: "home_c", "1B": "home_1b", "2B": "home_2b", "3B": "home_3b", SS: "home_ss",
    LF: "home_lf", CF: userPlayerId, RF: "home_rf"
  };
  const awayDefense = {
    C: "away_c", "1B": "away_1b", "2B": "away_2b", "3B": "away_3b", SS: "away_ss",
    LF: "away_lf", CF: "away_cf", RF: "away_rf"
  };

  const initialState = createGameState({
    gameId: `quick_ab_${seed}`,
    awayLineup,
    homeLineup,
    awayPitcherId: "away_sp",
    homePitcherId: "home_sp",
    awayDefense,
    homeDefense
  });

  const pitchingPlans = {
    away: { starterId: "away_sp", bullpenIds: ["away_rp1", "away_rp2", "away_rp3"] },
    home: { starterId: "home_sp", bullpenIds: ["home_rp1", "home_rp2", "home_rp3"] }
  };

  const names = {
    [userPlayerId]: "강민준",
    home_ss: "박도윤", home_1b: "이준호", home_dh: "최태성", home_rf: "정우진", home_3b: "김현수", home_2b: "윤재민", home_c: "오민석", home_lf: "서지훈",
    away_ss: "M. Carter", away_cf: "J. Rivera", away_1b: "L. Brooks", away_dh: "T. Evans", away_rf: "D. Walker", away_3b: "A. Flores", away_2b: "N. Reed", away_c: "C. Price", away_lf: "R. Young",
    home_sp: "한지훈", home_rp1: "문태규", home_rp2: "임성호", home_rp3: "백승민",
    away_sp: "E. Ramirez", away_rp1: "K. Thompson", away_rp2: "S. Miller", away_rp3: "B. Cole"
  };

  return Object.freeze({
    seed,
    userPlayerId,
    userTeam: "home",
    teams: Object.freeze({
      away: Object.freeze({ id: "away", name: "레드 폭스", shortName: "FOX" }),
      home: Object.freeze({ id: "home", name: "콜업 블루", shortName: "BLU" })
    }),
    players: Object.freeze(players),
    names: Object.freeze(names),
    pitchingPlans: Object.freeze({ away: Object.freeze(pitchingPlans.away), home: Object.freeze(pitchingPlans.home) }),
    initialState
  });
}

export { createQuickABDemoFixture };
