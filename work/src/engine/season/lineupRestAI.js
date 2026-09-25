import { getSeasonEffectivePlayer } from "./playerSeasonState.js";
import { buildBattingOrder } from "./battingOrderAI.js";
import { rolePriority } from "./roleSystem.js";
import { rolePreferenceLineupBonus } from "./rolePreference.js";
import {
  canUtilityCover,
  getUtilityCoverage,
  utilityFamiliarity
} from "./utilityUsage.js";
import { optimizePositionAssignments } from "./positionAssignment.js";
import { healthAvailability } from "./injuryState.js";

const COMPETITION_MIN_GAIN = 2.75;

const DEFENSE_WEIGHTS = Object.freeze({
  C: Object.freeze({
    fielding: 0.30,
    reaction: 0.25,
    speed: 0.00,
    armStrength: 0.23,
    armAccuracy: 0.22
  }),
  "1B": Object.freeze({
    fielding: 0.42,
    reaction: 0.30,
    speed: 0.05,
    armStrength: 0.08,
    armAccuracy: 0.15
  }),
  "2B": Object.freeze({
    fielding: 0.30,
    reaction: 0.30,
    speed: 0.18,
    armStrength: 0.07,
    armAccuracy: 0.15
  }),
  "3B": Object.freeze({
    fielding: 0.27,
    reaction: 0.26,
    speed: 0.07,
    armStrength: 0.22,
    armAccuracy: 0.18
  }),
  SS: Object.freeze({
    fielding: 0.27,
    reaction: 0.30,
    speed: 0.18,
    armStrength: 0.10,
    armAccuracy: 0.15
  }),
  LF: Object.freeze({
    fielding: 0.28,
    reaction: 0.24,
    speed: 0.25,
    armStrength: 0.11,
    armAccuracy: 0.12
  }),
  CF: Object.freeze({
    fielding: 0.25,
    reaction: 0.29,
    speed: 0.29,
    armStrength: 0.08,
    armAccuracy: 0.09
  }),
  RF: Object.freeze({
    fielding: 0.25,
    reaction: 0.23,
    speed: 0.20,
    armStrength: 0.19,
    armAccuracy: 0.13
  })
});

function freeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freeze));
  }
  if (value && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(
          ([key, child]) => [key, freeze(child)]
        )
      )
    );
  }
  return value;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function fatigueOf(playerStates, id) {
  return Number(
    playerStates?.[id]?.fatigue ?? 0
  );
}

function formOf(playerStates, id) {
  return clamp(
    Number(
      playerStates?.[id]?.form ?? 0
    ),
    -1,
    1
  );
}

function available(playerStates, id) {
  return (
    healthAvailability(
      playerStates?.[id]?.health
    ) !== "INJURED"
  );
}

function isoDayNumber(isoDate) {
  if (!isoDate) return null;
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(time)
    ? Math.floor(time / 86400000)
    : null;
}

function effectiveConsecutiveStarts(playerState, scheduleContext) {
  const current = isoDayNumber(scheduleContext?.currentDate);
  const last = isoDayNumber(playerState?.lastGameDate);
  if (current == null || last == null || current - last !== 1) {
    return 0;
  }
  return Math.max(0, Number(playerState?.consecutiveStarts ?? 0));
}

function restProfile({ roster, playerStates, playerId, scheduleContext }) {
  const player = roster?.players?.[playerId] ?? null;
  const state = playerStates?.[playerId] ?? null;
  const age = Number(state?.health?.age ?? player?.physical?.age ?? 26);
  const durability = Number(
    state?.health?.durability ?? player?.physical?.durability ?? 60
  );

  return Object.freeze({
    age: Number.isFinite(age) ? age : 26,
    durability: Number.isFinite(durability) ? durability : 60,
    consecutiveStarts: effectiveConsecutiveStarts(state, scheduleContext),
    nextGameGapDays: Math.max(1, Number(scheduleContext?.nextGameGapDays ?? 1)),
    gamesNext7Days: Math.max(1, Number(scheduleContext?.gamesNext7Days ?? 5))
  });
}

