import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createPhase1Hitter } from "../src/engine/player/playerFixtures.js";
import {
  createPositionPlayerSeasonState,
  applyPositionPlayerGame
} from "../src/engine/season/playerSeasonState.js";
import { buildDailyLineup } from "../src/engine/season/lineupRestAI.js";
import { createSeasonGameFixture } from "../src/services/demoSeasonFactory.js";
import { seasonApi } from "../src/api/seasonApi.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAP = "data/the_call_up_snapshot_v3/mlb-milb-2026-production-v3.json.gz";

function readSnapshot() {
  return JSON.parse(
    zlib.gunzipSync(
      fs.readFileSync(path.resolve(ROOT, SNAP))
    ).toString("utf8")
  );
}

function makePlayer(id, position, age = 26, durability = 60) {
  const base = createPhase1Hitter({
    id,
    contactR: 60,
    contactL: 60,
    rawPower: 58,
    vision: 60,
    discipline: 60,
    powerUtilizationR: 58,
    powerUtilizationL: 58,
    speed: 58,
    fielding: 60,
    reaction: 60,
    armStrength: 60,
    armAccuracy: 60,
    primaryPosition: position
  });
  return Object.freeze({
    ...base,
    physical: Object.freeze({ age, durability })
  });
}

function syntheticRoster(starterAge = 36, starterDurability = 48) {
  const positions = ["C","1B","2B","3B","SS","LF","CF","RF","DH"];
  const players = {};
  const lineup = [];
  const lineupSlots = [];
  const defense = {};

  for (const position of positions) {
    const id = `starter_${position}`;
    players[id] = makePlayer(
      id,
      position,
      position === "RF" ? starterAge : 26,
      position === "RF" ? starterDurability : 60
    );
    lineup.push(id);
    lineupSlots.push({ position, starterId: id });
    if (position !== "DH") defense[position] = id;
  }

  players.bench_rf = makePlayer("bench_rf", "RF", 25, 70);

  return {
    team: { id: "REST", name: "Rest QA" },
    players,
    lineup,
    lineupSlots,
    defense,
    bench: [{ playerId: "bench_rf", coverage: ["RF"] }],
    positionPlayers: [...lineup, "bench_rf"]
  };
}

function stateFor({ fatigue, age, durability, lastGameDate, consecutiveStarts }) {
  return {
    playerId: "starter_RF",
    primaryPosition: "RF",
    fatigue,
    health: {
      activeInjury: null,
      age,
      durability,
      history: { total: 0, major: 0, byFamily: {}, recent: [] }
    },
    form: 0,
    recentForm: [],
    gamesPlayed: 20,
    lastGameDate,
    consecutiveStarts,
    positionFamiliarity: { RF: 1 },
    positionReps: { RF: 20 },
    development: {
      focus: "BALANCED",
      progress: {
        contact: 0, power: 0, vision: 0,
        discipline: 0, defense: 0, speed: 0
      },
      gains: {
        contact: 0, power: 0, vision: 0,
        discipline: 0, defense: 0, speed: 0
      },
      ceilings: {
        contact: 99, power: 99, vision: 99,
        discipline: 99, defense: 99, speed: 99
      }
    }
  };
}

