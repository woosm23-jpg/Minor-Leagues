import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  assessBullpenRecovery
} from "../src/engine/season/bullpenRecoveryPolicy.js";
import {
  createPitcherUsageManager
} from "../src/engine/game/pitcherUsageAI.js";
import {
  createPhase1Pitcher
} from "../src/engine/player/playerFixtures.js";
import {
  createPitcherSeasonState
} from "../src/engine/season/pitcherSeasonState.js";
import {
  createSeasonGameFixture
} from "../src/services/demoSeasonFactory.js";
import {
  simulateSeasonFixtureGame
} from "../src/services/seasonGameService.js";
import { seasonApi } from "../src/api/seasonApi.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const SNAP =
  "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function priorDate(date, days) {
  return new Date(
    Date.parse(`${date}T00:00:00Z`) -
      days * 86400000
  ).toISOString().slice(0, 10);
}

function policyCase(gap, pitches) {
  return assessBullpenRecovery({
    gameDate: "2026-06-11",
    lastAppearanceDate:
      gap === null
        ? null
        : priorDate("2026-06-11", gap),
    lastPitchCount: pitches
  });
}

function simplePitcher(id, role, stuff) {
  return createPhase1Pitcher({
    id,
    role,
    stuff,
    control: 65,
    command: 68,
    movement: 67,
    pitchability: 66,
    stamina: role === "SP" ? 60 : 40,
    pitchVelocityMph: 94
  });
}

function forcedHookState(starterId, side = "home") {
  return {
    inning: 9,
    half: side === "home" ? "TOP" : "BOTTOM",
    score: { away: 3, home: 4 },
    currentPitcherId: {
      away: side === "away" ? starterId : "unused_away",
      home: side === "home" ? starterId : "unused_home"
    },
    pitcherUsage: {
      away: side === "away" ? {
        [starterId]: {
          pitcherId: starterId,
          entryInning: 1,
          pitchCount: 120,
          battersFaced: 30,
          outsRecorded: 18,
          runsAllowed: 3
        }
      } : {},
      home: side === "home" ? {
        [starterId]: {
          pitcherId: starterId,
          entryInning: 1,
          pitchCount: 120,
          battersFaced: 30,
          outsRecorded: 18,
          runsAllowed: 3
        }
      } : {}
    }
  };
}

function syntheticChecks() {
  assert.equal(policyCase(null, 0).status, "READY");
  assert.equal(policyCase(0, 4).status, "REST");
  assert.equal(policyCase(1, 12).status, "READY");
  assert.equal(policyCase(1, 24).status, "LIMITED");
  assert.equal(policyCase(1, 40).status, "REST");
  assert.equal(policyCase(2, 52).status, "LIMITED");
  assert.equal(policyCase(3, 52).status, "READY");

  const players = {
    sp: simplePitcher("sp", "SP", 60),
    cl: simplePitcher("cl", "CL", 89),
    su: simplePitcher("su", "RP", 78),
    mr: simplePitcher("mr", "RP", 63)
  };

  function plan(closerRecovery, allRest = false) {
    const ready = {
      recoveryStatus: "READY",
      availability: "READY",
      pregameFatigue: 5
    };
    const rested = {
      ...ready,
      recoveryStatus: "REST"
    };
    return {
      starterId: "sp",
      bullpenIds: ["cl", "su", "mr"],
      bullpenMeta: {
        cl: allRest ? rested : {
          ...ready,
          recoveryStatus: closerRecovery
        },
        su: allRest ? rested : ready,
        mr: allRest ? rested : ready
      }
    };
  }

  function pick(closerRecovery, allRest = false) {
    const pitchingPlan = plan(closerRecovery, allRest);
    const manager = createPitcherUsageManager({
      players,
      pitchingPlans: {
        home: pitchingPlan,
        away: pitchingPlan
      }
    });
    return manager({
      state: forcedHookState("sp"),
      fieldingTeam: "home"
    });
  }

  assert.equal(pick("READY"), "cl");
  assert.equal(pick("REST"), "su");
  assert.ok(["cl", "su", "mr"].includes(pick("REST", true)));

  return {
    readyCloser: pick("READY"),
    protectedCloser: pick("REST"),
    emergencyArm: pick("REST", true)
  };
}

