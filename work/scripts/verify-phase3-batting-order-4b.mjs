import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  createPhase1Hitter
} from "../src/engine/player/playerFixtures.js";
import {
  buildBattingOrder
} from "../src/engine/season/battingOrderAI.js";
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
  overrides = {}
) {
  return createPhase1Hitter({
    id,
    bats:
      overrides.bats ?? "R",
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
    baserunning:
      overrides.baserunning ??
      overrides.speed ??
      55,
    primaryPosition: "DH"
  });
}

function syntheticRoster() {
  const players = {
    lead:
      hitter(
        "lead",
        {
          contactR: 88,
          contactL: 88,
          vision: 88,
          discipline: 90,
          speed: 92,
          baserunning: 90,
          rawPower: 42
        }
      ),
    two:
      hitter(
        "two",
        {
          contactR: 84,
          contactL: 84,
          vision: 86,
          discipline: 87,
          speed: 72,
          rawPower: 56
        }
      ),
    three:
      hitter(
        "three",
        {
          contactR: 79,
          contactL: 79,
          vision: 78,
          discipline: 76,
          rawPower: 79,
          powerUtilizationR: 80,
          powerUtilizationL: 80
        }
      ),
    cleanup:
      hitter(
        "cleanup",
        {
          contactR: 70,
          contactL: 70,
          vision: 68,
          discipline: 72,
          rawPower: 96,
          powerUtilizationR: 95,
          powerUtilizationL: 95,
          speed: 38
        }
      ),
    five:
      hitter(
        "five",
        {
          contactR: 73,
          contactL: 73,
          vision: 70,
          discipline: 68,
          rawPower: 86,
          powerUtilizationR: 84,
          powerUtilizationL: 84
        }
      ),
    six:
      hitter(
        "six",
        {
          contactR: 66,
          contactL: 66,
          rawPower: 69,
          vision: 65,
          discipline: 64
        }
      ),
    seven:
      hitter(
        "seven",
        {
          contactR: 60,
          contactL: 60,
          rawPower: 62,
          vision: 61,
          discipline: 60
        }
      ),
    eight:
      hitter(
        "eight",
        {
          contactR: 54,
          contactL: 54,
          rawPower: 52,
          vision: 55,
          discipline: 54
        }
      ),
    split:
      hitter(
        "split",
        {
          bats: "L",
          contactR: 82,
          contactL: 35,
          vision: 63,
          discipline: 64,
          rawPower: 61,
          powerUtilizationR: 82,
          powerUtilizationL: 35,
          speed: 68
        }
      )
  };

  return {
    players,
    lineup: [
      "eight",
      "seven",
      "six",
      "five",
      "cleanup",
      "three",
      "two",
      "lead",
      "split"
    ]
  };
}

function careerInput(orgId) {
  return {
    name: "Batting Order QA",
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

  const vsRight =
    buildBattingOrder({
      playerIds:
        roster.lineup,
      roster,
      opposingPitcher: {
        throws: "R"
      },
      baselineOrder:
        roster.lineup
    });

  assert.equal(
    vsRight.lineup[0],
    "lead"
  );
  assert.equal(
    vsRight.lineup[3],
    "cleanup"
  );

  const vsLeft =
    buildBattingOrder({
      playerIds:
        roster.lineup,
      roster,
      opposingPitcher: {
        throws: "L"
      },
      baselineOrder:
        roster.lineup
    });

  assert.notDeepEqual(
    vsRight.lineup,
    vsLeft.lineup
  );

  assert.deepEqual(
    new Set(vsRight.lineup),
    new Set(roster.lineup)
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
        "phase3-4b-batting-order",
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
  let reorderedSides = 0;
  let rightHandedSides = 0;
  let leftHandedSides = 0;

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

        assert.equal(
          daily.battingOrder
            ?.optimized,
          true
        );

        const opponentSide =
          side === "away"
            ? "home"
            : "away";

        const opponentStarterId =
          fixture
            .pitchingPlans[
              opponentSide
            ]
            .starterId;

        const hand =
          fixture.players[
            opponentStarterId
          ]?.throws;

        if (hand === "L") {
          leftHandedSides += 1;
        } else if (hand === "R") {
          rightHandedSides += 1;
        }

        assert.deepEqual(
          new Set(
            daily.lineup
          ),
          new Set(
            daily.selectedPlayers
          )
        );

        if (
          daily.selectedPlayers.some(
            (id, index) =>
              daily.lineup[index] !==
              id
          )
        ) {
          reorderedSides += 1;
        }
      }

      checkedGames += 1;
    }
  }

  assert.ok(
    checkedGames >= 100
  );
  assert.ok(
    reorderedSides > 0
  );
  assert.ok(
    rightHandedSides > 0
  );
  assert.ok(
    leftHandedSides > 0
  );

  const report = {
    schema:
      "THE_CALL_UP_PHASE3_BATTING_ORDER_4B_V1",
    pass: true,
    snapshotHash:
      snapshot.metadata.contentHash,
    policy: {
      selectedNinePreserved:
        true,
      hiddenPotentialUsed:
        false,
      inputs: [
        "CONTACT_SPLIT",
        "VISION",
        "DISCIPLINE",
        "RAW_POWER",
        "POWER_UTILIZATION_SPLIT",
        "SPEED",
        "BASERUNNING",
        "OPPONENT_STARTER_HAND"
      ]
    },
    synthetic: {
      vsRight:
        vsRight.lineup,
      vsLeft:
        vsLeft.lineup
    },
    productionSmoke: {
      checkedGames,
      reorderedSides,
      rightHandedSides,
      leftHandedSides
    }
  };

  const out =
    path.resolve(
      ROOT,
      "reports/phase3-batting-order-4b-v1.json"
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
