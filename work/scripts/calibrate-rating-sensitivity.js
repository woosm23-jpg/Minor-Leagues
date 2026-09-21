import { writeFileSync } from "node:fs";
import { calibrationConfig } from "../src/config/calibration.js";
import {
  buildSampledSensitivityMatrix,
  evaluateDeterministicSensitivity,
  SENSITIVITY_RATINGS,
  SENSITIVITY_TOOLS
} from "../src/calibration/ratingSensitivity.js";

function parsePositiveIntegerFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${name} 뒤에는 양의 정수가 필요합니다.`);
  }
  return parsed;
}

const sampleSizePerCell = parsePositiveIntegerFlag("--samples", 20_000);
const matrix = buildSampledSensitivityMatrix({ sampleSizePerCell });
const acceptance = evaluateDeterministicSensitivity(matrix);

const report = {
  schemaVersion: 1,
  reportId: "phase0-rating-sensitivity-v8",
  calibrationId: calibrationConfig.id,
  createdForProject: "2026-09-18",
  methodology: {
    oneFactorAtATime: true,
    neutralRating: 50,
    ratings: SENSITIVITY_RATINGS,
    tools: SENSITIVITY_TOOLS,
    sampleSizePerCell,
    totalPlateAppearances: sampleSizePerCell * SENSITIVITY_RATINGS.length * SENSITIVITY_TOOLS.length,
    note: "각 cell은 해당 tool만 변경하고 나머지 hitter/pitcher/park/defense/approach를 50-vs-50 BALANCED 중립으로 고정한다. 직접 효과 acceptance는 sampling noise가 없는 모델 확률/mean을 사용하고, sampled 결과는 효과 크기와 tail 진단용이다."
  },
  acceptance,
  matrix
};

const json = JSON.stringify(report, null, 2) + "\n";
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const path = process.argv[outputIndex + 1];
  if (!path) throw new Error("--output 뒤에 파일 경로가 필요합니다.");
  writeFileSync(path, json, "utf8");
  console.error(`Sensitivity report written: ${path}`);
} else {
  process.stdout.write(json);
}

if (!acceptance.passed) process.exitCode = 1;
