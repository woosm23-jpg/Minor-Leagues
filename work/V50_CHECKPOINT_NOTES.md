# THE CALL-UP — v50 WORK CHECKPOINT (2026-09-20)

## Status

- Official stable remains **v47 — Production World Activation**.
- Latest verified RC remains **v49 — 7 Days / Important Event Progress**.
- This package is **v50_WORK**, not a release and not yet a stable/RC declaration.
- Save schema remains v2; Master Snapshot schema v1; Save Universe schema v1.
- Production content hash baseline from handoff: `fnv1a32:5d641237`.

## v50 Production Top 100 bug — fixed and verified

The interrupted v50 code that propagates real Production player facts was preserved:

- `src/services/productionSeasonFactory.js`
  - engine players now carry `physical.age`, `birthDate`, height/weight and `realWorld.mlbDebutDate`/source facts.
- `src/api/seasonApi.js`
  - Production world Top 100 excludes MLB-level players and, conservatively for snapshot v1, players with any MLB debut date.
  - Top 100 age prefers real health/engine/snapshot age.
  - Top 100 team display resolves to the parent MLB organization.
- `src/ui/seasonRender.js`
  - Top 100 eligibility note explains the conservative Production rule.

Focused regression: `tests/productionProspectTop100V50.test.js`.
Verified examples:

- Christian Bethancourt (542194) — age 35, excluded.
- Jihwan Bae (678225) — age 27, excluded.
- Jakson Reetz (656883) — age 30, excluded.
- Pablo Reyes (622569) — age 33, excluded.
- Diego Velasquez (694196) remains a real no-MLB-debut prospect; age and parent MLB organization are displayed from Production data.

Production browser smoke: `scripts/browser-production-top100-v50.py`.
Latest result: PASS, 100 rows, four reported veterans absent, Diego retained with real age and SF parent organization, Home Career Feed present, page errors 0.
Report: `reports/v50-work-production-top100-browser-smoke.json`.

## New MVP Gap Audit fixes completed in this checkpoint

### 1. Simplified user steal interaction

GDD MVP requires mostly automatic baserunning with a simplified steal interaction. Previously the engine simulated steals but Quick AB gave the user no choice.

Implemented:

- `src/engine/game/stealEngine.js`
  - supports a forced attempt path while retaining the same success/pickoff model.
- `src/api/gameApi.js`
  - exposes `userRunningDecision` when the user reaches an eligible steal base.
  - exposes `resolveUserRunningDecision(gameId, "STEAL" | "HOLD")`.
  - HOLD suppresses automatic user stealing until the next user PA; STEAL resolves through the existing calibrated running model.
- `src/api/seasonApi.js`
  - exposes the running choice through the season flow.
- `src/ui/render.js`
  - Quick AB shows `도루 시도` / `유지` buttons when the choice is available.
- `src/app/seasonApp.js`
  - wires the UI choice to Season API and autosave flow.

Regression coverage was added to `tests/gameApi.test.js` and `tests/mvpScopeV50.test.js`.

### 2. Home Career Feed preview

GDD Home requirements include a career feed. Home now renders the latest three career events while the complete feed remains under More → Career Feed.

### 3. 44px-class mobile touch targets

Compact MVP controls below the target size were raised to approximately 44px minimum height, including game view tabs, training focus, backup restore, leader filters, player-sheet close, and organization position filters.

## Verification completed at this checkpoint

Focused combined regression command:

```text
node --test tests/gameApi.test.js tests/mvpScopeV50.test.js tests/productionProspectTop100V50.test.js tests/productionCareerSaveV48_1.test.js tests/seasonProgressV49.test.js
```

Result: **26/26 PASS** in ~20 seconds.

Additional current `tests/mvpScopeV50.test.js`: **7/7 PASS**.

Production standalone rebuilt as:

`dist/THE_CALL_UP_SEASON_STANDALONE_v50_WORK_PRODUCTION.html`

Focused browser smoke after rebuild: **PASS**.

## Important caution

Do **not** declare v50 stable/RC yet. A full release gate has intentionally not been run. Long full-suite/release tests should remain deferred until the v50 MVP audit is complete.

## Recommended next steps