function thresholdFor(position, role = null, profile = {}) {
  let base = 40;
  if (position === "C") {
    base = 30;
  } else if (position === "CF" || position === "SS") {
    base = 36;
  }

  const priority = rolePriority(role);
  const roleProtection = Math.round((priority - 0.5) * 4);

  const age = Number(profile.age ?? 26);
  const ageAdjustment =
    age >= 35 ? -6 :
    age >= 32 ? -4 :
    age >= 30 ? -2 :
    age <= 23 ? 2 : 0;

  const durability = clamp(Number(profile.durability ?? 60), 20, 99);
  const durabilityAdjustment = clamp((durability - 60) * 0.30, -5, 7);

  const consecutiveStarts = Math.max(
    0,
    Number(profile.consecutiveStarts ?? 0)
  );
  const streakAdjustment =
    consecutiveStarts >= 4
      ? -Math.min(8, (consecutiveStarts - 3) * 1.5)
      : 0;

  const nextGameGapDays = Math.max(1, Number(profile.nextGameGapDays ?? 1));
  const offDayAdjustment = nextGameGapDays >= 2 ? 6 : 0;

  const gamesNext7Days = Math.max(1, Number(profile.gamesNext7Days ?? 5));
  const densityAdjustment =
    gamesNext7Days >= 7 ? -4 :
    gamesNext7Days >= 6 ? -2 :
    gamesNext7Days <= 4 ? 2 : 0;

  return clamp(
    base +
      roleProtection +
      ageAdjustment +
      durabilityAdjustment +
      streakAdjustment +
      offDayAdjustment +
      densityAdjustment,
    18,
    58
  );
}

function eligibleForRest(
  slot,
  roster,
  playerStates,
  roleStates,
  scheduleContext
) {
  const fatigue = fatigueOf(playerStates, slot.starterId);
  const profile = restProfile({
    roster,
    playerStates,
    playerId: slot.starterId,
    scheduleContext
  });

  return fatigue >= thresholdFor(
    slot.position,
    roleStates?.[slot.starterId]?.role,
    profile
  );
}

function directBenchCoverage(
  roster,
  playerStates,
  roleStates,
  benchPlayerId,
  position
) {
  if (position === "DH") {
    return true;
  }

  return canUtilityCover(
    roster,
    playerStates,
    roleStates,
    benchPlayerId,
    position
  );
}

function findUtilityShift(
  slots,
  roster,
  playerStates,
  roleStates,
  targetSlot,
  usedBenchIds
) {
  const movers = slots
    .filter(
      (slot) =>
        slot !== targetSlot &&
        slot.playerId ===
          slot.starterId
    )
    .filter(
      (slot) =>
        available(
          playerStates,
          slot.starterId
        )
    )
    .filter(
      (slot) =>
        fatigueOf(
          playerStates,
          slot.starterId
        ) < 52
    )
    .filter(
      (slot) =>
        canUtilityCover(
          roster,
          playerStates,
          roleStates,
          slot.starterId,
          targetSlot.position
        )
    );

  const options = [];

  for (const mover of movers) {
    for (
      const bench of
      roster.bench ?? []
    ) {
      if (
        usedBenchIds.has(
          bench.playerId
        )
      ) {
        continue;
      }

      if (
        !available(
          playerStates,
          bench.playerId
        )
      ) {
        continue;
      }

      if (
        fatigueOf(
          playerStates,
          bench.playerId
        ) >= 52
      ) {
        continue;
      }

      if (
        !canUtilityCover(
          roster,
          playerStates,
          roleStates,
          bench.playerId,
          mover.position
        )
      ) {
        continue;
      }

      options.push({
        mover,
        bench,
        moverFamiliarity:
          utilityFamiliarity(
            roster,
            playerStates,
            mover.starterId,
            targetSlot.position
          ),
        backfillFamiliarity:
          utilityFamiliarity(
            roster,
            playerStates,
            bench.playerId,
            mover.position
          )
      });
    }
  }

  options.sort(
    (a, b) =>
      b.moverFamiliarity -
        a.moverFamiliarity ||
      b.backfillFamiliarity -
        a.backfillFamiliarity ||
      fatigueOf(
        playerStates,
        a.mover.starterId
      ) -
        fatigueOf(
          playerStates,
          b.mover.starterId
        ) ||
      a.mover.position.localeCompare(
        b.mover.position
      ) ||
      a.bench.playerId.localeCompare(
        b.bench.playerId
      )
  );

  return options[0] ?? null;
}

