function freeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freeze));
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(
          ([key, child]) => [
            key,
            freeze(child)
          ]
        )
      )
    );
  }

  return value;
}

const INFIELD =
  new Set([
    "1B",
    "2B",
    "3B",
    "SS"
  ]);

const OUTFIELD =
  new Set([
    "LF",
    "CF",
    "RF"
  ]);

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function activeIds(
  state,
  team
) {
  return new Set(
    state?.lineups?.[
      team
    ] ?? []
  );
}

function usedIds(
  state,
  team
) {
  const ids =
    new Set();

  for (
    const row of
    state?.substitutions ??
    []
  ) {
    if (
      row.team !== team
    ) {
      continue;
    }

    ids.add(
      row.inPlayerId
    );
    ids.add(
      row.outPlayerId
    );
  }

  return ids;
}

function playerPosition(
  state,
  team,
  playerId
) {
  for (
    const [
      position,
      id
    ] of Object.entries(
      state
        ?.defensiveAlignment
        ?.[team] ?? {}
    )
  ) {
    if (
      position !== "P" &&
      id === playerId
    ) {
      return position;
    }
  }

  return "DH";
}

function canCover(
  benchRow,
  position
) {
  if (
    position === "DH"
  ) {
    return true;
  }

  return (
    benchRow?.coverage ??
    []
  ).includes(position);
}

function isBackupCatcher(
  benchRow
) {
  return (
    benchRow?.coverage ??
    []
  ).includes("C");
}

function handedContact(
  player,
  pitcherThrows = "R"
) {
  const hitting =
    player?.hitting ?? {};

  if (
    pitcherThrows === "L"
  ) {
    return Number(
      hitting.contactL ??
      hitting.contactR ??
      50
    );
  }

  return Number(
    hitting.contactR ??
    hitting.contactL ??
    50
  );
}

function handedPower(
  player,
  pitcherThrows = "R"
) {
  const tendencies =
    player?.tendencies ?? {};
  const hitting =
    player?.hitting ?? {};

  if (
    pitcherThrows === "L"
  ) {
    return Number(
      tendencies
        .powerUtilizationL ??
      hitting.rawPower ??
      50
    );
  }

  return Number(
    tendencies
      .powerUtilizationR ??
    hitting.rawPower ??
    50
  );
}

function offenseScore(
  player,
  pitcherThrows = "R"
) {
  const hitting =
    player?.hitting ?? {};

  const contact =
    handedContact(
      player,
      pitcherThrows
    );

  const power =
    handedPower(
      player,
      pitcherThrows
    );

  const vision =
    Number(
      hitting.vision ?? 50
    );

  const discipline =
    Number(
      hitting.discipline ?? 50
    );

  const switchBonus =
    player?.bats === "S"
      ? 0.8
      : 0;

  return (
    contact * 0.42 +
    power * 0.23 +
    vision * 0.15 +
    discipline * 0.20 +
    switchBonus
  );
}

function defenseScore(
  player,
  position
) {
  const fielding =
    player?.fielding ?? {};
  const running =
    player?.running ?? {};

  const skill =
    Number(
      fielding.fielding ??
      50
    );
  const reaction =
    Number(
      fielding.reaction ??
      50
    );
  const armStrength =
    Number(
      fielding.armStrength ??
      50
    );
  const armAccuracy =
    Number(
      fielding.armAccuracy ??
      50
    );
  const speed =
    Number(
      running.speed ??
      50
    );

  let raw;

  if (
    position === "C"
  ) {
    raw =
      skill * 0.30 +
      reaction * 0.20 +
      armStrength * 0.30 +
      armAccuracy * 0.20;
  } else if (
    position === "SS" ||
    position === "3B"
  ) {
    raw =
      skill * 0.30 +
      reaction * 0.30 +
      armStrength * 0.20 +
      armAccuracy * 0.20;
  } else if (
    position === "2B"
  ) {
    raw =
      skill * 0.35 +
      reaction * 0.35 +
      armAccuracy * 0.20 +
      speed * 0.10;
  } else if (
    position === "CF"
  ) {
    raw =
      skill * 0.25 +
      reaction * 0.30 +
      speed * 0.30 +
      armAccuracy * 0.15;
  } else if (
    position === "LF" ||
    position === "RF"
  ) {
    raw =
      skill * 0.30 +
      reaction * 0.25 +
      speed * 0.20 +
      armStrength * 0.15 +
      armAccuracy * 0.10;
  } else if (
    position === "1B"
  ) {
    raw =
      skill * 0.45 +
      reaction * 0.25 +
      armAccuracy * 0.20 +
      armStrength * 0.10;
  } else {
    raw =
      skill * 0.5 +
      reaction * 0.5;
  }

  const familiarity =
    position === "DH"
      ? 1
      : Number(
          player
            ?.positioning
            ?.familiarity
            ?.[position] ??
          0.35
        );

  return (
    raw *
    (
      0.72 +
      0.28 *
        clamp(
          familiarity,
          0.35,
          1
        )
    )
  );
}

