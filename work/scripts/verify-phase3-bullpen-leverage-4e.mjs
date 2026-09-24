import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createPhase1Pitcher } from "../src/engine/player/playerFixtures.js";
import {
  classifyBullpenRoles,
  leverageTarget,
  createPitcherUsageManager
} from "../src/engine/game/pitcherUsageAI.js";
import { createSeasonGameFixture } from "../src/services/demoSeasonFactory.js";
import { simulateSeasonFixtureGame } from "../src/services/seasonGameService.js";
import { seasonApi } from "../src/api/seasonApi.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(path.resolve(ROOT, SNAP))
    ).toString("utf8")
  );
}

function makePitcher(id, o = {}) {
  return createPhase1Pitcher({
    id,
    role: o.role ?? "RP",
    stuff: o.stuff ?? 60,
    command: o.command ?? 60,
    movement: o.movement ?? 60,
    pitchability: o.pitchability ?? 60,
    control: o.control ?? 60,
    stamina: o.stamina ?? 45,
    pitchVelocityMph:
      (o.role ?? "RP") === "SP" ? 93 : 95
  });
}

function syntheticWorld(tiredCloser = false) {
  const players = {
    sp: makePitcher("sp", {
      role: "SP", stuff: 62, command: 60, movement: 60,
      pitchability: 62, stamina: 55
    }),
    cl: makePitcher("cl", {
      role: "CL", stuff: 88, command: 82, movement: 84,
      pitchability: 82, stamina: 34
    }),
    su: makePitcher("su", {
      role: "RP", stuff: 80, command: 76, movement: 77,
      pitchability: 76, stamina: 42
    }),
    mr: makePitcher("mr", {
      role: "RP", stuff: 69, command: 68, movement: 68,
      pitchability: 67, stamina: 45
    }),
    lr: makePitcher("lr", {
      role: "RP", stuff: 60, command: 61, movement: 61,
      pitchability: 62, stamina: 78
    })
  };

  const plan = {
    starterId: "sp",
    bullpenIds: ["lr", "mr", "su", "cl"],
    bullpenMeta: {
      lr: { pregameFatigue: 5, availability: "READY" },
      mr: { pregameFatigue: 5, availability: "READY" },
      su: { pregameFatigue: 8, availability: "READY" },
      cl: {
        pregameFatigue: tiredCloser ? 68 : 5,
        availability: tiredCloser ? "LIMITED" : "READY"
      }
    }
  };

  return { players, plan };
}

function hookState({ inning, homeRuns, awayRuns }) {
  return {
    inning,
    half: "TOP",
    score: { away: awayRuns, home: homeRuns },
    currentPitcherId: { away: "away_sp", home: "sp" },
    pitcherUsage: {
      away: {},
      home: {
        sp: {
          pitcherId: "sp",
          entryInning: 1,
          entryHalf: "TOP",
          pitchCount: 92,
          battersFaced: 27,
          outsRecorded: 18,
          runsAllowed: 3
        }
      }
    }
  };
}

function syntheticChecks() {
  const normal = syntheticWorld(false);
  const lookup = (id) => normal.players[id];
  const roles = classifyBullpenRoles({
    bullpenIds: normal.plan.bullpenIds,
    lookup
  });

  assert.equal(roles.cl, "CLOSER");
  assert.equal(roles.su, "SETUP");
  assert.equal(roles.mr, "MIDDLE");
  assert.equal(roles.lr, "LONG");

  const manager = createPitcherUsageManager({
    players: normal.players,
    pitchingPlans: { away: normal.plan, home: normal.plan }
  });

  const ninth = hookState({ inning: 9, homeRuns: 4, awayRuns: 3 });
  assert.equal(leverageTarget(ninth, "home"), "CLOSER");
  assert.equal(manager({ state: ninth, fieldingTeam: "home" }), "cl");

  const eighth = hookState({ inning: 8, homeRuns: 4, awayRuns: 3 });
  assert.equal(leverageTarget(eighth, "home"), "SETUP");
  assert.equal(manager({ state: eighth, fieldingTeam: "home" }), "su");

  const earlyBlowout = hookState({ inning: 5, homeRuns: 8, awayRuns: 1 });
  assert.equal(leverageTarget(earlyBlowout, "home"), "LONG");
  assert.equal(manager({ state: earlyBlowout, fieldingTeam: "home" }), "lr");

  const tired = syntheticWorld(true);
  const tiredManager = createPitcherUsageManager({
    players: tired.players,
    pitchingPlans: { away: tired.plan, home: tired.plan }
  });

  assert.equal(
    tiredManager({ state: ninth, fieldingTeam: "home" }),
    "su"
  );

  return {
    roles,
    ninthArm: "cl",
    eighthArm: "su",
    earlyBlowoutArm: "lr",
    tiredCloserArm: "su"
  };
}

