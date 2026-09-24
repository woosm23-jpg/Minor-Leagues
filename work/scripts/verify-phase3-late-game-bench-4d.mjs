import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import {
  fileURLToPath
} from "node:url";
import {
  createPhase1Hitter,
  createPhase1Pitcher
} from "../src/engine/player/playerFixtures.js";
import {
  createLateGameBenchManager,
  classifyBenchRoles
} from "../src/engine/game/benchUsageAI.js";
import {
  createSeasonGameFixture
} from "../src/services/demoSeasonFactory.js";
import {
  simulateSeasonFixtureGame
} from "../src/services/seasonGameService.js";
import {
  seasonApi
} from "../src/api/seasonApi.js";

const ROOT =
  path.resolve(
    path.dirname(
      fileURLToPath(
        import.meta.url
      )
    ),
    ".."
  );

const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(
        path.resolve(
          ROOT,
          SNAP
        )
      )
    ).toString("utf8")
  );
}

function hitter(
  id,
  position,
  o = {}
) {
  return createPhase1Hitter({
    id,
    bats:
      o.bats ?? "R",
    contactR:
      o.contactR ?? 50,
    contactL:
      o.contactL ?? 50,
    rawPower:
      Math.max(
        o.powerR ?? 50,
        o.powerL ?? 50
      ),
    vision: 55,
    discipline: 55,
    powerUtilizationR:
      o.powerR ?? 50,
    powerUtilizationL:
      o.powerL ?? 50,
    speed:
      o.speed ?? 50,
    baserunning:
      o.baserunning ?? 50,
    fielding:
      o.fielding ?? 50,
    reaction:
      o.reaction ?? 50,
    armStrength:
      o.armStrength ?? 50,
    armAccuracy:
      o.armAccuracy ?? 50,
    primaryPosition:
      position
  });
}

function pitcher(
  id,
  throws = "R"
) {
  return createPhase1Pitcher({
    id,
    throws,
    control: 55,
    command: 55,
    movement: 55,
    pitchability: 55,
    stuff: 55,
    stamina: 60,
    role: "SP"
  });
}

function state({
  awayRuns = 2,
  homeRuns = 3,
  bases = {
    first: null,
    second: null,
    third: null
  },
  awayLineup,
  homeLineup,
  awayDefense,
  homeDefense
}) {
  return {
    status:
      "IN_PROGRESS",
    inning: 9,
    half: "TOP",
    score: {
      away:
        awayRuns,
      home:
        homeRuns
    },
    lineups: {
      away:
        awayLineup,
      home:
        homeLineup
    },
    currentPitcherId: {
      away:
        "away_p",
      home:
        "home_p"
    },
    defensiveAlignment: {
      away:
        awayDefense,
      home:
        homeDefense
    },
    battingOrderIndex: {
      away: 0,
      home: 0
    },
    bases,
    substitutions: [],
    plateAppearances: 60
  };
}