function splitSide(opposingPitcher) {
  const hand =
    String(
      opposingPitcher?.throws ?? ""
    ).toUpperCase();

  if (hand === "L") return "L";
  if (hand === "R") return "R";
  return null;
}

function splitValue(
  rightValue,
  leftValue,
  side
) {
  if (side === "R") {
    return Number(
      rightValue ?? 50
    );
  }
  if (side === "L") {
    return Number(
      leftValue ?? 50
    );
  }

  return (
    Number(rightValue ?? 50) +
    Number(leftValue ?? 50)
  ) / 2;
}

function offenseScore(
  player,
  opposingPitcher
) {
  const hitting =
    player?.hitting ?? {};
  const tendencies =
    player?.tendencies ?? {};
  const running =
    player?.running ?? {};
  const side =
    splitSide(opposingPitcher);

  const contact =
    splitValue(
      hitting.contactR,
      hitting.contactL,
      side
    );

  const powerUtilization =
    splitValue(
      tendencies.powerUtilizationR,
      tendencies.powerUtilizationL,
      side
    );

  return (
    contact * 0.31 +
    powerUtilization * 0.23 +
    Number(
      hitting.rawPower ?? 50
    ) * 0.12 +
    Number(
      hitting.vision ?? 50
    ) * 0.13 +
    Number(
      hitting.discipline ?? 50
    ) * 0.13 +
    Number(
      running.speed ?? 50
    ) * 0.08
  );
}

function defensiveScore(
  roster,
  playerStates,
  playerId,
  position,
  player
) {
  if (position === "DH") {
    return 50;
  }

  const weights =
    DEFENSE_WEIGHTS[position];

  if (!weights) {
    return 50;
  }

  const fielding =
    player?.fielding ?? {};
  const running =
    player?.running ?? {};

  const raw =
    Number(
      fielding.fielding ?? 50
    ) * weights.fielding +
    Number(
      fielding.reaction ?? 50
    ) * weights.reaction +
    Number(
      running.speed ?? 50
    ) * weights.speed +
    Number(
      fielding.armStrength ?? 50
    ) * weights.armStrength +
    Number(
      fielding.armAccuracy ?? 50
    ) * weights.armAccuracy;

  const familiarity =
    clamp(
      utilityFamiliarity(
        roster,
        playerStates,
        playerId,
        position
      ),
      0,
      1
    );

  return (
    raw *
    (
      0.62 +
      familiarity * 0.38
    )
  );
}

function startComponents({
  roster,
  playerStates,
  roleStates,
  playerId,
  position,
  opposingPitcher,
  baselineStarter = false
}) {
  const basePlayer =
    roster?.players?.[playerId];

  if (!basePlayer) {
    return null;
  }

  const player =
    getSeasonEffectivePlayer(
      basePlayer,
      playerStates?.[playerId] ??
        null
    );

  const offense =
    offenseScore(
      player,
      opposingPitcher
    );

  const defense =
    defensiveScore(
      roster,
      playerStates,
      playerId,
      position,
      player
    );

  const role =
    roleStates?.[playerId]?.role ??
    null;

  const roleBonus =
    rolePriority(role) * 4;

  const momentumBonus =
    clamp(
      Number(
        roleStates?.[playerId]
          ?.momentum ?? 0
      ),
      -1,
      1
    ) * 1.4;

  const fatiguePenalty =
    fatigueOf(
      playerStates,
      playerId
    ) * 0.045;

  const stabilityBonus =
    baselineStarter ? 1 : 0;

  const preferenceBonus = rolePreferenceLineupBonus({
    preference: playerStates?.[playerId]?.rolePreference ?? null,
    role, baselineStarter, position,
    primaryPosition: playerStates?.[playerId]?.primaryPosition ?? basePlayer?.positioning?.primaryPosition ?? "DH",
    coverageEligible: canUtilityCover(roster, playerStates, roleStates, playerId, position)
  });

  const score =
    offense * 0.70 +
    defense * 0.30 +
    roleBonus +
    momentumBonus -
    fatiguePenalty +
    stabilityBonus +
    preferenceBonus;

  const side =
    splitSide(opposingPitcher);

  const platoonContact =
    splitValue(
      player?.hitting?.contactR,
      player?.hitting?.contactL,
      side
    );

  return Object.freeze({
    score,
    offense,
    defense,
    rolePriority:
      rolePriority(role),
    momentum:
      Number(
        roleStates?.[playerId]
          ?.momentum ?? 0
      ),
    fatigue:
      fatigueOf(
        playerStates,
        playerId
      ),
    form:
      formOf(
        playerStates,
        playerId
      ),
    platoonContact
  });
}