function careerInput(orgId) {
  return {
    name: "Bullpen QA",
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
    visibleTraits: ["QUICK_BAT", "SOFT_HANDS"],
    organizationMode: "FAVORITE",
    favoriteOrganizationId: String(orgId)
  };
}

function main() {
  const synthetic = syntheticChecks();
  const snapshot = readSnapshot();

  const catalog = seasonApi.getCareerCreationCatalog({
    masterSnapshot: snapshot
  });

  const created = seasonApi.createCareerSeason({
    seed: "phase3-4e-bullpen-leverage",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });

  const payload = seasonApi.serializeSeason(created.seasonId);

  let checkedGames = 0;
  let metadataRows = 0;
  let pitcherChanges = 0;
  const roleCounts = {
    CLOSER: 0,
    SETUP: 0,
    MIDDLE: 0,
    LONG: 0
  };

  for (const level of ["MLB", "AAA"]) {
    const league = payload.fixture.levelLeagues[level];

    for (const game of league.schedule.slice(0, 20)) {
      const fixture = createSeasonGameFixture({
        seasonFixture: payload.fixture,
        scheduleGame: game,
        playerStates: payload.playerStates ?? {},
        pitcherStates: payload.pitcherStates ?? {},
        roleStates: payload.roleStates ?? {},
        level
      });

      for (const side of ["away", "home"]) {
        const plan = fixture.pitchingPlans[side];
        assert.ok(plan.bullpenMeta);

        const roles = classifyBullpenRoles({
          bullpenIds: plan.bullpenIds,
          lookup: (id) => fixture.players[id]
        });

        for (const id of plan.bullpenIds) {
          const meta = plan.bullpenMeta[id];
          assert.ok(meta);
          assert.ok(Number.isFinite(meta.pregameFatigue));
          assert.ok(
            ["READY", "LIMITED", "UNAVAILABLE", "INJURED"]
              .includes(meta.availability)
          );

          const role = roles[id];
          assert.ok(Object.hasOwn(roleCounts, role));
          roleCounts[role] += 1;
          metadataRows += 1;
        }
      }

      const result = simulateSeasonFixtureGame(fixture, {
        seed: `${fixture.seed}:4E`,
        mode: "FAST"
      });

      for (const side of ["away", "home"]) {
        const used = Object.keys(
          result.state.pitcherUsage[side] ?? {}
        );
        pitcherChanges += Math.max(0, used.length - 1);
      }

      checkedGames += 1;
    }
  }

  assert.ok(checkedGames >= 40);
  assert.ok(metadataRows > 100);
  assert.ok(pitcherChanges > 0);
  assert.ok(roleCounts.CLOSER > 0);
  assert.ok(roleCounts.SETUP > 0);
  assert.ok(roleCounts.LONG > 0);

  const report = {
    schema: "THE_CALL_UP_PHASE3_BULLPEN_LEVERAGE_4E_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    policy: {
      hookTiming: "UNCHANGED_CALIBRATED_PHASE1",
      selectionInputs: [
        "INNING",
        "SCORE_DIFFERENTIAL",
        "DERIVED_BULLPEN_ROLE",
        "RELIEVER_QUALITY",
        "PREGAME_FATIGUE",
        "AVAILABILITY"
      ],
      highLeverage: "CLOSER_SETUP_PRIORITY",
      blowoutAndEarly: "LONG_MIDDLE_PRIORITY",
      protagonistBias: false
    },
    synthetic,
    productionSmoke: {
      checkedGames,
      metadataRows,
      pitcherChanges,
      roleCounts
    }
  };

  const out = path.resolve(
    ROOT,
    "reports/phase3-bullpen-leverage-4e-v1.json"
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