function runningScore(
  player
) {
  const running =
    player?.running ?? {};

  return (
    Number(
      running.speed ??
      50
    ) * 0.72 +
    Number(
      running.baserunning ??
      50
    ) * 0.28
  );
}

function roleTagsForRow(
  row
) {
  const coverage =
    row?.coverage ?? [];

  const infieldCount =
    coverage.filter(
      (position) =>
        INFIELD.has(
          position
        )
    ).length;

  const outfieldCount =
    coverage.filter(
      (position) =>
        OUTFIELD.has(
          position
        )
    ).length;

  const tags = [];

  if (
    coverage.includes("C")
  ) {
    tags.push(
      "BACKUP_CATCHER"
    );
  }

  if (
    infieldCount >= 2
  ) {
    tags.push(
      "UTILITY_INFIELDER"
    );
  }

  if (
    outfieldCount >= 2
  ) {
    tags.push(
      "FOURTH_OUTFIELDER"
    );
  }

  if (
    row?.role ===
    "PLATOON"
  ) {
    tags.push(
      "PLATOON_BAT"
    );
  }

  if (
    row?.role ===
    "UTILITY"
  ) {
    tags.push(
      "UTILITY_ROLE"
    );
  }

  if (
    row?.role ===
    "ROTATION"
  ) {
    tags.push(
      "ROTATION_ROLE"
    );
  }

  return tags;
}

function classifyBenchRoles({
  players = {},
  benchPlan = []
} = {}) {
  const rows =
    benchPlan.map(
      (row) => {
        const coverage =
          row?.coverage?.length
            ? row.coverage
            : ["DH"];

        return {
          playerId:
            row.playerId,
          roles:
            roleTagsForRow(
              row
            ),
          offense:
            offenseScore(
              players[
                row.playerId
              ]
            ),
          speedDefense:
            runningScore(
              players[
                row.playerId
              ]
            ) +
            Math.max(
              ...coverage.map(
                (position) =>
                  position === "DH"
                    ? 45
                    : defenseScore(
                        players[
                          row.playerId
                        ],
                        position
                      )
              )
            )
        };
      }
    );

  if (
    rows.length > 0
  ) {
    const nonCatcherPool =
      rows.filter(
        (row) =>
          !row.roles.includes(
            "BACKUP_CATCHER"
          )
      );

    const pinchBatPool =
      nonCatcherPool.length > 0
        ? nonCatcherPool
        : rows;

    [
      ...pinchBatPool
    ]
      .sort(
        (a, b) =>
          b.offense -
            a.offense ||
          a.playerId
            .localeCompare(
              b.playerId
            )
      )[0]
      .roles.push(
        "PINCH_BAT"
      );

    [
      ...rows
    ]
      .sort(
        (a, b) =>
          b.speedDefense -
            a.speedDefense ||
          a.playerId
            .localeCompare(
              b.playerId
            )
      )[0]
      .roles.push(
        "SPEED_DEFENSE_SPECIALIST"
      );
  }

  return freeze(
    Object.fromEntries(
      rows.map(
        (row) => [
          row.playerId,
          [
            ...new Set(
              row.roles
            )
          ]
        ]
      )
    )
  );
}

function candidateRows({
  state,
  team,
  benchPlan,
  position
}) {
  const active =
    activeIds(
      state,
      team
    );

  const used =
    usedIds(
      state,
      team
    );

  return benchPlan.filter(
    (row) =>
      !active.has(
        row.playerId
      ) &&
      !used.has(
        row.playerId
      ) &&
      state.currentPitcherId?.[team] !== row.playerId &&
      Number(
        row.fatigue ?? 0
      ) < 82 &&
      canCover(
        row,
        position
      )
  );
}