function syntheticChecks() {
  const players = {
    away_p:
      pitcher(
        "away_p",
        "L"
      ),
    home_p:
      pitcher(
        "home_p",
        "R"
      ),

    weak_rf:
      hitter(
        "weak_rf",
        "RF",
        {
          contactR: 35,
          contactL: 60,
          powerR: 38,
          powerL: 60
        }
      ),

    ph_rf:
      hitter(
        "ph_rf",
        "RF",
        {
          bats: "L",
          contactR: 82,
          contactL: 35,
          powerR: 75,
          powerL: 38
        }
      ),

    backup_c:
      hitter(
        "backup_c",
        "C",
        {
          contactR: 95,
          contactL: 95,
          powerR: 95,
          powerL: 95
        }
      ),

    slow_cf:
      hitter(
        "slow_cf",
        "CF",
        {
          speed: 28,
          baserunning: 30
        }
      ),

    speed_cf:
      hitter(
        "speed_cf",
        "CF",
        {
          speed: 94,
          baserunning: 92,
          fielding: 82,
          reaction: 84
        }
      ),

    poor_cf:
      hitter(
        "poor_cf",
        "CF",
        {
          contactR: 68,
          contactL: 68,
          powerR: 68,
          powerL: 68,
          fielding: 40,
          reaction: 40,
          speed: 45
        }
      ),

    def_cf:
      hitter(
        "def_cf",
        "CF",
        {
          contactR: 52,
          contactL: 52,
          powerR: 48,
          powerL: 48,
          fielding: 92,
          reaction: 92,
          speed: 88,
          armAccuracy: 82
        }
      ),

    a1:
      hitter(
        "a1",
        "1B"
      ),

    h1:
      hitter(
        "h1",
        "1B"
      )
  };

  const phPlan = [
    {
      playerId:
        "backup_c",
      coverage:
        ["C"],
      role:
        "BENCH",
      fatigue: 0,
      momentum: 0
    },
    {
      playerId:
        "ph_rf",
      coverage:
        ["RF"],
      role:
        "PLATOON",
      fatigue: 0,
      momentum: 0.1
    }
  ];

  const roles =
    classifyBenchRoles({
      players,
      benchPlan:
        phPlan
    });

  assert.ok(
    roles
      .backup_c
      .includes(
        "BACKUP_CATCHER"
      )
  );

  assert.ok(
    !roles
      .backup_c
      .includes(
        "PINCH_BAT"
      )
  );

  assert.ok(
    roles
      .ph_rf
      .includes(
        "PINCH_BAT"
      )
  );

  assert.ok(
    roles
      .ph_rf
      .includes(
        "PLATOON_BAT"
      )
  );

  const ph =
    createLateGameBenchManager({
      players,
      benchPlans: {
        away:
          phPlan,
        home: []
      }
    })({
      state:
        state({
          awayLineup: [
            "weak_rf",
            "a1"
          ],
          homeLineup: [
            "h1"
          ],
          awayDefense: {
            RF:
              "weak_rf",
            "1B":
              "a1",
            P:
              "away_p"
          },
          homeDefense: {
            "1B":
              "h1",
            P:
              "home_p"
          }
        }),
      battingTeam:
        "away",
      fieldingTeam:
        "home"
    });

  assert.equal(
    ph?.reason,
    "PINCH_HIT"
  );
  assert.equal(
    ph?.inPlayerId,
    "ph_rf"
  );
  assert.ok(
    Number(
      ph
        ?.rationale
        ?.tacticalBonus
    ) > 0
  );

  const pr =
    createLateGameBenchManager({
      players,
      benchPlans: {
        away: [
          {
            playerId:
              "speed_cf",
            coverage:
              ["CF"],
            role:
              "ROTATION",
            fatigue: 0,
            momentum: 0
          }
        ],
        home: []
      }
    })({
      state:
        state({
          awayRuns: 3,
          homeRuns: 3,
          awayLineup: [
            "slow_cf",
            "a1"
          ],
          homeLineup: [
            "h1"
          ],
          awayDefense: {
            CF:
              "slow_cf",
            "1B":
              "a1",
            P:
              "away_p"
          },
          homeDefense: {
            "1B":
              "h1",
            P:
              "home_p"
          },
          bases: {
            first:
              "slow_cf",
            second: null,
            third: null
          }
        }),
      battingTeam:
        "away",
      fieldingTeam:
        "home"
    });

  assert.equal(
    pr?.reason,
    "PINCH_RUN"
  );
  assert.equal(
    pr?.inPlayerId,
    "speed_cf"
  );
  assert.ok(
    Number(
      pr
        ?.rationale
        ?.runningGain
    ) > 0
  );

  const dr =
    createLateGameBenchManager({
      players,
      benchPlans: {
        away: [],
        home: [
          {
            playerId:
              "def_cf",
            coverage:
              ["CF"],
            role:
              "ROTATION",
            fatigue: 0,
            momentum: 0
          }
        ]
      }
    })({
      state:
        state({
          awayRuns: 3,
          homeRuns: 4,
          awayLineup: [
            "a1"
          ],
          homeLineup: [
            "poor_cf",
            "h1"
          ],
          awayDefense: {
            "1B":
              "a1",
            P:
              "away_p"
          },
          homeDefense: {
            CF:
              "poor_cf",
            "1B":
              "h1",
            P:
              "home_p"
          }
        }),
      battingTeam:
        "away",
      fieldingTeam:
        "home"
    });

  assert.equal(
    dr?.reason,
    "DEFENSIVE_REPLACEMENT"
  );
  assert.equal(
    dr?.inPlayerId,
    "def_cf"
  );
  assert.ok(
    Number(
      dr
        ?.rationale
        ?.defenseGain
    ) > 20
  );

  return {
    pinchHit:
      ph,
    pinchRun:
      pr,
    defensiveReplacement:
      dr
  };
}

