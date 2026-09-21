# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 안정 기준선: **v50.2 Production RC**
- 현재 개발 체크포인트: **v51 Contracts / Service Time**
- 엔진/세이브 gameVersion: `full_career_contracts_service_v51`
- Save schema: v2
- 계약 ruleset: `ruleset_2026`
- Complete Edition: 아직 아님

## Production 월드

- MLB / AAA / AA / High-A / A 각 30팀
- 총 150 실존 팀
- 5,429 canonical 선수
- 게임 가능 ACTIVE 선수 4,217명
- 2024~2026 hitting / pitching / fielding 기록 80,606 rows
- 2026 실제 5레벨 일정 10,710경기
- MLB 구장 30개
- Production 조직 30개

## v50.2 RC 기준

- Current MVP 통합 회귀: PASS
- Production 데이터/런타임: PASS
- 2026→2027 시즌 롤오버: PASS
- 모바일 Production 브라우저 smoke: PASS
- 실행 standalone: `THE_CALL_UP_SEASON_STANDALONE_v50_2_PRODUCTION.html`

## v51 Contracts / Service Time

v51은 Full Career 계약 기반의 첫 단계입니다.

- versioned `ruleset_2026`
- MLB active/MLB IL에 해당하는 서비스 일수 누적을 위한 일 단위 상태
- 마이너리그 체류일은 MLB service에서 제외
- 172 service days = 1 service year
- standard arbitration eligibility = 3 service years
- free agency eligibility = 6 service years
- Super Two 기준 정보는 ruleset에 보존하되 실제 리그 상대 순위 판정/중재 금액은 v53에서 처리
- 2026 MLB minimum salary basis = $780,000
- 세이브 시작 이전 실존 선수 service time은 데이터에 없는 경우 추정하지 않고 `UNKNOWN_REAL_WORLD`로 보존
- 사용자/생성 선수는 세이브 시작부터 정확히 누적
- 기본 contract terms 필드: years / total guarantee / AAV / expected role
- 저장/복원 및 시즌 롤오버에서 contract state 보존
- Player → Contract 탭에 최소 공개 뷰 제공

실존 선수의 과거 service time을 나이/MLB 경력만으로 임의 추정하지 않습니다. 현재 Production Snapshot이 직접 제공하지 않는 과거 계약·서비스 정보는 Unknown으로 표시하고, 세이브 시작 이후의 변화만 정확히 추적합니다.

## v51 검증

- contract/service focused gate
- AAA 시간 service 제외
- AAA→MLB 콜업일부터 service 시작
- 3년/6년 ruleset threshold
- real-player unknown baseline 안전성
- save/restore roundtrip
- 기존 v50.1 Current MVP 통합 회귀
- v50.2 Production data/runtime 회귀
- 2026→2027 전체 시즌 rollover + contract continuity
- 모바일 Contract 탭 browser smoke
- Production standalone HTML checkpoint

## 실행 파일

`dist/THE_CALL_UP_SEASON_STANDALONE_v51_PRODUCTION.html`

## 다음 단계

v52에서 40-man / options / DFA / waivers를 추가합니다. v53에서 arbitration / free agency 시장을 연결합니다.