function scoreDiff(
  state,
  team
) {
  const other =
    team === "away"
      ? "home"
      : "away";

  return (
    Number(
      state?.score?.[
        team
      ] ?? 0
    ) -
    Number(
      state?.score?.[
        other
      ] ?? 0
    )
  );
}

function currentPitcherThrows(
  state,
  players
) {
  const fieldingTeam =
    state.half === "TOP"
      ? "home"
      : "away";

  const pitcherId =
    state
      .currentPitcherId
      ?.[fieldingTeam];

  return (
    players?.[
      pitcherId
    ]?.throws ??
    "R"
  );
}

function alreadyUsedAtCurrentPA(
  state,
  team,
  reason
) {
  return (
    state.substitutions ??
    []
  ).some(
    (row) =>
      row.team === team &&
      row.reason === reason &&
      row.plateAppearances ===
        state.plateAppearances
  );
}

function benchTags(
  benchRoles,
  playerId
) {
  return (
    benchRoles?.[
      playerId
    ] ?? []
  );
}

function tacticalBonus(
  row,
  tags,
  purpose
) {
  let bonus =
    clamp(
      Number(
        row?.momentum ??
        0
      ),
      -1,
      1
    ) * 0.45;

  if (
    purpose ===
    "PINCH_HIT"
  ) {
    if (
      tags.includes(
        "PINCH_BAT"
      )
    ) {
      bonus += 1.4;
    }

    if (
      tags.includes(
        "PLATOON_BAT"
      )
    ) {
      bonus += 0.8;
    }

    if (
      row?.role ===
      "PLATOON"
    ) {
      bonus += 0.5;
    }
  }

  if (
    purpose ===
      "PINCH_RUN" ||
    purpose ===
      "DEFENSIVE_REPLACEMENT"
  ) {
    if (
      tags.includes(
        "SPEED_DEFENSE_SPECIALIST"
      )
    ) {
      bonus += 1.5;
    }

    if (
      row?.role ===
        "UTILITY" ||
      row?.role ===
        "ROTATION"
    ) {
      bonus += 0.5;
    }
  }

  return bonus;
}

function pinchRunMinimumGain(
  state,
  diff
) {
  if (
    state.inning >= 9 &&
    diff >= -1 &&
    diff <= 1
  ) {
    return 7;
  }

  return 10;
}

function pinchHitMinimumGain(
  state,
  diff
) {
  if (
    state.inning >= 9 &&
    diff >= -2 &&
    diff <= 0
  ) {
    return 2.5;
  }

  if (
    state.inning === 8 &&
    diff >= -2 &&
    diff <= 0
  ) {
    return 3.25;
  }

  return 4;
}

function defenseMinimumGain(
  state
) {
  return (
    state.inning >= 9
      ? 4.5
      : 5.5
  );
}

function maxDefenseOffenseCost(
  state
) {
  if (
    state.inning >= 9
  ) {
    return 16;
  }

  return 10;
}

function choosePinchRunner({
  state,
  team,
  players,
  benchPlan,
  benchRoles
}) {
  if (
    state.inning < 8
  ) {
    return null;
  }

  const diff =
    scoreDiff(
      state,
      team
    );

  if (
    diff < -2 ||
    diff > 1
  ) {
    return null;
  }

  if (
    alreadyUsedAtCurrentPA(
      state,
      team,
      "PINCH_RUN"
    )
  ) {
    return null;
  }

  const occupied =
    [
      "third",
      "second",
      "first"
    ]
      .map(
        (base) => ({
          base,
          playerId:
            state.bases?.[
              base
            ] ?? null
        })
      )
      .filter(
        (row) =>
          row.playerId
      );

  for (
    const row of
    occupied
  ) {
    const outPlayer =
      players[
        row.playerId
      ];

    if (
      !outPlayer
    ) {
      continue;
    }

    const position =
      playerPosition(
        state,
        team,
        row.playerId
      );

    const current =
      runningScore(
        outPlayer
      );

    const candidates =
      candidateRows({
        state,
        team,
        benchPlan,
        position
      })
        .filter(
          (candidate) =>
            !(
              isBackupCatcher(
                candidate
              ) &&
              position !== "C"
            )
        )
        .map(
          (candidate) => {
            const rawGain =
              runningScore(
                players[
                  candidate.playerId
                ]
              ) -
              current;

            const tactical =
              tacticalBonus(
                candidate,
                benchTags(
                  benchRoles,
                  candidate.playerId
                ),
                "PINCH_RUN"
              );

            return {
              candidate,
              rawGain,
              tactical,
              gain:
                rawGain +
                tactical
            };
          }
        )
        .filter(
          (entry) =>
            entry.gain >=
            pinchRunMinimumGain(
              state,
              diff
            )
        )
        .sort(
          (a, b) =>
            b.gain -
              a.gain ||
            b.rawGain -
              a.rawGain ||
            a.candidate
              .playerId
              .localeCompare(
                b.candidate
                  .playerId
              )
        );

    if (
      candidates.length > 0
    ) {
      const best =
        candidates[0];

      return freeze({
        reason:
          "PINCH_RUN",
        team,
        outPlayerId:
          row.playerId,
        inPlayerId:
          best.candidate
            .playerId,
        position,
        rationale: {
          runningGain:
            Number(
              best.rawGain
                .toFixed(2)
            ),
          tacticalBonus:
            Number(
              best.tactical
                .toFixed(2)
            ),
          base:
            row.base
        }
      });
    }
  }

  return null;
}

