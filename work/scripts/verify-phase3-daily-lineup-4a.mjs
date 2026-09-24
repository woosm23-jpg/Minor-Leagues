import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createPhase1Hitter
} from "../src/engine/player/playerFixtures.js";
import {
  buildDailyLineup
} from "../src/engine/season/lineupRestAI.js";
import {
  createSeasonGameFixture
} from "../src/services/demoSeasonFactory.js";
import { seasonApi } from "../src/api/seasonApi.js";

const DIR =
  path.dirname(
    fileURLToPath(import.meta.url)
  );
const ROOT =
  path.resolve(DIR, "..");

const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(
        path.resolve(ROOT, SNAP)
      )
    ).toString("utf8")
  );
}

function hitter(
  id,
  position,
  overrides = {}
) {
  return createPhase1Hitter({
    id,
    bats:
      overrides.bats ?? "R",
    throws: "R",
    contactR:
      overrides.contactR ?? 55,
    contactL:
      overrides.contactL ?? 55,
    rawPower:
      overrides.rawPower ?? 55,
    vision:
      overrides.vision ?? 55,
    discipline:
      overrides.discipline ?? 55,
    powerUtilizationR:
      overrides.powerUtilizationR ??
      55,
    powerUtilizationL:
      overrides.powerUtilizationL ??
      55,
    speed:
      overrides.speed ?? 55,
    fielding:
      overrides.fielding ?? 55,
    reaction:
      overrides.reaction ?? 55,
    armStrength:
      overrides.armStrength ?? 55,
    armAccuracy:
      overrides.armAccuracy ?? 55,
    primaryPosition: position,
    secondaryPositions:
      overrides.secondaryPositions ??
      {},
    adaptability: 55
  });
}

function syntheticRoster() {
  const positions = [
    "C",
    "1B",
    "2B",
    "3B",
    "SS",
    "LF",
    "CF",
    "RF",
    "DH"
  ];

  const players = {};
  const lineupSlots = [];
  const lineup = [];

  for (const position of positions) {
    const id =
      `starter_${position}`;

    const overrides =
      position === "RF"
        ? {
            contactR: 28,
            contactL: 86,
            powerUtilizationR: 30,
            powerUtilizationL: 82,
            rawPower: 58
          }
        : {};

    players[id] =
      hitter(
        id,
        position,
        overrides
      );

    lineupSlots.push({
      position,
      starterId: id
    });
    lineup.push(id);
  }

  players.bench_rf =
    hitter(
      "bench_rf",
      "RF",
      {
        bats: "L",
        contactR: 88,
        contactL: 24,
        powerUtilizationR: 84,
        powerUtilizationL: 26,
        rawPower: 58
      }
    );

  return {
    team: {
      id: "SYN",
      name: "Synthetic"
    },
    players,
    names:
      Object.fromEntries(
        Object.keys(players).map(
          (id) => [id, id]
        )
      ),
    lineup,
    lineupSlots,
    defense:
      Object.fromEntries(
        positions
          .filter(
            (position) =>
              position !== "DH"
          )
          .map(
            (position) => [
              position,
              `starter_${position}`
            ]
          )
      ),
    bench: [
      {
        playerId: "bench_rf",
        coverage: [
          "RF",
          "DH"
        ]
      }
    ],
    positionPlayers: [
      ...lineup,
      "bench_rf"
    ]
  };
}

