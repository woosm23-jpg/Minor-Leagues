import { startSeasonApp } from "./app/seasonApp.js";

const root = document.querySelector("#app");
if (!root) throw new Error("#app 루트 요소를 찾을 수 없습니다.");
startSeasonApp(root);