function choosePinchHitter({
  state,
  team,
  players,
  benchPlan,
  benchRoles
}) {
  if (
    state.inning < 7
  ) {
    return null;
  }

  const diff =
    scoreDiff(
      state,
      team
    );

  if (
    diff < -3 ||
    diff > 0
  ) {
    return null;
  }

  if (
    alreadyUsedAtCurrentPA(
      state,
      team,
      "PINCH_HIT"
    )
  ) {
    return null;
  }

  const slotIndex =
    state
      .battingOrderIndex
      ?.[team] ?? 0;

  const outPlayerId =
    state
      .lineups
      ?.[team]
      ?.[slotIndex];

  if (
    !outPlayerId
  ) {
    return null;
  }

  const position =
    playerPosition(
      state,
      team,
      outPlayerId
    );

  const pitcherThrows =
    currentPitcherThrows(
      state,
      players
    );

  const currentScore =
    offenseScore(
      players[
        outPlayerId
      ],
      pitcherThrows
    );

  const candidates =
    candidateRows({
      state,
      team,
      benchPlan,
      position
    })
      .filter(
        (candidate) =>
          !(
            isBackupCatcher(
              candidate
            ) &&
            position !== "C"
          )
      )
      .map(
        (candidate) => {
          const rawGain =
            offenseScore(
              players[
                candidate.playerId
              ],
              pitcherThrows
            ) -
            currentScore;

          const tactical =
            tacticalBonus(
              candidate,
              benchTags(
                benchRoles,
                candidate.playerId
              ),
              "PINCH_HIT"
            );

          return {
            candidate,
            rawGain,
            tactical,
            gain:
              rawGain +
              tactical
          };
        }
      )
      .filter(
        (entry) =>
          entry.gain >=
          pinchHitMinimumGain(
            state,
            diff
          )
      )
      .sort(
        (a, b) =>
          b.gain -
            a.gain ||
          b.rawGain -
            a.rawGain ||
          a.candidate
            .playerId
            .localeCompare(
              b.candidate
                .playerId
            )
      );

  if (
    candidates.length === 0
  ) {
    return null;
  }

  const best =
    candidates[0];

  return freeze({
    reason:
      "PINCH_HIT",
    team,
    outPlayerId,
    inPlayerId:
      best.candidate
        .playerId,
    position,
    rationale: {
      offenseGain:
        Number(
          best.rawGain
            .toFixed(2)
        ),
      tacticalBonus:
        Number(
          best.tactical
            .toFixed(2)
        ),
      pitcherThrows
    }
  });
}