function careerInput(orgId) {
  return {
    name: "Daily Lineup QA",
    nationality: "대한민국",
    hometown: "구미",
    age: 18,
    heightCm: 180,
    weightKg: 78,
    bodyType: "ATHLETIC",
    bats: "R",
    throws: "R",
    primaryPosition: "SS",
    archetype: "BALANCED",
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
  const roster =
    syntheticRoster();

  const roleStates = {
    starter_RF: {
      role: "STARTER",
      momentum: 0
    },
    bench_rf: {
      role: "PLATOON",
      momentum: 0
    }
  };

  const vsRight =
    buildDailyLineup(
      roster,
      {},
      roleStates,
      {
        opposingPitcher: {
          throws: "R"
        }
      }
    );

  assert.ok(
    vsRight.lineup.includes(
      "bench_rf"
    )
  );
  assert.ok(
    !vsRight.lineup.includes(
      "starter_RF"
    )
  );
  assert.ok(
    vsRight.bench.some(
      (row) =>
        row.playerId ===
        "starter_RF"
    )
  );
  assert.ok(
    vsRight.competitionDecisions
      .some(
        (row) =>
          row.playerId ===
            "bench_rf" &&
          row.forPlayerId ===
            "starter_RF" &&
          row.position === "RF" &&
          row.reasons.includes(
            "PLATOON_EDGE"
          )
      )
  );

  const vsRightAgain =
    buildDailyLineup(
      roster,
      {},
      roleStates,
      {
        opposingPitcher: {
          throws: "R"
        }
      }
    );

  assert.deepEqual(
    vsRight,
    vsRightAgain
  );

  const vsLeft =
    buildDailyLineup(
      roster,
      {},
      roleStates,
      {
        opposingPitcher: {
          throws: "L"
        }
      }
    );

  assert.ok(
    vsLeft.lineup.includes(
      "starter_RF"
    )
  );
  assert.ok(
    !vsLeft.lineup.includes(
      "bench_rf"
    )
  );

  const snapshot =
    readSnapshot();

  const catalog =
    seasonApi
      .getCareerCreationCatalog({
        masterSnapshot:
          snapshot
      });

  const created =
    seasonApi.createCareerSeason({
      seed:
        "phase3-4a-daily-lineup",
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
    seasonApi.serializeSeason(
      created.seasonId
    );

  let checkedGames = 0;
  let competitionGames = 0;
  let competitionMoves = 0;

  for (
    const level of
    ["MLB", "AAA"]
  ) {
    const league =
      payload.fixture
        .levelLeagues[level];

    for (
      const game of
      league.schedule.slice(
        0,
        80
      )
    ) {
      const fixture =
        createSeasonGameFixture({
          seasonFixture:
            payload.fixture,
          scheduleGame: game,
          playerStates:
            payload.playerStates ??
            {},
          pitcherStates:
            payload.pitcherStates ??
            {},
          roleStates:
            payload.roleStates ??
            {},
          level
        });

      for (
        const side of
        ["away", "home"]
      ) {
        const daily =
          fixture.dailyLineups[
            side
          ];

        assert.equal(
          daily.lineup.length,
          9
        );
        assert.equal(
          new Set(
            daily.lineup
          ).size,
          9
        );

        const benchIds =
          new Set(
            (
              daily.bench ?? []
            ).map(
              (row) =>
                row.playerId
            )
          );

        for (
          const id of
          daily.lineup
        ) {
          assert.ok(
            !benchIds.has(id)
          );
          assert.ok(
            fixture.players[id]
          );
        }

        if (
          daily
            .competitionDecisions
            .length > 0
        ) {
          competitionGames += 1;
          competitionMoves +=
            daily
              .competitionDecisions
              .length;
        }
      }

      checkedGames += 1;
    }
  }

  assert.ok(
    checkedGames >= 100
  );

  const report = {
    schema:
      "THE_CALL_UP_PHASE3_DAILY_LINEUP_4A_V1",
    pass: true,
    snapshotHash:
      snapshot.metadata.contentHash,
    policy: {
      injuryAvailability:
        "AUTHORITATIVE",
      fatigueRest:
        "EXISTING_PATH_PRESERVED",
      dailyCompetitionInputs: [
        "CURRENT_ABILITY",
        "OPPONENT_STARTER_HAND",
        "DEFENSIVE_FIT",
        "PERSISTENT_ROLE",
        "FORM",
        "FATIGUE"
      ],
      hiddenPotentialUsed:
        false,
      battingOrder:
        "DEFERRED_TO_4B"
    },
    synthetic: {
      vsRightStarter:
        vsRight.lineup.find(
          (id) =>
            id === "bench_rf" ||
            id === "starter_RF"
        ),
      vsLeftStarter:
        vsLeft.lineup.find(
          (id) =>
            id === "bench_rf" ||
            id === "starter_RF"
        ),
      reasons:
        vsRight
          .competitionDecisions[0]
          ?.reasons ?? []
    },
    productionSmoke: {
      checkedGames,
      competitionGames,
      competitionMoves
    }
  };

  const out =
    path.resolve(
      ROOT,
      "reports/phase3-daily-lineup-4a-v1.json"
    );

  fs.mkdirSync(
    path.dirname(out),
    { recursive: true }
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