function decisionReasons(
  candidate,
  starter
) {
  const reasons = [];

  if (
    candidate.platoonContact >=
    starter.platoonContact + 6
  ) {
    reasons.push(
      "PLATOON_EDGE"
    );
  }

  if (
    candidate.offense >=
    starter.offense + 4
  ) {
    reasons.push(
      "OFFENSE_EDGE"
    );
  }

  if (
    candidate.defense >=
    starter.defense + 5
  ) {
    reasons.push(
      "DEFENSE_EDGE"
    );
  }

  if (
    candidate.rolePriority >=
    starter.rolePriority + 0.08
  ) {
    reasons.push(
      "ROLE_EDGE"
    );
  }

  if (
    candidate.form >=
    starter.form + 0.25
  ) {
    reasons.push(
      "FORM_EDGE"
    );
  }

  if (
    starter.fatigue >=
    candidate.fatigue + 18
  ) {
    reasons.push(
      "FATIGUE_EDGE"
    );
  }

  return reasons.length
    ? reasons
    : ["TOTAL_FIT_EDGE"];
}

function applyDailyCompetition({
  roster,
  slots,
  playerStates,
  roleStates,
  opposingPitcher,
  usedBenchIds,
  replacements
}) {
  const decisions = [];

  const options = [];

  for (
    const bench of
    roster.bench ?? []
  ) {
    const benchId =
      bench.playerId;

    if (
      usedBenchIds.has(benchId)
    ) {
      continue;
    }

    if (
      !available(
        playerStates,
        benchId
      )
    ) {
      continue;
    }

    for (const slot of slots) {
      if (
        slot.playerId !==
        slot.starterId
      ) {
        continue;
      }

      if (
        !available(
          playerStates,
          slot.starterId
        )
      ) {
        continue;
      }

      if (
        !directBenchCoverage(
          roster,
          playerStates,
          roleStates,
          benchId,
          slot.position
        )
      ) {
        continue;
      }

      const candidate =
        startComponents({
          roster,
          playerStates,
          roleStates,
          playerId: benchId,
          position: slot.position,
          opposingPitcher,
          baselineStarter: false
        });

      const starter =
        startComponents({
          roster,
          playerStates,
          roleStates,
          playerId:
            slot.starterId,
          position:
            slot.position,
          opposingPitcher,
          baselineStarter: true
        });

      if (
        !candidate ||
        !starter
      ) {
        continue;
      }

      const gain =
        candidate.score -
        starter.score;

      if (
        gain <
        COMPETITION_MIN_GAIN
      ) {
        continue;
      }

      options.push({
        bench,
        slot,
        candidate,
        starter,
        gain
      });
    }
  }

  options.sort(
    (a, b) =>
      b.gain - a.gain ||
      a.slot.position.localeCompare(
        b.slot.position
      ) ||
      a.bench.playerId.localeCompare(
        b.bench.playerId
      )
  );

  const replacedStarters =
    new Set();

  for (const option of options) {
    const benchId =
      option.bench.playerId;
    const starterId =
      option.slot.starterId;

    if (
      usedBenchIds.has(benchId) ||
      replacedStarters.has(starterId)
    ) {
      continue;
    }

    if (
      option.slot.playerId !==
      starterId
    ) {
      continue;
    }

    option.slot.playerId =
      benchId;

    usedBenchIds.add(
      benchId
    );
    replacedStarters.add(
      starterId
    );

    const reasons =
      decisionReasons(
        option.candidate,
        option.starter
      );

    replacements.push({
      kind:
        "COMPETITION_DIRECT",
      playerId: benchId,
      forPlayerId: starterId,
      position:
        option.slot.position,
      reasons
    });

    decisions.push({
      playerId: benchId,
      forPlayerId: starterId,
      position:
        option.slot.position,
      reasons,
      scoreGain:
        Number(
          option.gain.toFixed(3)
        )
    });
  }

  return decisions;
}