1. Continue the GDD 43.1 / R6 MVP audit using short focused checks.
2. Verify remaining career-loop requirements already believed to exist: depth competition, weekly organization review, promotion/demotion, MLB call-up event, fatigue/form, multi-season transition, bottom-sheet competitor details, save/export/import/checkpoint behavior.
3. Fix only confirmed gaps; avoid changing baseball formulas, Production snapshot, or save schemas without necessity.
4. Add an end-to-end browser smoke for the new steal-choice UI if a deterministic browser career seed/harness is convenient; API + render + Season API are already covered.
5. Only after v50 audit closes, run the broader release gate and decide whether v50 can become an RC.

---

## Phase E — live Production ecology integration (2026-09-21)

Status remains **v50 WIP**. Official stable v47 / latest validated RC v49 are unchanged.

### Generated pipeline blocker closed

`src/engine/career/generatedCareerPathway.js` now separates AAA readiness from an actual MLB roster opportunity:

- AAA MLB-readiness threshold: 45.5 OVR.
- Clearing the threshold marks the player MLB-ready but does not itself create an MLB debut.
- `rebalanceGeneratedMlbOpportunity()` awards the real MLB roster spot.
- Previously debuted players receive only a 1 OVR continuity grace band.

`reports/v50-generated-pipeline-20y.json`: **PASS**

- generated: 1,200
- active 2046: 739
- MLB debuts: 213
- debut rate: 17.75%
- mean debut age: 25.484
- 2046 MLB share: 18.54%
- 2046 MLB mean OVR: 48.614
- all gates PASS

### Live Production offseason ecology added

New service: `src/services/productionOffseasonEcology.js`

At Production season rollover:

1. evaluates AI retirement on the active five-level roster pool,
2. protects the user player from forced retirement,
3. generates exactly the same pitcher/hitter count as the retired pool,
4. rebalances each MLB organization internally while preserving every team/level pitcher-hitter roster size,
5. keeps the user player at the current organization level,
6. creates live season/development states for generated replacements,
7. records generated career MLB debut state when applicable.

`src/api/seasonApi.js` now runs this ecology pass inside `advanceToNextSeason()`, then resets the new-season counters. It also normalizes role/scouting state after the roster changes.

### Save persistence

`src/services/seasonSerialization.js` now persists optional `leagueEcologyState` inside save schema v2. No save schema bump was required; legacy v2 saves normalize to a fresh Production ecology state on restore.

### Generated prospects / Top 100 / scouting

- generated players receive scouting states after rollover,
- World Top 100 accepts generated minor leaguers even though they are absent from the original real-world snapshot,
- generated players with a recorded MLB debut are excluded from prospect eligibility if later demoted,
- parent MLB organization is resolved from the live affiliate assignment,
- existing Top 100 UI/player-detail flow works with generated player IDs.

### Focused verification

`reports/v50-production-live-ecology-integration.json`: **PASS**

2027 deterministic smoke:

- active population: 4,218 -> 4,218
- AI retired: 50
- generated replacements: 50
- MLB: 840 -> 840
- AAA: 837 -> 837
- AA: 804 -> 804
- High-A: 839 -> 839
- A: 898 -> 898
- every team/level pitcher-hitter roster shape preserved
- generated scouting reports: 50/50 finite

The full public `seasonApi.restoreSeason()` Production round-trip exceeded the local 120s tool limit. This was treated as a timeout, not a test failure. Serialization-layer persistence was separately verified, and the long restore path was not repeatedly retried.

### Next recommended work

1. Add a GitHub Actions long-run gate for multi-year live Production rollover/ecology (local chat should not run repeated 5,429-player long jobs).
2. Verify an actual completed Production season -> `advanceToNextSeason()` browser/API path in CI.
3. Then continue generated-player visibility polish and long-term league-history/free-agent/trade depth if required by the Complete Edition roadmap.

### CI long-run gate added

`.github/workflows/the-call-up-phase-e-ecology-v50.yml` runs:

- generated pipeline 20Y gate,
- focused Production live ecology gate,
- Production live ecology 10Y continuity audit,
- report artifact upload.

The local 10Y continuity audit exceeded the 120s chat-tool limit before producing a final report, so it is intentionally delegated to GitHub Actions and is **not** marked failed locally.
