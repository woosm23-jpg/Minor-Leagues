# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 공식 안정 기준선: **v47 Production World Activation**
- 현재 개발 후보: **v49 RC — 7 Days / Important Event Progress**
- 엔진/세이브 gameVersion: `phase4_production_world_activation_v47`
- Save schema: v2

v49는 v48.1의 Production 새 커리어 저장 핫픽스를 유지하면서, GDD의 빠른 커리어 진행 UX 중 `7일 진행`과 `중요 이벤트까지`를 구현합니다.

## v49 진행 컨트롤

Home:

- 다음 출전
- 경기 시뮬
- 시리즈 시뮬
- 7일 진행
- 중요 이벤트까지

`7일 진행`도 중요 이벤트가 생기면 7일을 채우기 전에 자동으로 멈춥니다.

현재 자동 정지 대상은 이미 런타임에 존재하는 승격/강등, 역할 변경, 프로/MLB 주요 첫 기록, MAJOR/SEASON_ENDING 부상입니다. 아직 구현되지 않은 트레이드·계약·포스트시즌 정지는 v49 범위에 포함하지 않습니다.

## 화면 구조

- Home
- Game
- Player
- League
- More
  - Organization / Depth Chart
  - Career Feed
  - Settings / Save

## Production 월드

- MLB / AAA / AA / High-A / A 각 30팀
- 150 실존 팀
- 5,201 canonical 실존 선수
- 120 affiliations
- 27,985 stat rows
- 10,710 actual schedule rows
- 30 MLB parks

## 실행

`dist/THE_CALL_UP_SEASON_STANDALONE_v49_PRODUCTION.html`

## v49 핵심 검증

- v49 progress tests: 6/6 PASS
- v48 shell UI targeted tests: 3/3 PASS
- v48.1 Production New Career FULL-save regression: PASS
- Production Data Gate: PASS

v47의 전체 회귀 결과는 공식 stable 기준선으로 계속 유지합니다. v49는 Phase 5 수동 확인용 RC입니다.