function careerInput(
  orgId
) {
  return {
    name:
      "Bench AI QA",
    nationality:
      "대한민국",
    hometown:
      "구미",
    age: 18,
    heightCm: 180,
    weightKg: 78,
    bodyType:
      "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition:
      "SS",
    archetype:
      "BALANCED",
    visibleTraits: [
      "QUICK_BAT",
      "SOFT_HANDS"
    ],
    organizationMode:
      "FAVORITE",
    favoriteOrganizationId:
      String(orgId)
  };
}

function main() {
  const synthetic =
    syntheticChecks();

  const snapshot =
    readSnapshot();

  const catalog =
    seasonApi
      .getCareerCreationCatalog({
        masterSnapshot:
          snapshot
      });

  const created =
    seasonApi
      .createCareerSeason({
        seed:
          "phase3-4d-bench-ai-final",
        input:
          careerInput(
            catalog
              .organizations[0]
              .id
          ),
        masterSnapshot:
          snapshot
      });

  const payload =
    seasonApi
      .serializeSeason(
        created.seasonId
      );

  let checkedGames = 0;
  let metadataRows = 0;
  let substitutions = 0;
  const reasons = {
    PINCH_HIT: 0,
    PINCH_RUN: 0,
    DEFENSIVE_REPLACEMENT: 0
  };

  for (
    const level of
    ["MLB", "AAA"]
  ) {
    const league =
      payload.fixture
        .levelLeagues[
          level
        ];

    for (
      const game of
      league.schedule.slice(
        0,
        20
      )
    ) {
      const fixture =
        createSeasonGameFixture({
          seasonFixture:
            payload.fixture,
          scheduleGame:
            game,
          playerStates:
            payload
              .playerStates ??
            {},
          pitcherStates:
            payload
              .pitcherStates ??
            {},
          roleStates:
            payload
              .roleStates ??
            {},
          level
        });

      for (
        const plan of
        Object.values(
          fixture.benchPlans
        )
      ) {
        for (
          const row of
          plan
        ) {
          assert.ok(
            Object.hasOwn(
              row,
              "role"
            )
          );
          assert.ok(
            Object.hasOwn(
              row,
              "momentum"
            )
          );
          assert.ok(
            Object.hasOwn(
              row,
              "fatigue"
            )
          );
          assert.ok(
            Object.hasOwn(
              row,
              "form"
            )
          );

          metadataRows += 1;
        }
      }

      const result =
        simulateSeasonFixtureGame(
          fixture,
          {
            seed:
              `${fixture.seed}:4D-final`,
            mode:
              "FAST"
          }
        );

      for (
        const row of
        result.state
          .substitutions ??
        []
      ) {
        substitutions += 1;

        if (
          Object.hasOwn(
            reasons,
            row.reason
          )
        ) {
          reasons[
            row.reason
          ] += 1;
        }
      }

      checkedGames += 1;
    }
  }

  assert.ok(
    checkedGames >= 40
  );

  assert.ok(
    metadataRows > 100
  );

  const report = {
    schema:
      "THE_CALL_UP_PHASE3_LATE_GAME_BENCH_4D_V2_FINAL",
    pass: true,
    snapshotHash:
      snapshot.metadata
        .contentHash,
    policy: {
      dailyBenchAuthoritative:
        true,
      backupCatcherProtected:
        true,
      persistentRoleUsed:
        true,
      fatigueGate:
        82,
      leverageAwareThresholds:
        true,
      ninthInningDefenseOffenseCostMax:
        16,
      deterministicSyntheticScenarios: [
        "PINCH_HIT",
        "PINCH_RUN",
        "DEFENSIVE_REPLACEMENT"
      ]
    },
    synthetic,
    productionSmoke: {
      checkedGames,
      metadataRows,
      substitutions,
      reasons
    }
  };

  const out =
    path.resolve(
      ROOT,
      "reports/phase3-late-game-bench-4d-v1.json"
    );

  fs.mkdirSync(
    path.dirname(out),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    out,
    JSON.stringify(
      report,
      null,
      2
    ) + "\n"
  );

  process.stdout.write(
    JSON.stringify(
      report,
      null,
      2
    ) + "\n"
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
