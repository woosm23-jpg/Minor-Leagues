# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 체크포인트

- 기능 기준선: **v55 Full Offseason**
- 성능 체크포인트: **v55.1 Performance**
- Save schema: v2
- gameVersion은 v55와 호환 유지
- Complete Edition: 아직 아님

## v55.1 Performance

기능을 줄이지 않고 모바일 체감속도를 개선합니다.

- 월드 Top 100 유망주 read-model 캐시
- 조직 depth/read-model 캐시
- 이미 freeze된 대형 데이터 재귀 복사 방지
- 일반 자동저장을 idle 직렬 큐로 이동
- 일반 동작의 저장 대기 + 중복 렌더 제거
- 수동저장/마일스톤/커리어 이탈은 저장 완료 보장
- cache는 세이브에 포함하지 않음
- 조직/scouting review 시 cache invalidation
- 390x844 브라우저 탭 timing gate

선수 수, 리그 수, 시뮬레이션 정확도는 줄이지 않습니다.

## 다음 단계

v56 Postseason / Awards / History
