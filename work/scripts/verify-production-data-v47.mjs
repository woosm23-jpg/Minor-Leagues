#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createMasterSnapshot, validateMasterSnapshot } from "../src/data/masterSnapshot.js";
import { createSaveUniverseFromMasterSnapshot } from "../src/data/masterSnapshot.js";
import { inferRealWorldUniverse } from "../src/data/realWorldInference.js";
import { validateProductionRuntimeUniverse } from "../src/services/productionSeasonFactory.js";

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const snapshotPath = path.resolve(root, arg("snapshot", "data/master-snapshots/mlb-milb-2026-production.json"));
const outputPath = path.resolve(root, arg("output", "reports/phase4-production-data-gate-v47.json"));
const report = { version:"v47", gate:"FULL_REAL_2026_PRODUCTION_SNAPSHOT", snapshotPath:path.relative(root,snapshotPath), pass:false, reasons:[] };
try {
  if (!fs.existsSync(snapshotPath)) throw new Error(`production snapshot file missing: ${path.relative(root,snapshotPath)}`);
  const raw = JSON.parse(fs.readFileSync(snapshotPath,"utf8"));
  // Round through createMasterSnapshot so normalization/hash behavior is exercised,
  // then require the stored snapshot itself to validate without mutation.
  validateMasterSnapshot(raw,{requireProductionCoverage:true});
  const normalized = createMasterSnapshot({
    metadata:{...raw.metadata,contentHash:undefined}, sources:raw.sources, teams:raw.teams, players:raw.players,
    affiliations:raw.affiliations, stats:raw.stats, schedule:raw.schedule, parks:raw.parks
  });
  if (normalized.metadata.contentHash !== raw.metadata.contentHash) throw new Error(`normalized content hash drift: ${normalized.metadata.contentHash} != ${raw.metadata.contentHash}`);
  const universe = inferRealWorldUniverse(createSaveUniverseFromMasterSnapshot(raw,{copiedAtCareerStart:raw.metadata.snapshotDate,sourceVersion:"phase4_production_world_activation_v47"}));
  validateProductionRuntimeUniverse(universe);
  const levels=["MLB","AAA","AA","HIGH_A","A"];
  report.pass=true;
  report.snapshotId=raw.metadata.snapshotId;
  report.contentHash=raw.metadata.contentHash;
  report.snapshotDate=raw.metadata.snapshotDate;
  report.counts={
    teams:Object.fromEntries(levels.map(level=>[level,raw.teams.filter(t=>t.level===level&&t.active!==false).length])),
    players:Object.fromEntries(levels.map(level=>[level,raw.players.filter(p=>p.level===level&&p.active!==false).length])),
    affiliations:raw.affiliations.length,stats:raw.stats.length,schedule:raw.schedule.length,parks:raw.parks?.length??0,inferencePlayers:universe.inference?.players?.length??0
  };
} catch (error) {
  report.reasons.push(error?.message ?? String(error));
}
fs.mkdirSync(path.dirname(outputPath),{recursive:true});
fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+"\n","utf8");
console.log(JSON.stringify(report,null,2));
if (!report.pass) process.exitCode=1;
