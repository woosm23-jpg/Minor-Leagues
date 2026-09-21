# THE CALL-UP v49 RC — Project Manifest

## Primary artifacts

- `dist/THE_CALL_UP_SEASON_STANDALONE_v49_PRODUCTION.html` — preferred real 2026 Production manual-check build
- `START_HERE_NEW_CHAT.md` — handoff entrypoint
- `THE_CALL_UP_v49_CURRENT_STATUS.md` — current candidate state
- `THE_CALL_UP_v49_REGRESSION_REPORT.md` — verification report
- `V49_RELEASE_NOTES.md` — v49 delta

## v49 changed files

- `src/api/seasonApi.js`
- `src/app/seasonApp.js`
- `src/ui/seasonRender.js`
- `styles/app.css`
- `tests/seasonProgressV49.test.js`
- `scripts/browser-production-progress-v49.py`
- `scripts/build-standalone.mjs`
- `package.json`
- v49 status / release / regression documents

## Data baseline unchanged

- Production snapshot: `data/master-snapshots/mlb-milb-2026-production.json`
- content hash: `fnv1a32:5d641237`
- canonical real players: 5,201
- organizations: 30
- teams: 150

## Versioning

Serialized gameVersion remains `phase4_production_world_activation_v47`. Save schema remains v2. v49 progression result state is transient and is not persisted.
