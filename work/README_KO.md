# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 체크포인트

- 성능 기준선: **v55.1 Performance**
- 현재 개발: **v56 Postseason / Awards / History**
- Save schema: v2
- ruleset: `ruleset_2026`
- Complete Edition: 아직 아님

## v56 Postseason / Awards / History

정규시즌 종료와 오프시즌 사이에 MLB postseason과 연도 아카이브를 삽입합니다.

- 리그별 6팀, 전체 12팀
- 상위 지구 우승 2팀 first-round bye
- Wild Card 3전 2선승
- Division Series 5전 3선승
- LCS / World Series 7전 4선승
- postseason 26인 roster, 최대 투수 13명
- 정규시즌과 postseason 통계를 분리
- MVP / Cy Young / Silver Slugger / World Series MVP 기록
- Gold Glove는 수비 가치 누적 store가 완성될 때까지 선정 보류
- champion / runner-up / awards / 사용자 postseason 참가 여부를 연도별 history에 저장
- 사용자 조직 우승과 실제 postseason roster 참가 우승을 구분
- 기존 offseason API는 postseason과 history를 자동 확정한 뒤 v55 파이프라인으로 연결

## 다음 단계

v57 Draft / International