function careerInput(orgId) {
  return {
    name: "Bullpen Recovery QA",
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
  const snapshot = JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(path.resolve(ROOT, SNAP))
    ).toString("utf8")
  );

  const catalog = seasonApi.getCareerCreationCatalog({
    masterSnapshot: snapshot
  });
  const created = seasonApi.createCareerSeason({
    seed: "phase3-4f-bullpen-recovery",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  let checkedGames = 0;
  let metadataRows = 0;
  let pitcherChanges = 0;
  let injectedHeavyOutings = 0;
  let protectedFromReentry = 0;

  for (const level of ["MLB", "AAA"]) {
    const league = payload.fixture.levelLeagues[level];

    for (const game of league.schedule.slice(0, 20)) {
      const roster = league.rosters[game.awayTeamId];
      const restCandidateId = roster.bullpen[0];
      const original = payload.pitcherStates?.[restCandidateId]
        ?? createPitcherSeasonState(roster.players[restCandidateId]);

      const pitcherStates = {
        ...(payload.pitcherStates ?? {}),
        [restCandidateId]: {
          ...original,
          fatigue: 18,
          lastAppearanceDate: priorDate(game.date, 1),
          lastPitchCount: 42
        }
      };

      const fixture = createSeasonGameFixture({
        seasonFixture: payload.fixture,
        scheduleGame: game,
        playerStates: payload.playerStates ?? {},
        pitcherStates,
        roleStates: payload.roleStates ?? {},
        level
      });

      for (const side of ["away", "home"]) {
        const plan = fixture.pitchingPlans[side];

        for (const id of plan.bullpenIds) {
          const meta = plan.bullpenMeta?.[id];
          assert.ok(meta);
          assert.ok(["READY", "LIMITED", "REST"].includes(
            meta.recoveryStatus
          ));
          assert.ok(Object.hasOwn(meta, "lastPitchCount"));
          assert.ok(Object.hasOwn(meta, "daysSinceAppearance"));
          metadataRows += 1;
        }
      }

      const awayPlan = fixture.pitchingPlans.away;
      assert.ok(awayPlan.bullpenIds.includes(restCandidateId));

      const meta = awayPlan.bullpenMeta[restCandidateId];
      assert.equal(meta.lastPitchCount, 42);
      assert.equal(meta.daysSinceAppearance, 1);
      assert.equal(meta.recoveryStatus, "REST");
      injectedHeavyOutings += 1;

      // The policy must affect the actual game manager, not only the report.
      const manager = createPitcherUsageManager({
        players: fixture.players,
        pitchingPlans: fixture.pitchingPlans
      });
      const state = forcedHookState(awayPlan.starterId, "away");
      const choice = manager({
        state,
        fieldingTeam: "away"
      });

      const readyOthers = awayPlan.bullpenIds.filter(
        (id) =>
          id !== restCandidateId &&
          awayPlan.bullpenMeta[id]?.recoveryStatus !== "REST" &&
          awayPlan.bullpenMeta[id]?.availability !== "UNAVAILABLE"
      );

      if (readyOthers.length > 0) {
        assert.notEqual(choice, restCandidateId);
        protectedFromReentry += 1;
      }

      const result = simulateSeasonFixtureGame(fixture, {
        seed: `${fixture.seed}:4F`,
        mode: "FAST"
      });

      for (const side of ["away", "home"]) {
        pitcherChanges += Math.max(
          0,
          Object.keys(result.state.pitcherUsage[side] ?? {}).length - 1
        );
      }
      checkedGames += 1;
    }
  }

  assert.ok(checkedGames >= 40);
  assert.ok(metadataRows > 100);
  assert.equal(injectedHeavyOutings, checkedGames);
  assert.ok(protectedFromReentry > 0);
  assert.ok(pitcherChanges > 0);

  const report = {
    schema: "THE_CALL_UP_PHASE3_BULLPEN_RECOVERY_4F_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    policy: {
      existingSaveSchemaPreserved: true,
      recoveryInputs: [
        "GAME_DATE",
        "LAST_APPEARANCE_DATE",
        "LAST_PITCH_COUNT",
        "PREGAME_FATIGUE",
        "HEALTH_AVAILABILITY"
      ],
      heavyPreviousDayRestThresholdPitches: 30,
      limitedPreviousDayThresholdPitches: 18,
      limitedTwoDaysAgoThresholdPitches: 45,
      emergencyFallback: "ONLY_IF_NO_READY_ARM",
      starterHookTiming: "UNCHANGED"
    },
    synthetic,
    productionSmoke: {
      checkedGames,
      metadataRows,
      injectedHeavyOutings,
      protectedFromReentry,
      pitcherChanges
    }
  };

  const out = path.resolve(
    ROOT,
    "reports/phase3-bullpen-recovery-4f-v1.json"
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
