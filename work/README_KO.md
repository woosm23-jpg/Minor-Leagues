# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 버전

- 안정 기준선: **v52 40-man / Options / DFA / Waivers**
- 현재 개발 체크포인트: **v53 Arbitration / Free Agency**
- 엔진/세이브 gameVersion: `full_career_arbitration_free_agency_v53`
- Save schema: v2
- ruleset: `ruleset_2026`
- Complete Edition: 아직 아님

## v53 Arbitration / Free Agency

GDD의 계약시장 설계를 구현합니다.

- standard arbitration: 3~6 service years
- Super Two: 2~3년 사이 서비스타임 상위 22%, 직전 시즌 최소 86일
- tender / non-tender 상태
- final-offer arbitration: 구단 제출액과 선수 제출액 중 하나 선택
- agent strategy: SECURITY / BALANCED / BET ON MYSELF
- FA 시장가치: 미래 기여도, 나이, 내구성, 트랙레코드, 평판, 포지션 수요
- OVR을 달러로 직접 변환하지 않음
- 팀별 need / budget / competitive window / playing-time fit을 반영한 오퍼
- offer fields: years / total guarantee / AAV / expected role
- 오퍼 만료, AAV/term 카운터, 수락
- 2026 Qualifying Offer 메타데이터: $22.025M, 과거 QO 수령 여부와 한 조직 풀시즌 조건
- 2027+ CBA는 2026-09 현재 미확정이므로 실제 미래 규칙이라고 주장하지 않음
- 장기 세이브는 versioned ruleset을 사용하며 새 CBA ruleset이 추가되기 전까지 `ruleset_2026` 시뮬레이션 규칙을 고정
- contract market state 저장/복원
- Player → Contract 화면에 Arbitration / FA / Agent 상태 공개

## 검증

- Super Two cutoff
- standard arbitration
- final-offer hearing
- non-tender → FA
- 3가지 agent strategy 차이
- 30구단 시장 profile 기반 FA offers
- counter / accept
- guaranteed contract terms 반영
- 2026 QO eligibility
- future-CBA unknown guard
- Production 4천명+ market state
- 실존 과거 계약 baseline Unknown 안전성
- v52 roster rules 회귀
- v51 contract/service 회귀
- v50.1 Current MVP 회귀
- Production data/runtime 회귀
- 2026→2027 전체 시즌 market-state rollover
- 모바일 Contract UI smoke
- Production standalone HTML

## 실행 파일

`dist/THE_CALL_UP_SEASON_STANDALONE_v53_PRODUCTION.html`

## 다음 단계

v54에서 Trade System을 구현하며 FA signing과 trade가 실제 조직 이동 transaction layer를 공유하도록 연결합니다.
