import {
  getSeasonEffectivePlayer
} from "./playerSeasonState.js";

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
    return Number(rightValue ?? 50);
  }
  if (side === "L") {
    return Number(leftValue ?? 50);
  }

  return (
    Number(rightValue ?? 50) +
    Number(leftValue ?? 50)
  ) / 2;
}

function hitterProfile(
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
  const rawPower =
    Number(hitting.rawPower ?? 50);
  const vision =
    Number(hitting.vision ?? 50);
  const discipline =
    Number(hitting.discipline ?? 50);
  const speed =
    Number(running.speed ?? 50);
  const baserunning =
    Number(
      running.baserunning ?? speed
    );

  const onBase =
    contact * 0.42 +
    vision * 0.27 +
    discipline * 0.31;

  const power =
    rawPower * 0.56 +
    powerUtilization * 0.44;

  const runningValue =
    speed * 0.62 +
    baserunning * 0.38;

  const overall =
    onBase * 0.45 +
    power * 0.38 +
    runningValue * 0.17;

  return freeze({
    contact,
    onBase,
    power,
    running: runningValue,
    overall
  });
}

function slotScore(
  profile,
  slotIndex
) {
  const slot =
    slotIndex + 1;

  if (slot === 1) {
    return (
      profile.onBase * 0.52 +
      profile.running * 0.30 +
      profile.contact * 0.18
    );
  }
  if (slot === 2) {
    return (
      profile.onBase * 0.44 +
      profile.contact * 0.25 +
      profile.running * 0.17 +
      profile.power * 0.14
    );
  }
  if (slot === 3) {
    return (
      profile.overall * 0.40 +
      profile.onBase * 0.25 +
      profile.power * 0.23 +
      profile.contact * 0.12
    );
  }
  if (slot === 4) {
    return (
      profile.power * 0.52 +
      profile.contact * 0.21 +
      profile.onBase * 0.20 +
      profile.overall * 0.07
    );
  }
  if (slot === 5) {
    return (
      profile.power * 0.42 +
      profile.contact * 0.25 +
      profile.onBase * 0.20 +
      profile.overall * 0.13
    );
  }
  if (slot === 6) {
    return (
      profile.overall * 0.46 +
      profile.contact * 0.24 +
      profile.power * 0.20 +
      profile.onBase * 0.10
    );
  }
  if (slot === 7) {
    return (
      profile.overall * 0.48 +
      profile.contact * 0.24 +
      profile.power * 0.18 +
      profile.running * 0.10
    );
  }
  if (slot === 8) {
    return (
      profile.overall * 0.52 +
      profile.contact * 0.22 +
      profile.onBase * 0.16 +
      profile.running * 0.10
    );
  }

  return (
    profile.onBase * 0.34 +
    profile.running * 0.25 +
    profile.contact * 0.21 +
    profile.overall * 0.20
  );
}

function buildScoreMatrix({
  playerIds,
  roster,
  playerStates,
  opposingPitcher,
  baselineOrder
}) {
  const baselineIndex =
    new Map(
      (baselineOrder ?? [])
        .map(
          (playerId, index) => [
            String(playerId),
            index
          ]
        )
    );

  const profiles = {};

  const matrix =
    playerIds.map(
      (playerId) => {
        const player =
          getSeasonEffectivePlayer(
            roster?.players?.[
              playerId
            ],
            playerStates?.[
              playerId
            ] ?? null
          );

        const profile =
          hitterProfile(
            player,
            opposingPitcher
          );

        profiles[playerId] =
          profile;

        return Array.from(
          { length: 9 },
          (_, slotIndex) => {
            const priorIndex =
              baselineIndex.get(
                String(playerId)
              );

            const stabilityBonus =
              priorIndex === slotIndex
                ? 0.35
                : priorIndex != null &&
                    Math.abs(
                      priorIndex -
                      slotIndex
                    ) === 1
                  ? 0.12
                  : 0;

            return (
              slotScore(
                profile,
                slotIndex
              ) +
              stabilityBonus
            );
          }
        );
      }
    );

  return {
    matrix,
    profiles
  };
}

function solveAssignment(
  playerIds,
  matrix
) {
  const n = playerIds.length;
  const fullMask =
    (1 << n) - 1;

  let dp =
    new Map([
      [
        0,
        {
          score: 0,
          order: []
        }
      ]
    ]);

  for (
    let slotIndex = 0;
    slotIndex < n;
    slotIndex += 1
  ) {
    const next =
      new Map();

    for (
      const [mask, state] of dp
    ) {
      for (
        let playerIndex = 0;
        playerIndex < n;
        playerIndex += 1
      ) {
        const bit =
          1 << playerIndex;

        if (mask & bit) {
          continue;
        }

        const nextMask =
          mask | bit;

        const nextScore =
          state.score +
          matrix[
            playerIndex
          ][slotIndex];

        const nextOrder = [
          ...state.order,
          playerIndex
        ];

        const prior =
          next.get(nextMask);

        const lex =
          nextOrder
            .map(
              (index) =>
                String(
                  playerIds[index]
                )
            )
            .join("|");

        const priorLex =
          prior?.order
            ?.map(
              (index) =>
                String(
                  playerIds[index]
                )
            )
            .join("|");

        if (
          !prior ||
          nextScore >
            prior.score + 1e-9 ||
          (
            Math.abs(
              nextScore -
              prior.score
            ) <= 1e-9 &&
            lex < priorLex
          )
        ) {
          next.set(
            nextMask,
            {
              score:
                nextScore,
              order:
                nextOrder
            }
          );
        }
      }
    }

    dp = next;
  }

  const best =
    dp.get(fullMask);

  if (!best) {
    throw new RangeError(
      "타순 최적화에 실패했습니다."
    );
  }

  return best.order.map(
    (index) =>
      playerIds[index]
  );
}

function buildBattingOrder({
  playerIds,
  roster,
  playerStates = {},
  opposingPitcher = null,
  baselineOrder = null
}) {
  const ids = [
    ...playerIds
  ];

  if (ids.length !== 9) {
    return freeze({
      lineup: ids,
      profiles: {},
      optimized: false
    });
  }

  if (
    new Set(ids).size !==
    ids.length
  ) {
    throw new RangeError(
      "타순 후보 선수 ID가 중복되었습니다."
    );
  }

  for (const id of ids) {
    if (!roster?.players?.[id]) {
      throw new RangeError(
        `타순 후보 선수를 찾을 수 없습니다: ${id}`
      );
    }
  }

  const {
    matrix,
    profiles
  } =
    buildScoreMatrix({
      playerIds: ids,
      roster,
      playerStates,
      opposingPitcher,
      baselineOrder
    });

  const lineup =
    solveAssignment(
      ids,
      matrix
    );

  return freeze({
    lineup,
    profiles,
    optimized: true,
    opponentHand:
      splitSide(
        opposingPitcher
      )
  });
}

export {
  buildBattingOrder
};