function chooseDefensiveReplacement({
  state,
  team,
  players,
  benchPlan,
  benchRoles
}) {
  if (
    state.inning < 8
  ) {
    return null;
  }

  const diff =
    scoreDiff(
      state,
      team
    );

  if (
    diff < 1 ||
    diff > 3
  ) {
    return null;
  }

  const usedThisHalf =
    (
      state.substitutions ??
      []
    ).some(
      (row) =>
        row.team === team &&
        row.reason ===
          "DEFENSIVE_REPLACEMENT" &&
        row.inning ===
          state.inning &&
        row.half ===
          state.half
    );

  if (
    usedThisHalf
  ) {
    return null;
  }

  const pitcherThrows =
    currentPitcherThrows(
      state,
      players
    );

  const options = [];

  for (
    const outPlayerId of
    state.lineups?.[
      team
    ] ?? []
  ) {
    const position =
      playerPosition(
        state,
        team,
        outPlayerId
      );

    if (
      position === "DH"
    ) {
      continue;
    }

    const currentDefense =
      defenseScore(
        players[
          outPlayerId
        ],
        position
      );

    const currentOffense =
      offenseScore(
        players[
          outPlayerId
        ],
        pitcherThrows
      );

    for (
      const candidate of
      candidateRows({
        state,
        team,
        benchPlan,
        position
      })
    ) {
      if (
        isBackupCatcher(
          candidate
        ) &&
        position !== "C"
      ) {
        continue;
      }

      const inPlayer =
        players[
          candidate.playerId
        ];

      const rawDefenseGain =
        defenseScore(
          inPlayer,
          position
        ) -
        currentDefense;

      const offenseCost =
        currentOffense -
        offenseScore(
          inPlayer,
          pitcherThrows
        );

      const tactical =
        tacticalBonus(
          candidate,
          benchTags(
            benchRoles,
            candidate.playerId
          ),
          "DEFENSIVE_REPLACEMENT"
        );

      const totalGain =
        rawDefenseGain +
        tactical;

      if (
        totalGain <
          defenseMinimumGain(
            state
          ) ||
        offenseCost >
          maxDefenseOffenseCost(
            state
          )
      ) {
        continue;
      }

      options.push({
        candidate,
        outPlayerId,
        position,
        rawDefenseGain,
        tactical,
        totalGain,
        offenseCost
      });
    }
  }

  options.sort(
    (a, b) =>
      b.totalGain -
        a.totalGain ||
      a.offenseCost -
        b.offenseCost ||
      a.outPlayerId
        .localeCompare(
          b.outPlayerId
        ) ||
      a.candidate
        .playerId
        .localeCompare(
          b.candidate
            .playerId
        )
  );

  if (
    options.length === 0
  ) {
    return null;
  }

  const best =
    options[0];

  return freeze({
    reason:
      "DEFENSIVE_REPLACEMENT",
    team,
    outPlayerId:
      best.outPlayerId,
    inPlayerId:
      best.candidate
        .playerId,
    position:
      best.position,
    rationale: {
      defenseGain:
        Number(
          best.rawDefenseGain
            .toFixed(2)
        ),
      tacticalBonus:
        Number(
          best.tactical
            .toFixed(2)
        ),
      offenseCost:
        Number(
          clamp(
            best.offenseCost,
            -99,
            99
          ).toFixed(2)
        )
    }
  });
}

function createLateGameBenchManager({
  players = {},
  benchPlans = {}
} = {}) {
  const benchRoles =
    Object.fromEntries(
      Object.entries(
        benchPlans
      ).map(
        ([team, plan]) => [
          team,
          classifyBenchRoles({
            players,
            benchPlan:
              plan ?? []
          })
        ]
      )
    );

  return function lateGameBenchManager({
    state,
    battingTeam,
    fieldingTeam
  }) {
    if (
      !state ||
      state.status !==
        "IN_PROGRESS"
    ) {
      return null;
    }

    const offensePlan =
      benchPlans?.[
        battingTeam
      ] ?? [];

    const defensePlan =
      benchPlans?.[
        fieldingTeam
      ] ?? [];

    if (
      offensePlan.length > 0
    ) {
      const runner =
        choosePinchRunner({
          state,
          team:
            battingTeam,
          players,
          benchPlan:
            offensePlan,
          benchRoles:
            benchRoles[
              battingTeam
            ]
        });

      if (
        runner
      ) {
        return runner;
      }

      const hitter =
        choosePinchHitter({
          state,
          team:
            battingTeam,
          players,
          benchPlan:
            offensePlan,
          benchRoles:
            benchRoles[
              battingTeam
            ]
        });

      if (
        hitter
      ) {
        return hitter;
      }
    }

    if (
      defensePlan.length > 0
    ) {
      const replacement =
        chooseDefensiveReplacement({
          state,
          team:
            fieldingTeam,
          players,
          benchPlan:
            defensePlan,
          benchRoles:
            benchRoles[
              fieldingTeam
            ]
        });

      if (
        replacement
      ) {
        return replacement;
      }
    }

    return null;
  };
}

export {
  offenseScore,
  defenseScore,
  classifyBenchRoles,
  createLateGameBenchManager
};
