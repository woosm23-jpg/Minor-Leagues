# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 공식 안정 기준선: **v50.1 Current MVP**
- 현재 릴리스 후보: **v50.2 Production RC**
- 엔진/세이브 gameVersion: `phase4_production_world_activation_v47`
- Save schema: v2
- Complete Edition: 아직 아님. 다음 큰 단계는 **v51 Contracts / Service Time**

v50.2는 v50.1의 현재 MVP 회귀 안정성을 유지하면서, Production Snapshot v2의 데이터/런타임 검증, 2026→2027 시즌 롤오버 증거 연속성, 모바일 브라우저 smoke, 문서 동기화, 실행 가능한 Production standalone HTML까지 묶은 RC입니다.

## Production 월드

- MLB / AAA / AA / High-A / A 각 30팀
- 총 150 실존 팀
- 5,429 canonical 선수
- 게임 가능 ACTIVE 선수 4,217명
- 2024~2026 hitting / pitching / fielding 기록 80,606 rows
- 2026 실제 5레벨 일정 10,710경기
  - MLB 2,430
  - AAA 2,250
  - AA 2,070
  - High-A 1,980
  - A 1,980
- MLB 구장 30개
- Production 조직 30개
- 새 커리어 시작일: 2026-03-25

## v50.1 Current MVP 검증

통합 gate에서 다음 6개를 모두 Production Snapshot v2 기준으로 재검증했습니다.

- Organization depth
- 5레벨 승격/강등
- 전체 5레벨 ladder
- AAA→MLB 콜업 / 대체 / MLB 데뷔
- 부상 / 피로 / 폼
- 저장 / 체크포인트 / `.tcu` export-import

또한 v50.1 Production standalone HTML 빌드와 Snapshot v2 내장 정적 검증을 완료했습니다.

## v50.2 Production RC 검증

- Production 데이터/런타임 gate: PASS
- 2026→2027 롤오버 증거 연속성: PASS
  - 2026 월드 경기 10,710 / 10,710 완료
  - 2027 시작일 2027-03-25
  - 2027 새 일정 12,150경기
  - 오프시즌 은퇴 / 생성 82 / 82
  - 저장/복원 PASS
- 모바일 브라우저 smoke:
  - 새 Production 커리어 생성
  - Season Home 진입
  - 자동 저장
  - 7일 진행
  - 중요 이벤트(PRO_DEBUT) 자동 정지
  - page error 0

## 화면 구조

- Home
- Game
- Player
- League
- More
  - Organization / Depth Chart
  - Career Feed
  - Settings / Save

## 실행 파일

`dist/THE_CALL_UP_SEASON_STANDALONE_v50_2_PRODUCTION.html`

GitHub Actions artifact에도 동일 실행 HTML과 v50.2 검증 리포트를 함께 올립니다.

## 다음 단계

v51부터 계약/서비스타임을 시작합니다.

- Contract state data model
- Service-day accrual
- unknown real-player baseline
- save/restore integration
- minimal public contract view
- gate + Production HTML checkpoint
