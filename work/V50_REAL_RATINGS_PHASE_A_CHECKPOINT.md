# THE CALL-UP — Real Player Ratings / Phase A Checkpoint

Date: 2026-09-20
Status: **WORK CHECKPOINT — NOT RC / NOT STABLE**

## Baselines preserved

- Official stable: v47 Production World Activation
- Latest verified RC: v49
- v50 remains a work branch
- Existing v1 Production snapshot remains the active runtime data file until the v2 live-data gate passes
- Save schema remains v2; Save Universe schema remains v1

## Final ratings spec baseline

`THE_CALL_UP_REAL_PLAYER_RATINGS_FINAL_SPEC_v1.md`

Implementation is following Section 21 in order. Phase B rating tuning must not start until Phase A live-data validation closes.

## Phase A implemented in this checkpoint

### A1. Master Snapshot v2 schema staging

`src/data/masterSnapshot.js`

- v1 snapshots remain readable and keep their historical content hash behavior.
- New v2 constructor and validation support added.
- Canonical player fields added for v2:
  - organizationId
  - assignedTeamId / assignedLevel
  - rosterStatus / availability
  - on40Man / mlbActive
  - injuryListType / eligibleReturnDate
  - rookieEligibility
  - positions[]
  - rosterEvidence[]
- Stats v2 adds splitContext + sample.
- New v2 containers:
  - tracking[]
  - pitchArsenal[]
  - availabilityEvents[]
- v47-v50 compatibility aliases teamId/level/status are retained on staged v2 players.

### A2. Availability / roster ownership separation

New: `src/data/rosterAvailability.js`

Canonical states:

- ACTIVE
- INJURED_SHORT
- INJURED_60
- INJURED_FULL_SEASON
- REHAB
- DEVELOPMENT_LIST
- RESTRICTED
- TEMP_INACTIVE
- ADMIN_LEAVE
- NOT_REPORTED
- UNKNOWN

Production roster construction now uses assigned team + game availability rather than `active !== false` only.

This fixes the prior behavior where MiLB `Injured 60-Day`, `Development List`, etc. could be auto-loaded into active lineups merely because MLB Stats API person.active was true.

### A3. Multi-team / multi-level aggregation integrity

New: `src/data/statEvidence.js`

- Latest-season evidence no longer silently selects one arbitrary row.
- Same-season team/level segments are aggregated for counting stats.
- Explicit total-row double-count protection exists.
- Innings are aggregated in outs.
- Position experience across multiple positions/seasons is retained.

Current Ability multi-year weighting is intentionally **not** implemented here; that is Phase B.

### A4. Master Snapshot v2 live collector

New: `scripts/fetch_the_call_up_snapshot_v2.py`

Collector design:

- MLB: active + 40Man + fullRoster observations
- MiLB: fullRoster observations
- one canonical player per MLBAM id
- optioned 40-man player may retain MLB ownership while assigned to MiLB
- rehab assignment retains IL evidence
- 2024 + 2025 + 2026 standard stats are retained
- all team/level segments are preserved
- fielding rows generate positions[] experience
- tracking/pitchArsenal remain empty until Phase C

Offline collector self-test: PASS.

### A4.1 Phase A follow-up hardening

After auditing the real 5,201-player v1 production pool, three additional non-active statuses were found and are now fail-closed:

- Taxi Squad
- Military Leave
- Voluntarily Retired List

They map to TEMP_INACTIVE and can no longer become game-available through an unknown-status fallback. Unknown non-empty future statuses also fail closed instead of defaulting to ACTIVE.

Historical standard-stat collection was also changed from sport-wide aggregate calls to teamId-filtered calls. This preserves same-level team segments for traded players. The v2 live validator now fails if same-level multi-team segments are absent or a team-segment stat row has no teamId.

### A5. v2 validation gate + GitHub Action

New:

- `scripts/validate-master-snapshot-v2.mjs`
- `.github/workflows/build-master-snapshot-v2.yml`

Gate checks include:

- schema v2/content hash
- canonical unique player ids
- MLB active / 40-man / IL / optioned-minor coverage
- 2024/2025/2026 stat coverage
- assigned team integrity
- positions[] evidence
- real-world inference creation
- full Production runtime roster/schedule gate

The workflow runs collector -> validator -> focused Phase A regressions -> artifact upload.

## Runtime compatibility changes

`src/services/productionSeasonFactory.js`

- production engine facts now preserve organization/availability/40-man/IL data when available.
- lineup/runtime roster selection excludes unavailable players.

`src/api/seasonApi.js`

- parent organization lookup supports v2 organizationId/assignedTeam fields while preserving v1 behavior.

`src/data/realWorldInference.js`

- latest season now aggregates all same-season team/level stat rows rather than picking one row.
- multi-year empirical shrinkage is still deferred to Phase B.

## Tests

New: `tests/masterSnapshotV2PhaseA.test.js`

Focused Phase A suite:

`npm run verify:snapshot-v2:phase-a`

Result: **18/18 PASS** after follow-up hardening.

Additional core regressions:

- `node scripts/verify-production-runtime-v47.mjs`: PASS
- game/MVP/save/progress focused group: **26/26 PASS**
- Production Top 100 browser smoke after follow-up Phase A build: PASS
  - 100 rows
  - reported veterans absent
  - Diego Velasquez retained
  - real age + parent MLB organization correct
  - Home Career Feed present
  - page errors 0

Production runtime with legacy v1 data still covers all 150 teams after unavailable-status filtering.

## Important deliberate regression update

The old Top 100 regression expected every reported veteran to receive an active season state. That was incorrect for players whose real roster status is unavailable.

Examples in the current v1 snapshot:

- Jihwan Bae — `Injured 60-Day`
- Jakson Reetz — `Development List`

The regression now requires them to stay out of automatic game rosters while still being excluded from Top 100.

## Live-data blocker

The current execution container cannot resolve `statsapi.mlb.com`, and the web fetch tool also rejects direct Stats API URLs. The connected GitHub account currently exposes zero repositories in this chat, so the GitHub Actions workflow could not be dispatched remotely here.

Therefore **Phase A code/gates are complete, but the actual 2026 Master Snapshot v2 has not yet been fetched and validated.**

Do not begin Phase B rating tuning until a live v2 artifact passes `validate-master-snapshot-v2.mjs`.

## Next exact step

1. Run `.github/workflows/build-master-snapshot-v2.yml` in a repository/environment with MLB Stats API access, or run locally where Stats API access works.
2. Retrieve `mlb-milb-2026-production-v2.json` + manifest artifact.
3. Run the v2 validator and inspect roster coverage counts, especially IL / 40-man optioned / rehab.
4. If PASS, copy the v2 snapshot into `data/master-snapshots/` as the staged Production source.
5. Only then begin Phase B: multi-year Current Ability v2.
