# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 안정 기준선: **v54 Trade System**
- 현재 개발 체크포인트: **v55 Full Offseason**
- 엔진/세이브 gameVersion: `full_career_offseason_pipeline_v55`
- Save schema: v2
- ruleset: `ruleset_2026`
- Complete Edition: 아직 아님

## v55 Full Offseason

정규시즌 종료 뒤 한 번에 다음 시즌으로 점프하던 흐름을 저장 가능한 phase pipeline으로 바꿉니다.

1. Season Review
2. Service / Contract Status
3. Extensions
4. Non-tender / Arbitration
5. Free Agency + Trades
6. Organizational Cleanup
7. Development / Aging
8. Scouting Reevaluation
9. Retirement Decisions
10. Projected Rosters
11. Spring Training
12. Roster Cuts
13. Opening Day

핵심:
- phase 순서 고정
- 처리된 phase 중복 적용 방지
- 오프시즌 중간 저장/복원
- 기존 `advanceToNextSeason()`은 같은 pipeline을 자동 완주
- v53 계약/연봉조정과 v54 trade state 보존
- 기존 development/aging/scouting/retirement/ecology를 Opening Day 원자 rollover에 연결
- 모바일 Home에서 오프시즌 시작/단계 진행 지원
- Save schema v2 유지

Postseason/Awards/History는 v56, Draft/International의 독립 달력 확장은 v57에서 이어집니다.

## 다음 단계

v56 Postseason / Awards / History
