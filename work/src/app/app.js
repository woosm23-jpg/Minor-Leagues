import { gameApi } from "../api/gameApi.js";
import { renderQuickAB } from "../ui/render.js";

export function startApp(root) {
  let gameNumber = 1;
  let activeView = "GAME";
  const seedFor = (number) => `THE_CALL_UP_QUICK_AB_V2_GAME_${number}`;
  let snapshot = gameApi.createDemoGame({ seed: seedFor(gameNumber) });

  const render = () => {
    renderQuickAB(root, snapshot, {
      onApproach: (approach) => {
        snapshot = gameApi.playUserPA(snapshot.gameId, approach);
        activeView = "GAME";
        render();
      },
      onView: (view) => {
        activeView = view === "BOX" ? "BOX" : "GAME";
        render();
      },
      onReset: () => {
        gameNumber += 1;
        activeView = "GAME";
        snapshot = gameApi.resetDemoGame(snapshot.gameId, { seed: seedFor(gameNumber) });
        render();
      }
    }, activeView);
  };

  render();
}
