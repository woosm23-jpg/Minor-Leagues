# THE CALL-UP

모바일 우선 싱글 플레이어 야구 커리어 시뮬레이터 개발 프로젝트입니다.

## 현재 체크포인트

- 성능 기준선: **v55.1 Performance**
- 현재 개발: **Complete Edition 1.0 RELEASE PASS**
- Save schema: v2
- ruleset: `ruleset_2026`
- Complete Edition: **출시 검증 완료**

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


## v57 Draft / International

- 2026 Rule 4 Draft ruleset: 20-round base draft, six-pick lottery shape, official 2026 opening order where available.
- Future draft orders are deterministic from prior-season records/postseason finish using the 2026 CBA lottery shape until a versioned replacement ruleset is installed.
- Draft classes are prepared before the event; the actual draft is processed as the career calendar crosses the draft date.
- International amateur classes use the Jan. 15-Dec. 15 signing window and 2026 club bonus-pool tiers. Pool trading and supplemental/compensation draft picks remain explicit v57 abstractions.
- Signed amateurs enter a bounded Development Reserve because Rookie/Complex levels are abstracted. Opening-Day ecology promotes reserve players into vacancies before using undrafted fallback talent, keeping the active five-level population stable.
- Draft slot never changes ratings. Team AI uses scouted FV/current readiness/risk/age/position/signability with only modest need weight at the top of the draft.
- Save/restore includes amateur classes, draft results, international signings and reserve state.

Next: v58 Retirement / Hall of Fame.


## v58 Retirement / Hall of Fame

- AI retirement remains driven by age, ability, decline, role/opportunity, injury/durability and market context; user retirement is never forced by RNG.
- Career ledger freezes MLB season totals before players leave active rosters. Retired archives keep identity, totals, peak seasons, awards, championships, retirement context and HOF history while dropping active-only state.
- User may announce a final season without ratings boosts and may retire after the season. Retirement report deliberately has no letter grade/tier.
- HOF ruleset_2026: 10 MLB seasons, five full seasons out of MLB before first BBWAA ballot, 75% election, 5% retention, maximum 10 ballot years, maximum 10 selections per voter. Contemporary Era Players cycle is modeled every three years with an eight-player ballot, 16 voters, max three selections and 75% election threshold.
- HOF evaluation uses career value, best-seven-season peak, longevity, milestones, awards, positional/career context and modest postseason contribution; OVR/hidden true ceiling are not voting inputs.

Next: v59 Long-run Stress.


## v59 Long-run Stress

- Production 월드를 2026~2045 정규시즌 20년 동안 실제 멀티레벨 엔진으로 진행한다.
- 시즌마다 postseason → offseason → next season 순환을 검증하고, 총 214,200개의 리그 경기 스케줄을 누적 처리한다.
- 인구/중복 ID/은퇴 archive/HOF/draft·international reserve/future schedule/league stat drift/save payload 성장/성능을 검사한다.
- 5시즌마다 save → restore → save → restore를 반복해 장기 세이브 논리 일관성을 검증한다.

Next: v60 Complete Edition RC.


## v60 Complete Edition RC

- v59의 20시즌 장기 안정성 검증을 기반으로 v60 Complete Edition RC 통합 검증을 완료했습니다.
- Production lifecycle, FULL 저장/복원, 중간시즌 결정론, 모바일 세로 UI, 단일 HTML 검증이 PASS했습니다.
- RC 결과물: `dist/THE_CALL_UP_COMPLETE_EDITION_RC_v60.html`


## Complete Edition 1.0

- 최종 게임 버전: `complete_edition_v1_0`
- 2026 Production MLB/MiLB 월드와 전체 커리어 시스템을 단일 HTML로 통합했습니다.
- v59 20시즌 장기 안정성, v60 RC 통합/저장, RC→정식판 호환, 모바일 세로 UI, 최종 HTML 무결성 검사를 통과했습니다.
- 실행 파일: `dist/THE_CALL_UP_COMPLETE_EDITION.html`