function careerInput(orgId) {
  return {
    name: "Rest Policy QA",
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
  const roster = syntheticRoster();

  const tired = {
    starter_RF: stateFor({
      fatigue: 24,
      age: 36,
      durability: 48,
      lastGameDate: "2026-06-09",
      consecutiveStarts: 7
    })
  };

  const dense = buildDailyLineup(
    roster,
    tired,
    {},
    {
      opposingPitcher: { throws: "R" },
      scheduleContext: {
        currentDate: "2026-06-10",
        nextGameGapDays: 1,
        gamesNext7Days: 7
      }
    }
  );
  assert.ok(dense.rested.includes("starter_RF"));
  assert.ok(dense.lineup.includes("bench_rf"));

  const offDay = buildDailyLineup(
    roster,
    tired,
    {},
    {
      opposingPitcher: { throws: "R" },
      scheduleContext: {
        currentDate: "2026-06-10",
        nextGameGapDays: 2,
        gamesNext7Days: 5
      }
    }
  );
  assert.ok(!offDay.rested.includes("starter_RF"));
  assert.ok(offDay.lineup.includes("starter_RF"));

  const young = buildDailyLineup(
    syntheticRoster(23, 78),
    {
      starter_RF: stateFor({
        fatigue: 24,
        age: 23,
        durability: 78,
        lastGameDate: "2026-06-09",
        consecutiveStarts: 4
      })
    },
    {},
    {
      opposingPitcher: { throws: "R" },
      scheduleContext: {
        currentDate: "2026-06-10",
        nextGameGapDays: 1,
        gamesNext7Days: 7
      }
    }
  );
  assert.ok(!young.rested.includes("starter_RF"));

  const streakPlayer = makePlayer("streak", "RF", 28, 60);
  let streak = createPositionPlayerSeasonState(streakPlayer);
  const line = { PA: 4, H: 1, doubles: 0, triples: 0, HR: 0, BB: 0, HBP: 0, SO: 1 };

  for (const [date, expected] of [
    ["2026-06-01", 1],
    ["2026-06-02", 2],
    ["2026-06-03", 3]
  ]) {
    streak = applyPositionPlayerGame(streak, streakPlayer, {
      battingLine: line,
      position: "RF",
      date,
      appearanceType: "START"
    });
    assert.equal(streak.consecutiveStarts, expected);
  }

  streak = applyPositionPlayerGame(streak, streakPlayer, {
    battingLine: line,
    position: "RF",
    date: "2026-06-05",
    appearanceType: "START"
  });
  assert.equal(streak.consecutiveStarts, 1);

  const snapshot = readSnapshot();
  const catalog = seasonApi.getCareerCreationCatalog({ masterSnapshot: snapshot });
  const created = seasonApi.createCareerSeason({
    seed: "phase3-4c-rest-policy",
    input: careerInput(catalog.organizations[0].id),
    masterSnapshot: snapshot
  });
  const payload = seasonApi.serializeSeason(created.seasonId);

  let checkedGames = 0;
  let offDayEveSides = 0;
  let denseSides = 0;

  for (const level of ["MLB", "AAA"]) {
    const league = payload.fixture.levelLeagues[level];

    for (const game of league.schedule.slice(0, 80)) {
      const fixture = createSeasonGameFixture({
        seasonFixture: payload.fixture,
        scheduleGame: game,
        playerStates: payload.playerStates ?? {},
        pitcherStates: payload.pitcherStates ?? {},
        roleStates: payload.roleStates ?? {},
        level
      });

      for (const side of ["away", "home"]) {
        const context = fixture.dailyLineups[side].scheduleContext;
        assert.equal(context.currentDate, game.date);
        assert.ok(Number.isInteger(context.nextGameGapDays));
        assert.ok(context.nextGameGapDays >= 1);
        assert.ok(Number.isInteger(context.gamesNext7Days));
        assert.ok(context.gamesNext7Days >= 1);
        if (context.nextGameGapDays >= 2) offDayEveSides += 1;
        if (context.gamesNext7Days >= 6) denseSides += 1;
      }

      checkedGames += 1;
    }
  }

  assert.ok(checkedGames >= 100);
  assert.ok(offDayEveSides > 0);
  assert.ok(denseSides > 0);

  const report = {
    schema: "THE_CALL_UP_PHASE3_REST_POLICY_4C_V1",
    pass: true,
    snapshotHash: snapshot.metadata.contentHash,
    policy: {
      inputs: [
        "FATIGUE",
        "POSITION",
        "ROLE",
        "AGE",
        "DURABILITY",
        "CONSECUTIVE_STARTS",
        "NEXT_OFF_DAY",
        "GAMES_NEXT_7_DAYS"
      ],
      fixedFatigueThreshold: false,
      hiddenPotentialUsed: false
    },
    synthetic: {
      denseScheduleRested: dense.rested,
      offDayTomorrowRested: offDay.rested,
      youngDurableRested: young.rested,
      streakResetAfterGap: streak.consecutiveStarts
    },
    productionSmoke: {
      checkedGames,
      offDayEveSides,
      denseSides
    }
  };

  const out = path.resolve(ROOT, "reports/phase3-rest-policy-4c-v1.json");
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
