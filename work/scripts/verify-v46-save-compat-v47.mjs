import crypto from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const v46Path='/mnt/data/v46_unzip/THE_CALL_UP_PHASE3_REAL_RATING_INFERENCE_v46/src/api/seasonApi.js';
const v46=(await import(pathToFileURL(v46Path).href)).seasonApi;
const { seasonApi:v47 }=await import('../src/api/seasonApi.js');

function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
function sha(v){return crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');}
function core(payload){const x=structuredClone(payload);delete x.gameVersion;return x;}

let s=v46.createDemoSeason({seed:'v47-save-compat-v46-actual',startDate:'2026-04-01'});
s=v46.simulateToSeasonEnd(s.seasonId);
const oldPayload=v46.serializeSeason(s.seasonId);
assert.equal(oldPayload.gameVersion,'phase3_real_rating_park_league_inference_v46');
const oldCore=sha(core(oldPayload));

const restored=v47.restoreSeason(structuredClone(oldPayload));
const newPayload=v47.serializeSeason(restored.seasonId);
const newCore=sha(core(newPayload));
const second=v47.simulateToSeasonEnd(restored.seasonId);
const secondPayload=v47.serializeSeason(second.seasonId);
const secondCore=sha(core(secondPayload));

const report={
  pass: oldCore===newCore && newCore===secondCore,
  legacyGameVersion:oldPayload.gameVersion,
  upgradedGameVersion:newPayload.gameVersion,
  worldGames:restored.progress.worldLeagueGamesCompleted,
  coreSha256:oldCore,
  restoreCoreSha256:newCore,
  rerunCoreSha256:secondCore,
  corePreserved:oldCore===newCore,
  completedSeasonIdempotent:newCore===secondCore,
  sourceVersionPreserved:newPayload.dataUniverse?.sourceVersion,
  origin:newPayload.dataUniverse?.origin
};
assert.equal(report.worldGames,560);
assert.equal(report.upgradedGameVersion,'phase4_production_world_activation_v47');
assert.equal(report.sourceVersionPreserved,'phase3_real_rating_park_league_inference_v46');
assert.equal(report.origin,'SYNTHETIC_DEV');
assert.equal(report.pass,true);
fs.writeFileSync('reports/v47-v46-save-compat.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
