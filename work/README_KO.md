# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 안정 기준선: **v51 Contracts / Service Time**
- 현재 개발 체크포인트: **v52 40-man / Options / DFA / Waivers**
- 엔진/세이브 gameVersion: `full_career_roster_rules_v52`
- Save schema: v2
- ruleset: `ruleset_2026`
- Complete Edition: 아직 아님

## Production 월드

- MLB / AAA / AA / High-A / A 각 30팀
- 총 150 실존 팀
- 5,429 canonical 선수
- 게임 가능 ACTIVE 선수 4,217명
- 2026 실제 5레벨 일정 10,710경기
- Production 조직 30개

## v52 Roster Rules

- 40-man limit: 40
- 표준 Minor League option years: 3
- optioned minor days 20일 이상이면 해당 시즌 option year 1개 사용
- 같은 시즌에는 option year 최대 1개 소진
- optional assignment는 한 시즌 최대 5회
- out-of-options 선수의 마이너 강등은 waiver/DFA 경로가 필요
- DFA 처리 기한: 7일
- outright waiver claim / clear 상태
- waiver priority helper: 현재 승률 역순, 동률이면 이전 시즌 승률
- AAA↔MLB 이동 판단에 40-man / option 상태 실제 연결
- 실존 선수의 과거 option/40-man 이력은 Snapshot에 없으면 Unknown 유지
- Player → Contract 화면에 40-man / Options / DFA 상태 공개

Rule 5 보호연수 값은 ruleset에 보존하지만 실제 Rule 5 Draft 실행은 오프시즌 시스템에서 연결합니다. 4번째 option year의 예외 자격도 임의 추정하지 않습니다.

## 검증

- 20일 option-year 소진
- 같은 시즌 option-year 중복 소진 방지
- 시즌 6번째 optional assignment 차단
- 7일 DFA deadline
- outright waiver claim / clear
- waiver priority
- 실제 Production AAA→MLB 콜업 시 40-man 등록
- save/restore
- v51 계약/서비스 회귀
- v50.1 Current MVP 통합 회귀
- v50.2 Production data/runtime 회귀
- 2026→2027 전체 시즌 roster-rule rollover
- 모바일 Contract/40-man UI smoke
- Production standalone HTML checkpoint

## 실행 파일

`dist/THE_CALL_UP_SEASON_STANDALONE_v52_PRODUCTION.html`

## 다음 단계

v53에서 arbitration / free agency를 실제 계약 시장과 연결합니다.