function dailyBenchRows(
  roster,
  lineup,
  playerStates,
  roleStates
) {
  const lineupSet =
    new Set(lineup);

  const ids =
    [
      ...(
        roster.positionPlayers ??
        []
      ),
      ...(
        roster.lineup ??
        []
      ),
      ...(
        roster.bench ?? []
      ).map(
        (row) => row.playerId
      )
    ];

  return [
    ...new Set(ids)
  ]
    .filter(
      (playerId) =>
        !lineupSet.has(playerId)
    )
    .map((playerId) => {
      const coverage =
        [
          "DH",
          ...getUtilityCoverage(
            roster,
            playerStates,
            roleStates,
            playerId
          )
        ];

      return {
        playerId,
        coverage:
          [
            ...new Set(
              coverage
            )
          ]
      };
    });
}

/**
 * Daily lineup AI.
 *
 * Stage 0: injuries.
 * Stage 1: fatigue/direct rest.
 * Stage 2: utility rest fallback.
 * Stage 3: real daily competition using current ability, opponent hand,
 *          defensive fit, persistent role, form and fatigue.
 *
 * Stage 4: optimize batting order against the opposing starter.
 */
function buildDailyLineup(
  roster,
  playerStates = {},
  roleStates = {},
  {
    opposingPitcher = null,
    scheduleContext = null,
    voluntaryRestPlayerId = null
  } = {}
) {
  if (
    !roster?.lineupSlots ||
    !Array.isArray(roster.bench)
  ) {
    return freeze({
      lineup: [
        ...(roster?.lineup ?? [])
      ],
      defense: {
        ...(roster?.defense ?? {})
      },
      bench: [
        ...(roster?.bench ?? [])
      ],
      rested: [],
      unavailable: [],
      replacements: [],
      utilityAssignments: [],
      competitionDecisions: [],
      positionAssignments: [],
      scheduleContext: scheduleContext ?? null
    });
  }

  const slots =
    roster.lineupSlots.map(
      (slot) => ({
        ...slot,
        playerId:
          slot.starterId
      })
    );

  const rested = [];
  const unavailable = [];
  const replacements = [];
  const utilityAssignments = [];
  const usedBenchIds =
    new Set();

  const injuredTargets =
    slots.filter(
      (slot) =>
        !available(
          playerStates,
          slot.starterId
        )
    );

  for (
    const targetSlot of
    injuredTargets
  ) {
    if (
      targetSlot.playerId !==
      targetSlot.starterId
    ) {
      continue;
    }

    const direct =
      (
        roster.bench ?? []
      ).find(
        (bench) =>
          !usedBenchIds.has(
            bench.playerId
          ) &&
          available(
            playerStates,
            bench.playerId
          ) &&
          directBenchCoverage(
            roster,
            playerStates,
            roleStates,
            bench.playerId,
            targetSlot.position
          )
      );

    if (direct) {
      unavailable.push(
        targetSlot.starterId
      );

      replacements.push({
        kind: "INJURY_DIRECT",
        playerId:
          direct.playerId,
        forPlayerId:
          targetSlot.starterId,
        position:
          targetSlot.position
      });

      targetSlot.playerId =
        direct.playerId;

      usedBenchIds.add(
        direct.playerId
      );
      continue;
    }

    const option =
      findUtilityShift(
        slots,
        roster,
        playerStates,
        roleStates,
        targetSlot,
        usedBenchIds
      );

    if (option) {
      const {
        mover,
        bench,
        moverFamiliarity,
        backfillFamiliarity
      } = option;

      const moverId =
        mover.starterId;
      const targetId =
        targetSlot.starterId;

      mover.playerId =
        bench.playerId;
      targetSlot.playerId =
        moverId;

      usedBenchIds.add(
        bench.playerId
      );
      unavailable.push(
        targetId
      );

      replacements.push({
        kind:
          "INJURY_UTILITY_BACKFILL",
        playerId:
          bench.playerId,
        forPlayerId:
          moverId,
        position:
          mover.position
      });

      utilityAssignments.push({
        playerId:
          moverId,
        fromPosition:
          mover.position,
        toPosition:
          targetSlot.position,
        forPlayerId:
          targetId,
        backfillPlayerId:
          bench.playerId,
        familiarity:
          Number(
            moverFamiliarity.toFixed(
              3
            )
          ),
        backfillFamiliarity:
          Number(
            backfillFamiliarity.toFixed(
              3
            )
          )
      });

      continue;
    }

    const emergency =
      (
        roster.bench ?? []
      ).find(
        (bench) =>
          !usedBenchIds.has(
            bench.playerId
          ) &&
          available(
            playerStates,
            bench.playerId
          )
      );

    if (emergency) {
      unavailable.push(
        targetSlot.starterId
      );

      replacements.push({
        kind:
          "INJURY_EMERGENCY",
        playerId:
          emergency.playerId,
        forPlayerId:
          targetSlot.starterId,
        position:
          targetSlot.position
      });

      targetSlot.playerId =
        emergency.playerId;

      usedBenchIds.add(
        emergency.playerId
      );
    }
  }

  // A player's request is considered only after injury coverage, and only if
  // a healthy reserve can cover the position. There is no synthetic injury,
  // performance boost, or automatic override of the manager's roster.
  let voluntaryRest = null;
  if (voluntaryRestPlayerId) {
    const requestedSlot = slots.find((slot) => slot.starterId === voluntaryRestPlayerId);
    if (!requestedSlot) {
      voluntaryRest = { approved: false, reasonCode: "NOT_STARTER" };
    } else if (!available(playerStates, voluntaryRestPlayerId) || requestedSlot.playerId !== voluntaryRestPlayerId) {
      voluntaryRest = { approved: false, reasonCode: "INJURED_OR_REPLACED" };
    } else {
      const cover = roster.bench.find((bench) =>
        !usedBenchIds.has(bench.playerId)
        && available(playerStates, bench.playerId)
        && directBenchCoverage(roster, playerStates, roleStates, bench.playerId, requestedSlot.position)
      );
      if (!cover) {
        voluntaryRest = { approved: false, reasonCode: "NO_AVAILABLE_COVER" };
      } else {
        requestedSlot.playerId = cover.playerId;
        usedBenchIds.add(cover.playerId);
        usedBenchIds.add(voluntaryRestPlayerId);
        rested.push(voluntaryRestPlayerId);
        replacements.push({ kind: "PLAYER_REST_REQUEST", playerId: cover.playerId,
          forPlayerId: voluntaryRestPlayerId, position: requestedSlot.position });
        voluntaryRest = { approved: true, reasonCode: "COVER_AVAILABLE" };
      }
    }
  }

  for (
    const bench of
    roster.bench
  ) {
    if (
      usedBenchIds.has(
        bench.playerId
      )
    ) {
      continue;
    }

    if (
      !available(
        playerStates,
        bench.playerId
      )
    ) {
      continue;
    }

    if (
      fatigueOf(
        playerStates,
        bench.playerId
      ) >= 52
    ) {
      continue;
    }

    const candidates =
      slots
        .filter(
          (slot) =>
            slot.playerId ===
              slot.starterId &&
            available(
              playerStates,
              slot.starterId
            ) &&
            directBenchCoverage(
              roster,
              playerStates,
              roleStates,
              bench.playerId,
              slot.position
            )
        )
        .map(
          (slot) => ({
            slot,
            fatigue:
              fatigueOf(
                playerStates,
                slot.starterId
              )
          })
        )
        .filter(
          ({
            slot,
            fatigue
          }) => {
            const profile = restProfile({
              roster,
              playerStates,
              playerId: slot.starterId,
              scheduleContext
            });

            return (
              fatigue >=
              thresholdFor(
                slot.position,
                roleStates?.[
                  slot.starterId
                ]?.role,
                profile
              )
            );
          }
        )
        .sort(
          (a, b) =>
            b.fatigue -
              a.fatigue ||
            a.slot.position.localeCompare(
              b.slot.position
            )
        );

    const selected =
      candidates[0];

    if (!selected) {
      continue;
    }

    rested.push(
      selected.slot.starterId
    );

    replacements.push({
      kind: "DIRECT",
      playerId:
        bench.playerId,
      forPlayerId:
        selected.slot.starterId,
      position:
        selected.slot.position
    });

    selected.slot.playerId =
      bench.playerId;

    usedBenchIds.add(
      bench.playerId
    );
  }

  const uncovered =
    slots
      .filter(
        (slot) =>
          slot.playerId ===
            slot.starterId &&
          available(
            playerStates,
            slot.starterId
          ) &&
          eligibleForRest(
            slot,
            roster,
            playerStates,
            roleStates,
            scheduleContext
          )
      )
      .sort(
        (a, b) =>
          fatigueOf(
            playerStates,
            b.starterId
          ) -
            fatigueOf(
              playerStates,
              a.starterId
            ) ||
          a.position.localeCompare(
            b.position
          )
      );

  for (
    const targetSlot of
    uncovered
  ) {
    if (
      targetSlot.playerId !==
      targetSlot.starterId
    ) {
      continue;
    }

    const option =
      findUtilityShift(
        slots,
        roster,
        playerStates,
        roleStates,
        targetSlot,
        usedBenchIds
      );

    if (!option) {
      continue;
    }

    const {
      mover,
      bench,
      moverFamiliarity,
      backfillFamiliarity
    } = option;

    const moverId =
      mover.starterId;
    const targetId =
      targetSlot.starterId;

    mover.playerId =
      bench.playerId;
    targetSlot.playerId =
      moverId;

    usedBenchIds.add(
      bench.playerId
    );
    rested.push(
      targetId
    );

    replacements.push({
      kind:
        "UTILITY_BACKFILL",
      playerId:
        bench.playerId,
      forPlayerId:
        moverId,
      position:
        mover.position
    });

    utilityAssignments.push({
      playerId:
        moverId,
      fromPosition:
        mover.position,
      toPosition:
        targetSlot.position,
      forPlayerId:
        targetId,
      backfillPlayerId:
        bench.playerId,
      familiarity:
        Number(
          moverFamiliarity.toFixed(
            3
          )
        ),
      backfillFamiliarity:
        Number(
          backfillFamiliarity.toFixed(
            3
          )
        )
    });
  }

  const competitionDecisions =
    applyDailyCompetition({
      roster,
      slots,
      playerStates,
      roleStates,
      opposingPitcher,
      usedBenchIds,
      replacements
    });

  const selectedPlayers =
    slots.map(
      (slot) =>
        slot.playerId
    );

  const battingOrder =
    buildBattingOrder({
      playerIds:
        selectedPlayers,
      roster,
      playerStates,
      opposingPitcher,
      baselineOrder:
        roster.lineup ?? []
    });

  const lineup =
    battingOrder.lineup;

  const optimized =
    optimizePositionAssignments({
      roster,
      slots,
      playerStates,
      roleStates
    });

  const defense = {};

  for (
    const [
      position,
      playerId
    ] of Object.entries(
      optimized.assignments
    )
  ) {
    if (position !== "DH") {
      defense[position] =
        playerId;
    }
  }

  const bench =
    dailyBenchRows(
      roster,
      lineup,
      playerStates,
      roleStates
    ).filter((row) => !voluntaryRest?.approved || row.playerId !== voluntaryRestPlayerId);

  return freeze({
    lineup,
    selectedPlayers,
    battingOrder,
    defense,
    bench,
    rested,
    unavailable,
    replacements,
    utilityAssignments,
    competitionDecisions,
    ...(voluntaryRestPlayerId ? { voluntaryRest } : {}),
    positionAssignments:
      optimized.changes,
    scheduleContext:
      scheduleContext ?? null
  });
}

export {
  COMPETITION_MIN_GAIN,
  buildDailyLineup
};
