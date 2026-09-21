function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function levelLabel(level) {
  return level === "HIGH_A" ? "High-A (A+)" : String(level ?? "-");
}

function fmtRate(value) {
  return Number(value ?? 0).toFixed(3).replace(/^0/, "");
}

function fmtPct(value) {
  return Number(value ?? 0).toFixed(3);
}

function dateLabel(iso) {
  if (!iso) return "-";
  const [year, month, day] = iso.split("-").map(Number);
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function tabTitle(tab) {
  if (tab === "PLAYER") return "선수";
  if (tab === "ORG") return "조직";
  if (tab === "LEAGUE") return "리그";
  if (tab === "MORE") return "더보기";
  return "시즌 홈";
}

function topbar(snapshot, tab) {
  return `<header class="season-topbar">
    <div>
      <p class="eyebrow">THE CALL-UP · SINGLE PLAYER SEASON</p>
      <h1 class="season-title">${tabTitle(tab)}</h1>
    </div>
    <div class="date-chip">${dateLabel(snapshot.currentDate)}</div>
  </header>`;
}

function bottomNav(tab) {
  return `<nav class="season-nav" aria-label="시즌 메뉴">
    <button type="button" data-season-tab="HOME" class="${tab === "HOME" ? "active" : ""}"><span>홈</span><small>Home</small></button>
    <button type="button" data-season-action="PLAY"><span>경기</span><small>Game</small></button>
    <button type="button" data-season-tab="PLAYER" class="${tab === "PLAYER" ? "active" : ""}"><span>선수</span><small>Player</small></button>
    <button type="button" data-season-tab="LEAGUE" class="${tab === "LEAGUE" ? "active" : ""}"><span>리그</span><small>League</small></button>
    <button type="button" data-season-tab="MORE" class="${tab === "MORE" ? "active" : ""}"><span>더보기</span><small>More</small></button>
  </nav>`;
}

function recordCard(snapshot) {
  const line = snapshot.userSeasonLine;
  const record = snapshot.record;
  return `<section class="card season-hero">
    <div class="season-hero-head">
      <div><span class="mini-label">${esc(levelLabel(snapshot.currentLevel ?? snapshot.organization?.userLevel ?? "AAA"))} · ${esc(snapshot.userTeam.name)}</span><strong>${record.W}-${record.L}</strong><small>${snapshot.progress.gamesPlayed}/${snapshot.progress.totalGames} 경기</small></div>
      <div class="season-player"><span>${esc(snapshot.userPlayer.name)}</span><strong>${fmtRate(line.AVG)} / ${fmtRate(line.OBP)} / ${fmtRate(line.SLG)}</strong><small>AVG / OBP / SLG</small></div>
    </div>
    <div class="season-stat-grid">
      <div><span>G</span><b>${line.G}</b></div><div><span>REST</span><b>${snapshot.userRole?.restGames ?? 0}</b></div><div><span>H</span><b>${line.H}</b></div>
      <div><span>HR</span><b>${line.HR}</b></div><div><span>RBI</span><b>${line.RBI}</b></div><div><span>SB</span><b>${line.SB}</b></div>
    </div>
  </section>`;
}

function fatigueLabel(band) {
  return ({ FRESH: "상쾌", NORMAL: "보통", TIRED: "피곤", FATIGUED: "누적 피로", EXHAUSTED: "탈진" })[band] ?? "보통";
}

function injuryFamilyLabel(family) {
  return ({ LOWER_BODY:"하체", UPPER_BODY:"상체/팔", HAND_WRIST:"손/손목", BACK_CORE:"허리/코어", HEAD:"머리", GENERAL:"질병/기타" })[family] ?? "부상";
}
function injurySeverityLabel(severity) {
  return ({ DAY_TO_DAY:"데이투데이", MINOR:"경미", MODERATE:"중간", MAJOR:"장기", SEASON_ENDING:"시즌 아웃" })[severity] ?? "부상";
}
function healthSummary(health) {
  const injury = health?.injury;
  if (!injury) return { label:"정상", detail:`내구성 ${health?.durability ?? "-"}` };
  return { label: injurySeverityLabel(injury.severity), detail:`${injuryFamilyLabel(injury.family)} · ${injury.daysRemaining}일` };
}

function formLabel(band) {
  return ({ HOT: "매우 좋음", GOOD: "좋음", NORMAL: "보통", POOR: "저조", COLD: "매우 저조" })[band] ?? "보통";
}

function trainingFocusLabel(focus) {
  return ({
    BALANCED: "균형",
    CONTACT: "컨택트",
    POWER: "파워",
    PLATE_DISCIPLINE: "선구안",
    DEFENSE: "수비",
    SPEED: "스피드"
  })[focus] ?? "균형";
}

function trainingFocusControls(currentFocus) {
  const options = [
    ["CONTACT", "컨택트"],
    ["POWER", "파워"],
    ["PLATE_DISCIPLINE", "선구안"],
    ["DEFENSE", "수비"],
    ["SPEED", "스피드"]
  ];
  return `<div class="training-focus-wrap">
    <div class="training-focus-head"><strong>훈련 집중</strong><span>성장 총량 유지 · 분배 조정</span></div>
    <div class="training-focus-grid">${options.map(([value, label]) => `<button type="button" data-training-focus="${value}" class="${currentFocus === value ? "active" : ""}">${label}</button>`).join("")}</div>
  </div>`;
}

function conditionCard(snapshot) {
  const status = snapshot.userPlayer?.status;
  if (!status) return "";
  const dev = status.development ?? { progress: {}, gains: {} };
  const progress = dev.progress ?? {};
  const gains = dev.gains ?? {};
  const ratings = snapshot.userPlayer.effectiveRatings ?? {};
  const formValue = Math.round((status.form ?? 0) * 100);
  return `<section class="card condition-card">
    <div class="section-head"><strong>컨디션 & 성장</strong><span>${trainingFocusLabel(dev.focus)} 훈련</span></div>
    <div class="condition-grid">
      <div><span>피로</span><b>${fatigueLabel(status.fatigueBand)}</b><small>${Number(status.fatigue ?? 0).toFixed(0)} / 100</small></div>
      <div><span>건강</span><b>${healthSummary(status.health).label}</b><small>${healthSummary(status.health).detail}</small></div>
      <div><span>Form</span><b>${formLabel(status.formBand)}</b><small>${formValue > 0 ? "+" : ""}${formValue}</small></div>
      <div><span>현재 Contact</span><b>${ratings.contactR ?? "-"}</b><small>vs RHP · 경기 컨텍스트</small></div>
      <div><span>현재 Speed</span><b>${ratings.speed ?? "-"}</b><small>피로 반영</small></div>
    </div>
    <div class="development-bars">
      ${[["contact","컨택"],["power","파워 진행"],["vision","비전"],["discipline","선구안"]].map(([key,label]) => {
        const pct = Math.max(0, Math.min(100, Math.round((progress[key] ?? 0) * 100)));
        const gain = gains[key] ?? 0;
        return `<div class="dev-row"><span>${label}${gain > 0 ? ` <em>+${gain}</em>` : ""}</span><div><i style="width:${pct}%"></i></div><small>${pct}%</small></div>`;
      }).join("")}
    </div>
    ${trainingFocusControls(dev.focus ?? "BALANCED")}
    <p class="condition-note">Form과 피로는 일시적인 경기 컨텍스트이며, 숨은 성장률·실제 ceiling은 표시하지 않습니다.</p>
  </section>`;
}

function nextGameCard(snapshot) {
  const userLevel = snapshot.organization?.userLevel ?? "AAA";
  const userLevelSummary = snapshot.organization?.levelSummaries?.find((row) => row.level === userLevel) ?? null;
  if (userLevelSummary && !userLevelSummary.simulated) {
    return `<section class="card next-game-card"><div class="section-head"><strong>${esc(levelLabel(userLevel))} 로스터</strong><span>일정 미연결 레벨</span></div>
      <p class="season-empty">현재 실제 일정은 A / High-A(A+) / AA / AAA / MLB 전체에 연결되어 있습니다. ${esc(levelLabel(userLevel))} 일정 상태를 다시 확인해주세요.</p></section>`;
  }
  const game = snapshot.nextGame;
  if (!game) return `<section class="card next-game-card"><div class="section-head"><strong>정규시즌 종료</strong><span>${snapshot.record.W}-${snapshot.record.L}</span></div><p class="season-empty">테스트 시즌 일정이 모두 끝났습니다.</p></section>`;
  const userHome = game.userSide === "home";
  const user = snapshot.userTeam.shortName;
  const opp = game.opponent.shortName;
  const active = snapshot.activeGame?.status === "IN_PROGRESS" && snapshot.activeScheduleGameId === game.gameId;
  const injury = snapshot.userPlayer?.status?.health?.injury ?? null;
  const healthNote = injury ? `<p class="condition-note"><strong>현재 부상 중</strong> · ${esc(injuryFamilyLabel(injury.family))} / ${esc(injurySeverityLabel(injury.severity))} · 예상 복귀 ${esc(injury.expectedReturnDate)}. 다음 경기 진행 시 복귀 전 팀 경기는 자동 시뮬레이션됩니다.</p>` : "";
  return `<section class="card next-game-card">
    ${healthNote}
    <div class="section-head"><strong>${active ? "진행 중 경기" : "다음 경기"}</strong><span>${dateLabel(game.date)} · ${game.seriesGame}/${game.gamesInSeries}</span></div>
    <div class="matchup-large">
      <div><span>${userHome ? opp : user}</span><strong>${userHome ? "원정" : "콜업"}</strong></div>
      <b>VS</b>
      <div class="right"><span>${userHome ? user : opp}</span><strong>${userHome ? "콜업" : "홈"}</strong></div>
    </div>
    <p class="series-note">${esc(game.opponent.name)} 상대 · ${snapshot.currentSeries?.completed ?? 0}/${snapshot.currentSeries?.total ?? 0} 경기 완료</p>
    <div class="progress-actions">
      <button type="button" class="primary" data-season-action="PLAY">${active ? "경기 계속" : "다음 출전"}</button>
      <button type="button" class="secondary" data-season-action="SIM_GAME">경기 시뮬</button>
      <button type="button" class="secondary" data-season-action="SIM_SERIES">시리즈 시뮬</button>
    </div>
    <div class="time-progress-actions">
      <button type="button" class="secondary" data-season-action="SIM_7_DAYS">7일 진행</button>
      <button type="button" class="secondary" data-season-action="SIM_IMPORTANT">중요 이벤트까지</button>
    </div>
    <p class="condition-note sim-stop-note">7일 진행도 승격·강등·역할 변경·커리어 주요 기록·장기 부상 같은 중요 이벤트가 발생하면 즉시 멈춥니다.</p>
  </section>`;
}

function progressStopCard(snapshot) {
  const result = snapshot.lastProgress;
  if (!result) return "";
  let title = "진행 완료";
  let detail = `${dateLabel(result.startedDate)} → ${dateLabel(result.endedDate)}`;
  if (result.stopReason === "DATE_REACHED") {
    title = "7일 진행 완료";
    detail = `${dateLabel(result.endedDate)}까지 진행 · 월드 경기 ${result.worldGamesSimulated ?? 0}경기 처리`;
  } else if (result.stopReason === "SEASON_END") {
    title = "시즌 종료에서 정지";
    detail = `정규시즌 일정 완료 · 월드 경기 ${result.worldGamesSimulated ?? 0}경기 처리`;
  } else if (result.stopReason === "IMPORTANT_EVENT" && result.stop?.kind === "CAREER_EVENT") {
    title = "중요 이벤트에서 정지";
    detail = `${dateLabel(result.stop.date)} · ${careerEventLabel(result.stop.event)} · ${careerEventDetail(result.stop.event)}`;
  } else if (result.stopReason === "IMPORTANT_EVENT" && result.stop?.kind === "MAJOR_INJURY") {
    const injury = result.stop.injury ?? {};
    title = "장기 부상에서 정지";
    detail = `${dateLabel(result.stop.date)} · ${injuryFamilyLabel(injury.family)} / ${injurySeverityLabel(injury.severity)} · 예상 복귀 ${dateLabel(injury.expectedReturnDate)}`;
  }
  return `<section class="card progress-stop-card"><div class="section-head"><strong>${esc(title)}</strong><span>${result.command === "IMPORTANT_EVENT" ? "Important Event" : "7 Days"}</span></div><p>${esc(detail)}</p></section>`;
}

function recentResults(snapshot) {
  const rows = snapshot.recentResults ?? [];
  return `<section class="card recent-season-card">
    <div class="section-head"><strong>최근 경기</strong><span>최신순</span></div>
    ${rows.length === 0 ? `<p class="season-empty">아직 완료된 경기가 없습니다.</p>` : `<div class="recent-results">${rows.map((game) => `
      <div class="season-result-row">
        <span>${dateLabel(game.date)}</span>
        <b class="${game.result === "W" ? "win" : "loss"}">${game.result}</b>
        <strong>${game.userRuns}-${game.oppRuns}</strong>
        <em>${esc(game.opponent.shortName)}</em>
      </div>`).join("")}</div>`}
  </section>`;
}

function pitchingStaffCard(snapshot) {
  const staff = snapshot.pitchingStaff ?? [];
  const label = (value) => ({ READY: "준비", LIMITED: "주의", UNAVAILABLE: "휴식" })[value] ?? value;
  return `<section class="card pitching-ready-card">
    <div class="section-head"><strong>투수진 준비도</strong><span>경기 간 회복</span></div>
    <div class="pitcher-ready-grid">${staff.map((p) => `<div><span>${esc(p.name)}</span><b>${label(p.availability)}</b><small>${p.role} · 피로 ${Math.round(p.fatigue)}</small></div>`).join("")}</div>
  </section>`;
}

function backupMilestoneLabel(milestone) {
  return ({ OPENING_DAY: "오프닝 데이", OFFSEASON_START: "오프시즌 시작", SEASON_END: "시즌 종료" })[milestone] ?? milestone;
}

function backupRows(uiState = {}) {
  const rows = uiState.backups ?? [];
  if (rows.length === 0) return `<p class="season-empty backup-empty">마일스톤 백업이 아직 없습니다.</p>`;
  return `<div class="backup-list">${rows.map((row) => `<div class="backup-row">
    <div><strong>${esc(backupMilestoneLabel(row.milestone))}</strong><small>${dateLabel(row.currentDate)} · ${esc(row.status)}</small></div>
    <button type="button" class="secondary backup-restore" data-backup-restore="${esc(row.backupId)}">복구</button>
  </div>`).join("")}</div>`;
}

function saveCard(uiState = {}) {
  const message = uiState.saveMessage ? `<p class="save-message">${esc(uiState.saveMessage)}</p>` : "";
  return `<section class="card save-card">
    <div class="section-head"><strong>저장 · 이동</strong><span>IndexedDB · .tcu · v32</span></div>
    <div class="save-actions transfer-actions">
      <button type="button" class="secondary" data-season-action="SAVE">수동 저장</button>
      <button type="button" class="secondary" data-season-action="LOAD">불러오기</button>
      <button type="button" class="secondary" data-season-action="EXPORT">.tcu 내보내기</button>
      <button type="button" class="secondary" data-season-action="IMPORT">.tcu 가져오기</button>
      <button type="button" class="secondary" data-season-action="CAREERS">커리어 목록</button>
    </div>
    <input class="tcu-import-input" type="file" accept=".tcu,application/json,application/vnd.the-call-up+json" data-tcu-import hidden />
    ${message}
    <div class="backup-head"><strong>마일스톤 백업</strong><span>최근 6개 회전 보관</span></div>
    ${backupRows(uiState)}
    <p class="condition-note">오프닝 데이와 시즌 종료 시 자동 백업합니다. 백업 복구와 .tcu 가져오기는 기존 커리어를 덮지 않고 별도 슬롯으로 추가됩니다.</p>
  </section>`;
}

function homeCareerFeedPreview(snapshot) {
  const timeline = snapshot.careerTimeline ?? { totalEvents: 0, events: [] };
  const rows = [...(timeline.events ?? [])].reverse().slice(0, 3);
  return `<section class="card player-detail-card home-career-feed">
    <div class="section-head"><strong>Career Feed</strong><span>최근 ${rows.length} / ${timeline.totalEvents ?? rows.length}</span></div>
    ${rows.length === 0 ? `<p class="season-empty">아직 기록된 커리어 이벤트가 없습니다.</p>` : `<div class="career-timeline-list">${rows.map((event) => `<div class="career-timeline-row importance-${String(event.importance ?? "NORMAL").toLowerCase()}"><span>${dateLabel(event.date)}</span><div><strong>${esc(careerEventLabel(event))}</strong><small>${esc(careerEventDetail(event))}</small></div></div>`).join("")}</div>`}
    <p class="condition-note">최근 커리어 이벤트 3개를 홈에서 바로 보여줍니다. 전체 기록은 더보기 → 커리어에서 확인합니다.</p>
  </section>`;
}

function homeView(snapshot, uiState = {}) {
  const saveStatus = uiState.saveMessage ? `<p class="home-save-status">${esc(uiState.saveMessage)}</p>` : "";
  return `${recordCard(snapshot)}${conditionCard(snapshot)}${roleStatusCard(snapshot)}${pitchingStaffCard(snapshot)}${nextGameCard(snapshot)}${progressStopCard(snapshot)}${homeCareerFeedPreview(snapshot)}${recentResults(snapshot)}${saveStatus}
    <p class="status">다른 팀 경기도 동일한 PA/Game 엔진으로 시뮬레이션되어 순위에 반영됩니다. 조직·전체 커리어 피드·저장 관리는 더보기에서 확인할 수 있습니다.</p>`;
}

function playerSectionNav(section) {
  const tabs = [["RATINGS", "Ratings", "능력"], ["SCOUTING", "Scouting", "스카우팅"], ["STATS", "Stats", "기록"], ["DEVELOPMENT", "Development", "성장"], ["CAREER", "Career", "커리어"]];
  return `<div class="subnav player-subnav" aria-label="선수 상세 메뉴">${tabs.map(([key,en,ko]) => `<button type="button" data-player-section="${key}" class="${section === key ? "active" : ""}"><strong>${ko}</strong><small>${en}</small></button>`).join("")}</div>`;
}

function startingArchetypeLabel(value) {
  return ({
    HIT_FIRST: "컨택 우선", POWER_FIRST: "파워 우선", POWER_SPEED: "파워-스피드", GLOVE_FIRST: "수비 우선",
    ATHLETIC: "운동능력", DISCIPLINE_FIRST: "선구안 우선", RAW_TOOLS: "원석형", BALANCED: "균형형"
  })[value] ?? value ?? "-";
}

function startingTraitLabel(value) {
  return ({
    QUICK_BAT: "빠른 배트", RAW_STRENGTH: "원초적 힘", ADVANCED_APPROACH: "성숙한 어프로치", TWO_STRIKE_HITTER: "투스트라이크 대응",
    PULL_POWER: "당겨치기 파워", ALL_FIELDS_HITTER: "전 방향 타격", FASTBALL_HUNTER: "패스트볼 헌터", BREAKING_BALL_HITTER: "변화구 대응",
    SOFT_HANDS: "부드러운 핸드", QUICK_FIRST_STEP: "빠른 첫발", STRONG_ARM: "강한 어깨", ACCURATE_ARM: "정확한 송구", VERSATILE: "멀티 포지션",
    ELITE_BURST: "폭발적 스타트", AGGRESSIVE_RUNNER: "공격적 주루", SMART_BASERUNNER: "영리한 주루", BASE_STEALER: "도루 감각"
  })[value] ?? value;
}

function bodyTypeLabel(value) {
  return ({ LEAN: "슬림", AVERAGE: "보통", ATHLETIC: "애슬레틱", STURDY: "탄탄", POWER_FRAME: "파워 프레임" })[value] ?? value ?? "-";
}

function playerHeader(player) {
  const line = player.seasonLine ?? {};
  const role = roleLabel(player.role);
  const identity = player.careerProfile?.identity ?? null;
  const bio = identity ? `<small>${esc(identity.nationality)} · ${esc(identity.hometown)} · ${identity.age}세 · ${identity.heightCm}cm / ${identity.weightKg}kg</small>` : "";
  return `<section class="card player-profile-hero">
    <div class="player-profile-head">
      <div><span class="mini-label">${esc(player.team?.name ?? "")}</span><h2>${esc(player.name)}</h2><small>${esc(player.primaryPosition ?? "-")} · ${esc(role ?? "-")} · ${esc(player.bats ?? "-")}/${esc(player.throws ?? "-")}</small>${bio}</div>
      <div class="player-profile-line"><strong>${fmtRate(line.AVG)}</strong><span>AVG</span><small>${line.H ?? 0} H · ${line.HR ?? 0} HR · ${line.RBI ?? 0} RBI</small></div>
    </div>
    ${player.roleState ? `<div class="player-role-strip"><span>역할</span><strong>${esc(roleLabel(player.roleState.role))}</strong><small>${roleMomentumLabel(player.roleState.momentumBand)} · 다음 검토 ${player.roleState.reviewDueInDays === 0 ? "가능" : `${player.roleState.reviewDueInDays}일`}</small></div>` : ""}
  </section>`;
}

function ratingCard(label, key, player) {
  const current = player.ratings?.current?.[key];
  const game = player.ratings?.gameEffective?.[key];
  const changed = Number.isFinite(current) && Number.isFinite(game) && current !== game;
  return `<div class="rating-tile"><span>${esc(label)}</span><b>${current ?? "-"}</b>${changed ? `<small>경기 ${game}</small>` : `<small>현재 능력</small>`}</div>`;
}


function playingTimeBandLabel(band) {
  return ({
    NO_SAMPLE: "출전 전",
    PRIMARY_HEAVY: "주포지션 중심",
    SECONDARY_USED: "세컨더리 기용",
    MULTI_POSITION: "멀티포지션 기용",
    DH_HEAVY: "DH 비중 높음"
  })[band] ?? band ?? "-";
}

function roleUsageBandLabel(band) {
  return ({
    PRIMARY_TRACK: "주포지션 트랙",
    VERSATILITY_USED: "멀티포지션 경험",
    UTILITY_PENDING: "Utility 역할 · 실전 대기",
    UTILITY_EMERGING: "Utility 역할 · 실전 시작",
    UTILITY_ACTIVE: "Utility 역할 · 실제 활용"
  })[band] ?? band ?? "-";
}

function roleFitBandLabel(band) {
  return ({
    NOT_APPLICABLE: "주포지션 역할",
    EVALUATING: "판단 대기",
    DEVELOPING: "역할 실행 중",
    ALIGNED: "역할과 일치",
    USAGE_GAP: "기용 불일치"
  })[band] ?? band ?? "-";
}

function roleFitReasonLabel(code) {
  return ({
    PRIMARY_ROLE_TRACK: "현재 역할은 멀티포지션 기용 평가 대상이 아닙니다.",
    ROLE_USAGE_SAMPLE_BUILDING: "현재 역할에서 실제 기용 표본을 더 확인하고 있습니다.",
    SECONDARY_USAGE_STARTED: "세컨더리 포지션 실전 기용이 시작되었습니다.",
    MULTI_POSITION_USAGE_CONFIRMED: "실제 멀티포지션 기용이 현재 역할과 맞습니다.",
    VERSATILITY_ROLE_NOT_REALIZED: "Utility/Rotation 역할에 비해 세컨더리 실전 기용이 아직 부족합니다."
  })[code] ?? "완료 경기의 실제 포지션 기용을 기준으로 평가합니다.";
}

function playerRatingsView(player) {
  return `<section class="card player-detail-card">
    <div class="section-head"><strong>Ratings</strong><span>20–99 · OVR 미사용</span></div>
    ${player.careerProfile ? `<p class="player-section-label">시작 프로필</p><div class="career-origin-strip"><div><span>유형</span><b>${esc(startingArchetypeLabel(player.careerProfile.archetype))}</b></div><div><span>체형</span><b>${esc(bodyTypeLabel(player.careerProfile.identity?.bodyType))}</b></div><div><span>공개 특성</span><b>${(player.careerProfile.visibleTraits ?? []).length ? (player.careerProfile.visibleTraits ?? []).map(startingTraitLabel).map(esc).join(" · ") : "없음"}</b></div></div>` : ""}
    <p class="player-section-label">타격</p>
    <div class="rating-grid">${[["Contact vs R","contactR"],["Contact vs L","contactL"],["Raw Power","rawPower"],["Vision","vision"],["Discipline","discipline"]].map(([l,k]) => ratingCard(l,k,player)).join("")}</div>
    <p class="player-section-label">주루</p>
    <div class="rating-grid">${[["Speed","speed"],["Stealing","stealing"],["Baserunning","baserunning"]].map(([l,k]) => ratingCard(l,k,player)).join("")}</div>
    <p class="player-section-label">수비</p>
    <div class="rating-grid">${[["Fielding","fielding"],["Reaction","reaction"],["Arm Strength","armStrength"],["Arm Accuracy","armAccuracy"]].map(([l,k]) => ratingCard(l,k,player)).join("")}</div>
    ${player.status?.positionFamiliarity ? `<p class="player-section-label">포지션 친숙도</p><div class="player-rank-grid">${Object.entries(player.status.positionFamiliarity).sort((a,b) => (b[1]-a[1]) || a[0].localeCompare(b[0])).map(([position,value]) => `<div><span>${esc(position)}</span><b>${Math.round(Number(value)*100)}%</b><small>${player.status.positionReps?.[position] ?? 0} G</small></div>`).join("")}</div>` : ""}
    ${player.utilityPathway?.positions?.length ? `<p class="player-section-label">Utility 기용 경로</p><div class="player-rank-grid">${player.utilityPathway.positions.map((row) => `<div><span>${esc(row.position)}</span><b>${row.status === "PRIMARY" ? "주포지션" : row.status === "READY" ? "기용 가능" : row.status === "DEVELOPING" ? "적응 중" : "제한"}</b><small>${Math.round(Number(row.familiarity)*100)}% · ${row.reps ?? 0} G</small></div>`).join("")}</div>` : ""}
    ${player.playingTime ? `<p class="player-section-label">실제 포지션 기용</p><div class="player-rank-grid"><div><span>기용 형태</span><b>${esc(playingTimeBandLabel(player.playingTime.usageBand))}</b><small>${player.playingTime.gamesPlayed} G 기준</small></div><div><span>주포지션</span><b>${Math.round(Number(player.playingTime.primaryShare ?? 0)*100)}%</b><small>${player.playingTime.primaryGames ?? 0} G</small></div><div><span>세컨더리</span><b>${Math.round(Number(player.playingTime.secondaryShare ?? 0)*100)}%</b><small>${player.playingTime.secondaryGames ?? 0} G</small></div><div><span>Role 활용</span><b>${esc(roleUsageBandLabel(player.playingTime.roleUsageBand))}</b><small>실제 출전 기록 기반</small></div></div>` : ""}
    ${player.roleFit ? `<p class="player-section-label">Role Fit 피드백</p><div class="player-rank-grid"><div><span>현재 평가</span><b>${esc(roleFitBandLabel(player.roleFit.fitBand))}</b><small>${esc(roleFitReasonLabel(player.roleFit.reasonCodes?.[0]))}</small></div></div>` : ""}
    <p class="condition-note">표시값은 현재 성장분을 포함합니다. v33부터 직접 백업이 없을 때만 충분히 익숙한 Utility/Rotation 선수가 세컨더리 포지션으로 이동하고, 다른 벤치가 원래 자리를 메우는 2단계 재배치를 사용할 수 있습니다. v34의 기용 비중과 v35 Role Fit은 이미 완료된 경기 기록을 읽는 진단 계층입니다. v35 Role Fit은 라인업·Role·승격 판단을 직접 바꾸지 않습니다. v36은 이미 선택된 선발 9명 안에서만 친숙도·수비·피로·Role 안정성을 반영해 필요한 경우 수비 포지션 배치를 제한적으로 최적화하며 타순은 바꾸지 않습니다. v37은 실제 벤치 선수의 포지션 coverage와 타격·주루·수비 도구를 사용해 접전 후반의 대타·대주자·수비 교체를 공식 substitution으로 처리합니다. v38은 사용자 선수가 포함된 경기는 Detailed 엔진을 유지하고 순수 AI 경기만 Detailed-fit Fast Sim으로 처리하며, 최종 점수를 바로 뽑지 않고 같은 GameState·주루·불펜·교체·공식 기록 흐름을 공유합니다. 낮은 친숙도는 수비 판정에만 불이익을 주며 숨은 적응 성향·내부 기준값·Power Utilization·성장 ceiling은 노출하지 않습니다.</p>
  </section>`;
}

function rankChip(label, rank) {
  return `<div><span>${esc(label)}</span><b>${rank ? `#${rank}` : "—"}</b></div>`;
}

function playerStatsView(player, leaders) {
  const line = player.seasonLine ?? {};
  const ranks = player.leaderRanks ?? {};
  return `<section class="card player-detail-card">
    <div class="section-head"><strong>시즌 기록</strong><span>${line.G ?? 0} G · ${line.PA ?? 0} PA</span></div>
    <div class="player-rate-grid">
      <div><span>AVG</span><b>${fmtRate(line.AVG)}</b></div><div><span>OBP</span><b>${fmtRate(line.OBP)}</b></div><div><span>SLG</span><b>${fmtRate(line.SLG)}</b></div><div><span>OPS</span><b>${fmtRate(line.OPS)}</b></div>
    </div>
    <div class="table-scroll"><table class="player-stat-table"><thead><tr><th>G</th><th>PA</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>SO</th><th>SB</th><th>CS</th></tr></thead>
      <tbody><tr><td>${line.G ?? 0}</td><td>${line.PA ?? 0}</td><td>${line.AB ?? 0}</td><td>${line.R ?? 0}</td><td>${line.H ?? 0}</td><td>${line.doubles ?? 0}</td><td>${line.triples ?? 0}</td><td>${line.HR ?? 0}</td><td>${line.RBI ?? 0}</td><td>${line.BB ?? 0}</td><td>${line.SO ?? 0}</td><td>${line.SB ?? 0}</td><td>${line.CS ?? 0}</td></tr></tbody></table></div>
    <div class="section-head player-rank-head"><strong>리그 순위</strong><span>규정 ${leaders?.qualificationPA ?? 0} PA</span></div>
    <div class="player-rank-grid">${[["AVG",ranks.AVG],["OPS",ranks.OPS],["HR",ranks.HR],["RBI",ranks.RBI],["SB",ranks.SB]].map(([l,r]) => rankChip(l,r)).join("")}</div>
    ${player.seasonLinesByLevel ? `<div class="level-stat-split">${["A","HIGH_A","AA","AAA","MLB"].map((level) => { const row = player.seasonLinesByLevel[level] ?? {}; return `<div><span>${esc(levelLabel(level))}</span><strong>${row.G ?? 0} G · ${row.H ?? 0} H · ${row.HR ?? 0} HR</strong><small>${fmtRate(row.AVG)} AVG · ${fmtRate(row.OPS)} OPS</small></div>`; }).join("")}</div>` : ""}
    <p class="condition-note">현재 레벨 리그 순위와 레벨별 정규시즌 기록을 분리해 표시합니다. AVG/OBP/SLG/OPS 순위는 규정 타석을 충족한 선수만 집계합니다.</p>
  </section>`;
}

function developmentRows(status) {
  const progress = status?.development?.progress ?? {};
  const gains = status?.development?.gains ?? {};
  const tools = [["contact","컨택트"],["power","파워 진행"],["vision","비전"],["discipline","선구안"],["defense","수비"],["speed","스피드"]];
  return tools.map(([key,label]) => {
    const pct = Math.max(0, Math.min(100, Math.round((progress[key] ?? 0) * 100)));
    const gain = gains[key] ?? 0;
    return `<div class="dev-row"><span>${label}${gain > 0 ? ` <em>+${gain}</em>` : ""}</span><div><i style="width:${pct}%"></i></div><small>${pct}%</small></div>`;
  }).join("");
}

function playerDevelopmentView(player) {
  const status = player.status ?? {};
  const formValue = Math.round((status.form ?? 0) * 100);
  return `<section class="card player-detail-card">
    <div class="section-head"><strong>Development</strong><span>${trainingFocusLabel(status.development?.focus)} 훈련</span></div>
    <div class="condition-grid compact-condition-grid">
      <div><span>피로</span><b>${fatigueLabel(status.fatigueBand)}</b><small>${Number(status.fatigue ?? 0).toFixed(0)} / 100</small></div>
      <div><span>건강</span><b>${healthSummary(status.health).label}</b><small>${healthSummary(status.health).detail}</small></div>
      <div><span>Form</span><b>${formLabel(status.formBand)}</b><small>${formValue > 0 ? "+" : ""}${formValue}</small></div>
    </div>
    <div class="development-bars full-development-bars">${developmentRows(status)}</div>
    ${trainingFocusControls(status.development?.focus ?? "BALANCED")}
    <p class="condition-note">진행 바는 누적 성장 progress입니다. 훈련 집중은 성장 총량을 늘리지 않고 분배만 바꿉니다. 숨은 Development Rate와 실제 ceiling은 표시하지 않습니다.</p>
  </section>`;
}


function careerEventLabel(event) {
  if (event.type === "CAREER_STARTED") return "커리어 시작";
  if (event.type === "LEVEL_ASSIGNED") return `${levelLabel(event.toLevel ?? event.level)} 첫 배정`;
  if (event.type === "PLAYER_PROMOTED") return `승격 · ${levelLabel(event.fromLevel)} → ${levelLabel(event.toLevel)}`;
  if (event.type === "PLAYER_DEMOTED") return `강등 · ${levelLabel(event.fromLevel)} → ${levelLabel(event.toLevel)}`;
  if (event.type === "ROLE_CHANGED") return `역할 변경 · ${roleLabel(event.fromRole)} → ${roleLabel(event.toRole)}`;
  if (event.type === "PRO_DEBUT") return "프로 데뷔";
  if (event.type === "MLB_DEBUT") return "MLB 데뷔";
  if (event.type === "FIRST_MLB_HIT") return "첫 MLB 안타";
  if (event.type === "FIRST_MLB_HR") return "첫 MLB 홈런";
  if (event.type === "FIRST_MLB_RBI") return "첫 MLB 타점";
  if (event.type === "FIRST_MLB_SB") return "첫 MLB 도루";
  return event.type;
}

function basesSituationLabel(bases) {
  if (!bases) return null;
  const occupied = [bases.first ? "1" : null, bases.second ? "2" : null, bases.third ? "3" : null].filter(Boolean);
  return occupied.length ? `${occupied.join("·")}루` : "주자 없음";
}

function careerGameContextDetail(event) {
  const context = event.gameContext;
  if (!context) return "";
  const parts = [];
  if (context.opponentTeamName) parts.push(`vs ${context.opponentTeamName}`);
  if (context.inning && context.half) parts.push(`${context.inning}회${context.half === "TOP" ? "초" : "말"}`);
  if (context.paNumber) parts.push(context.phase === "PRE_PA" ? `PA #${context.paNumber} 전` : `PA #${context.paNumber}`);
  const situation = basesSituationLabel(context.basesBefore);
  if (context.outsBefore !== null && context.outsBefore !== undefined) parts.push(`${context.outsBefore === 0 ? "무사" : `${context.outsBefore}사`}${situation ? ` ${situation}` : ""}`);
  else if (situation) parts.push(situation);
  if (context.scoreBefore && context.userSide) {
    const beforeUser = context.scoreBefore[context.userSide];
    const beforeOpp = context.scoreBefore[context.userSide === "away" ? "home" : "away"];
    if (context.scoreAfter) {
      const afterUser = context.scoreAfter[context.userSide];
      const afterOpp = context.scoreAfter[context.userSide === "away" ? "home" : "away"];
      parts.push(beforeUser !== afterUser || beforeOpp !== afterOpp ? `점수 ${beforeUser}-${beforeOpp} → ${afterUser}-${afterOpp}` : `점수 ${beforeUser}-${beforeOpp}`);
    } else parts.push(`점수 ${beforeUser}-${beforeOpp}`);
  }
  return parts.join(" · ");
}

function careerEventDetail(event) {
  const contextual = (base) => [base, careerGameContextDetail(event)].filter(Boolean).join(" · ");
  if (event.type === "CAREER_STARTED") return `${levelLabel(event.level)} 레벨에서 시작`;
  if (event.type === "LEVEL_ASSIGNED") return "초기 조직 배정";
  if (event.type === "ROLE_CHANGED") return `${levelLabel(event.level)} · 조직 역할 검토`;
  if (event.type === "PRO_DEBUT") return contextual(`${levelLabel(event.level)} 공식 경기 첫 출전`);
  if (event.type === "MLB_DEBUT") return contextual("메이저리그 공식 경기 첫 출전");
  if (event.type === "FIRST_MLB_HIT") return contextual(`MLB 공식 기록 · ${event.statValue ?? 1}안타 경기`);
  if (event.type === "FIRST_MLB_HR") return contextual(`MLB 공식 기록 · ${event.statValue ?? 1}홈런 경기`);
  if (event.type === "FIRST_MLB_RBI") return contextual(`MLB 공식 기록 · ${event.statValue ?? 1}타점 경기`);
  if (event.type === "FIRST_MLB_SB") return contextual(`MLB 공식 기록 · ${event.statValue ?? 1}도루 경기`);
  const pos = event.position ? ` · ${event.position}` : "";
  return `${levelLabel(event.toLevel ?? event.level)}${pos}`;
}

function careerTimelineView(snapshot) {
  const timeline = snapshot.careerTimeline ?? { totalEvents: 0, events: [] };
  const rows = timeline.events ?? [];
  return `<section class="card player-detail-card career-timeline-card">
    <div class="section-head"><strong>Career Timeline</strong><span>${timeline.totalEvents ?? rows.length} events</span></div>
    ${rows.length === 0 ? `<p class="season-empty">아직 기록된 커리어 이벤트가 없습니다.</p>` : `<div class="career-timeline-list">${rows.map((event) => `<div class="career-timeline-row importance-${String(event.importance ?? "NORMAL").toLowerCase()}"><span>${dateLabel(event.date)}</span><div><strong>${esc(careerEventLabel(event))}</strong><small>${esc(careerEventDetail(event))}</small></div></div>`).join("")}</div>`}
    <p class="condition-note">승격·강등·배정·역할 변경과 프로/MLB 첫 기록은 확정된 상태 변화 또는 공식 경기 기록에서만 Career Event로 저장됩니다. legacy 세이브에서 정확한 날짜를 알 수 없는 과거 첫 기록은 임의로 만들어내지 않습니다.</p>
  </section>`;
}

function scoutingConfidenceLabel(value) { return ({ LOW: "낮음", FAIR: "보통", GOOD: "좋음", HIGH: "높음" })[value] ?? value ?? "-"; }
function scoutingRiskLabel(value) { return ({ LOW: "낮음", MEDIUM: "보통", HIGH: "높음", EXTREME: "매우 높음" })[value] ?? value ?? "-"; }
function scoutingEtaLabel(value) { return ({ MLB_READY: "MLB 준비", "1_YEAR": "약 1년", "2_YEARS": "약 2년", "3_PLUS_YEARS": "3년+" })[value] ?? value ?? "-"; }
function scoutingToolLabel(value) { return ({ contact: "컨택트", power: "파워", vision: "비전", discipline: "선구안", defense: "수비", speed: "스피드", stuff: "구위", command: "커맨드", movement: "무브먼트", control: "제구", pitchability: "피칭 감각", stamina: "스태미나", velocity: "구속" })[value] ?? value; }
function gradeRange(row) { return row ? `${row.grade} (${row.range?.low ?? row.grade}–${row.range?.high ?? row.grade})` : "-"; }

function playerScoutingView(player) {
  const report = player.scouting;
  if (!report) return `<section class="card player-detail-card"><p class="season-empty">스카우팅 리포트가 없습니다.</p></section>`;
  const currentConfidence = report.currentConfidence ?? report.confidence;
  const futureConfidence = report.futureConfidence ?? report.confidence;
  return `<section class="card player-detail-card scouting-card">
    <div class="section-head"><strong>Scouting Report</strong><span>20–80 · 추정치</span></div>
    <div class="player-rank-grid"><div><span>현재 평가</span><b>${report.currentGrade}</b><small>현재 신뢰 ${esc(scoutingConfidenceLabel(currentConfidence))}</small></div><div><span>Future Value</span><b>${report.futureValue}</b><small>${report.futureValueRange.low}–${report.futureValueRange.high} · 미래 신뢰 ${esc(scoutingConfidenceLabel(futureConfidence))}</small></div><div><span>업데이트</span><b>${report.observations ?? 0}회</b><small>Scouting Review</small></div><div><span>위험도</span><b>${esc(scoutingRiskLabel(report.risk))}</b><small>Risk</small></div><div><span>ETA</span><b>${esc(scoutingEtaLabel(report.eta))}</b><small>준비도 기준</small></div><div><span>Pathway</span><b>${esc(pathwayLabel(report.pathway))}</b><small>자리 상황 별도</small></div></div>
    <div class="table-scroll"><table class="player-stat-table"><thead><tr><th>Tool</th><th>현재</th><th>미래</th></tr></thead><tbody>${Object.entries(report.tools ?? {}).map(([tool,row]) => `<tr><th>${esc(scoutingToolLabel(tool))}</th><td>${esc(gradeRange(row.current))}</td><td>${esc(gradeRange(row.future))}</td></tr>`).join("")}</tbody></table></div>
    <p class="condition-note">Future Value와 미래 툴은 숨은 ceiling 자체가 아니라 스카우팅 추정치입니다. 관찰이 늘면 범위와 confidence가 개선될 수 있지만, 실제 성장 경로는 breakout·stagnation·bust와 노화 때문에 달라질 수 있습니다. ETA는 MLB 준비도이며 조직의 자리가 열려 있는지는 Pathway로 따로 표시합니다.</p>
  </section>`;
}

function playerView(snapshot, uiState = {}) {
  const section = uiState.playerSection ?? "RATINGS";
  const player = snapshot.userPlayer;
  const body = section === "SCOUTING" ? playerScoutingView(player)
    : section === "STATS" ? playerStatsView(player, snapshot.leaders)
      : section === "DEVELOPMENT" ? playerDevelopmentView(player)
        : section === "CAREER" ? careerTimelineView(snapshot)
          : playerRatingsView(player);
  return `${playerHeader(player)}${playerSectionNav(section)}${body}
    <section class="card player-future-card"><strong>Contract</strong><p>계약·서비스타임·FA·트레이드 이력은 이후 Full Career 단계에서 연결합니다. v31부터 Career First에는 가능한 경우 상대·이닝·PA 번호·아웃/주자·당시 점수까지 공식 경기 이벤트 문맥을 함께 영속 기록합니다.</p></section>`;
}

function standingsTable(snapshot) {
  return `<section class="card standings-card">
    <div class="section-head"><strong>${esc(levelLabel(snapshot.currentLevel ?? "AAA"))} DEV 8 순위</strong><span>${snapshot.progress.leagueGamesCompleted}/${snapshot.progress.leagueGamesTotal} 경기</span></div>
    <div class="table-scroll"><table class="standings-table">
      <thead><tr><th>#</th><th>팀</th><th>W</th><th>L</th><th>PCT</th><th>RD</th></tr></thead>
      <tbody>${snapshot.standings.map((row) => `<tr class="${row.teamId === snapshot.userTeam.id ? "user-row" : ""}">
        <td>${row.rank}</td><th>${esc(row.team.shortName)}</th><td>${row.W}</td><td>${row.L}</td><td>${fmtPct(row.pct)}</td><td>${row.runDiff > 0 ? "+" : ""}${row.runDiff}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </section>`;
}

function leagueSectionNav(section) {
  return `<div class="subnav league-subnav" aria-label="리그 메뉴">
    <button type="button" data-league-section="STANDINGS" class="${section === "STANDINGS" ? "active" : ""}"><strong>순위</strong><small>Standings</small></button>
    <button type="button" data-league-section="LEADERS" class="${section === "LEADERS" ? "active" : ""}"><strong>리더</strong><small>Leaders</small></button>
    <button type="button" data-league-section="PROSPECTS" class="${section === "PROSPECTS" ? "active" : ""}"><strong>유망주</strong><small>Top 100</small></button>
  </div>`;
}

function leaderValue(category, row) {
  return category?.format === "RATE" ? fmtRate(row.value) : String(row.value ?? 0);
}

function leaderRows(category, rows, userId) {
  if (!rows?.length) return `<p class="season-empty">아직 집계할 표본이 없습니다.</p>`;
  return `<div class="leader-list">${rows.map((row) => `<button type="button" class="leader-row ${row.id === userId ? "user-leader-row" : ""}" data-player-detail="${esc(row.id)}">
    <span class="leader-rank">${row.rank}</span><span class="leader-name"><strong>${esc(row.name)}</strong><small>${esc(row.team?.shortName ?? "")} · ${esc(row.primaryPosition ?? "-")}${row.active ? " · ACTIVE" : ""}</small></span><b>${leaderValue(category,row)}</b>
  </button>`).join("")}</div>`;
}

function leagueLeaders(snapshot, uiState = {}) {
  const leaders = snapshot.leaders ?? {};
  const selected = uiState.leaderCategory && leaders.categories?.[uiState.leaderCategory] ? uiState.leaderCategory : "OPS";
  const category = leaders.categories?.[selected] ?? null;
  const order = leaders.categoryOrder ?? [];
  const userRank = category?.userRank ?? null;
  const qualifierText = category?.qualificationRequired ? `규정 ${category.qualificationPA} PA` : "누적 기록";
  const userStatus = category?.qualificationRequired && userRank === null ? "규정 타석 미달" : userRank ? `내 순위 #${userRank}` : "아직 기록 없음";
  return `<section class="card leader-page-card">
    <div class="section-head"><strong>타격 리더</strong><span>${qualifierText}</span></div>
    <div class="leader-category-grid">${order.map((key) => `<button type="button" data-leader-category="${key}" class="${selected === key ? "active" : ""}">${esc(leaders.categories?.[key]?.label ?? key)}</button>`).join("")}</div>
    <div class="leader-page-head"><strong>${esc(category?.label ?? selected)}</strong><span>${esc(userStatus)}</span></div>
    ${leaderRows(category, category?.top ?? [], snapshot.userPlayer.id)}
    ${category?.neighborhood?.length ? `<div class="local-rank-wrap"><div class="section-head"><strong>내 주변 순위</strong><span>상위권 밖에서도 현재 위치 표시</span></div>${leaderRows(category, category.neighborhood, snapshot.userPlayer.id)}</div>` : ""}
    <p class="condition-note">리더 행을 누르면 현재 능력과 시즌 성적을 빠르게 확인할 수 있습니다.</p>
  </section>`;
}

function roleLabel(role) {
  return ({
    STARTER: "주전",
    PLATOON: "플래툰",
    ROTATION: "로테이션",
    BENCH: "벤치",
    UTILITY: "유틸리티",
    CALL_UP_DEPTH: "콜업 대기",
    AAA_STARTER: "AAA 주전",
    SP: "선발",
    RP: "불펜",
    CL: "마무리",
    ROSTER: "로스터"
  })[role] ?? role ?? "-";
}

function roleMomentumLabel(band) {
  return ({ RISING: "상승", STEADY: "안정", FALLING: "하락" })[band] ?? "안정";
}

function readinessLabel(value) {
  return ({ MLB_READY: "MLB 준비", READY: "상위 레벨 준비", NEAR: "근접", DEVELOPING: "성장 중" })[value] ?? "평가 중";
}
function pathwayLabel(value) {
  return ({ CLEAR: "경로 열림", COMPETITIVE: "경쟁", BLOCKED: "막힘" })[value] ?? "평가 중";
}
function orgReasonLabel(code) {
  return ({
    CURRENT_ABILITY: "현재 기량",
    AAA_RECENT_PERFORMANCE: "AAA 최근 성적",
    MLB_ROSTER_NEED: "MLB 로스터 필요",
    ROLE_MOMENTUM: "역할 상승세",
    FATIGUE_MANAGEMENT: "피로 관리",
    BLOCKED_BY_ESTABLISHED_STARTER: "상위 포지션 경쟁",
    AAA_EVERYDAY_PLAYING_TIME: "AAA 꾸준한 출전 선호",
    MLB_RECENT_STRUGGLES: "MLB 최근 성적",
    AAA_REPLACEMENT_READY: "AAA 대체 후보 준비",
    AAA_REPLACEMENT_PERFORMANCE: "AAA 대체 후보 성적",
    ROLE_MOMENTUM_FALLING: "역할 하락세",
    TRANSACTION_STABILITY: "이동 후 안정화",
    MLB_ROLE_STABILITY: "MLB 역할 안정성",
    PITCHER_CURRENT_ABILITY: "현재 투구 기량",
    AAA_PITCHING_PERFORMANCE: "AAA 최근 투구",
    MLB_PITCHING_STRUGGLES: "MLB 최근 투구",
    MLB_ROTATION_NEED: "MLB 선발진 필요",
    MLB_BULLPEN_NEED: "MLB 불펜 필요",
    PITCHER_WORKLOAD: "투수 workload 관리",
    PITCHER_ROLE_STABILITY: "투수 역할 안정성",
    AAA_PITCHER_READY: "AAA 대체 투수 준비",
    ROTATION_DEPTH: "선발 Depth",
    BULLPEN_DEPTH: "불펜 Depth",
    LOWER_LEVEL_RECENT_PERFORMANCE: "현재 레벨 최근 성적",
    UPPER_LEVEL_RECENT_STRUGGLES: "상위 레벨 최근 성적",
    UPPER_LEVEL_DEPTH_NEED: "상위 레벨 뎁스 필요",
    LOWER_LEVEL_REPLACEMENT_READY: "하위 레벨 대체 후보 준비",
    LOWER_LEVEL_REPLACEMENT_PERFORMANCE: "하위 레벨 대체 후보 성적",
    UPPER_LEVEL_ROLE_STABILITY: "상위 레벨 역할 안정성",
    DEVELOPMENT_PATH_STABILITY: "현재 레벨 꾸준한 출전",
    LOWER_LEVEL_PITCHING_PERFORMANCE: "현재 레벨 최근 투구",
    UPPER_LEVEL_PITCHING_STRUGGLES: "상위 레벨 최근 투구",
    LOWER_LEVEL_PITCHER_READY: "하위 레벨 대체 투수 준비"
  })[code] ?? code;
}

function roleStatusCard(snapshot) {
  const assignment = snapshot.userRole?.assignment;
  if (!assignment) return "";
  const blocker = snapshot.organization?.pathway?.blockedBy ?? null;
  const trajectory = assignment.momentumBand === "RISING"
    ? "최근 경기 내용이 현재 역할 경쟁에 긍정적입니다."
    : assignment.momentumBand === "FALLING"
      ? "최근 경기 내용이 역할 경쟁에 부담을 주고 있습니다."
      : "현재 역할이 안정적으로 유지되고 있습니다.";
  return `<section class="card role-status-card">
    <div class="section-head"><strong>역할 상태</strong><span>${esc(levelLabel(assignment.level))} · ${roleMomentumLabel(assignment.momentumBand)}</span></div>
    <div class="role-status-grid">
      <div><span>현재 역할</span><b>${esc(roleLabel(assignment.role))}</b><small>${assignment.daysInRole}일 유지</small></div>
      <div><span>실제 기용</span><b>${esc(playingTimeBandLabel(snapshot.userRole?.playingTime?.usageBand))}</b><small>${snapshot.userRole?.playingTime?.secondaryGames ?? 0} G 세컨더리</small></div>
      <div><span>Role Fit</span><b>${esc(roleFitBandLabel(snapshot.userRole?.roleFit?.fitBand))}</b><small>${esc(roleFitReasonLabel(snapshot.userRole?.roleFit?.reasonCodes?.[0]))}</small></div>
      <div><span>다음 검토</span><b>${assignment.reviewDueInDays === 0 ? "검토 가능" : `${assignment.reviewDueInDays}일`}</b><small>${assignment.reviews}회 검토 완료</small></div>
    </div>
    <p class="condition-note">${esc(trajectory)}${blocker ? ` 상위 레벨 ${esc(snapshot.organization.userPosition)}에는 ${esc(blocker.name)}이(가) 있어 포지션 경쟁도 함께 고려됩니다.` : ""} 역할 검토는 매일이 아니라 주기적으로 이루어집니다. Role Fit은 v35부터 설명용 진단이며 실제 역할 변경 입력으로 사용하지 않습니다. v36 포지션 배치는 선발 9명 선택 뒤의 제한적 최적화로, 타순이나 승격 판단을 바꾸지 않습니다. v37 후반 벤치 AI도 OVR이 아니라 실제 coverage와 타격·주루·수비 도구를 사용합니다. v38에서는 순수 AI 일정만 Detailed-fit Fast Sim을 사용하고 사용자 경기와 공식 기록 흐름은 Detailed 엔진 기준을 유지합니다.</p>
  </section>`;
}

function organizationLevelStrip(organization) {
  return `<section class="card org-level-card">
    <div class="section-head"><strong>${esc(organization.name)}</strong><span>현재 ${esc(levelLabel(organization.userLevel))}</span></div>
    <div class="org-level-strip">${organization.levelSummaries.map((row) => `<div class="org-level-node ${row.isUserLevel ? "active" : ""}">
      <span>${esc(levelLabel(row.level))}</span><strong>${esc(row.team.shortName)}</strong><small>${row.positionPlayers} 야수 · ${row.pitchers} 투수${row.simulated ? " · 시즌 시뮬" : ""}</small>
    </div>`).join("")}</div>
    <p class="condition-note">A / High-A(A+) / AA / AAA / MLB 5단계가 모두 독립 일정·순위·야수/투수 시즌 기록을 같은 GameEngine으로 시뮬레이션합니다. 승격 사다리는 인접 레벨 한 단계씩만 이동하며, 확정 이동·Role 변경·Career Firsts는 Career Timeline에 계속 영속 기록합니다.</p>
  </section>`;
}

function pitcherMovementReview(organization) {
  const rows = ["SP", "RP"].map((role) => ({ role, evaluation: organization?.pitcherEvaluations?.[role] ?? null })).filter((row) => row.evaluation);
  if (!rows.length) return "";
  return `<div class="org-pitcher-review"><div class="section-head"><strong>투수 이동 검토</strong><span>SP / RP</span></div>${rows.map(({ role, evaluation }) => {
    const reasons = evaluation.reasonCodes?.length ? evaluation.reasonCodes.map(orgReasonLabel).join(" · ") : "표본 축적 중";
    const action = evaluation.decision === "PROMOTE" ? "AAA → MLB 교체" : evaluation.cooldown ? "이동 안정화" : "현 구성 유지";
    return `<div class="role-status-grid org-eval-grid">
      <div><span>${role === "SP" ? "선발" : "불펜"} 후보</span><b>${esc(evaluation.candidate?.name ?? "-")}</b><small>${evaluation.sampleReady ? "AAA 투구 표본 반영" : "AAA 표본 축적 중"}</small></div>
      <div><span>MLB 경쟁</span><b>${esc(evaluation.incumbent?.name ?? "-")}</b><small>${action}</small></div>
      <p class="condition-note" style="grid-column:1/-1">${esc(reasons)}. 실제 투구 성적과 workload/readiness를 함께 보며 내부 점수는 표시하지 않습니다.</p>
    </div>`;
  }).join("")}</div>`;
}

function organizationPathway(snapshot) {
  const org = snapshot.organization;
  const blocker = org?.pathway?.blockedBy ?? null;
  const evaluation = org?.userEvaluation ?? null;
  const review = org?.review ?? null;
  const reasons = evaluation?.reasonCodes?.length ? evaluation.reasonCodes.map(orgReasonLabel).join(" · ") : "표본 축적 중";
  const transactions = org?.recentTransactions ?? [];
  return `<section class="card org-path-card">
    <div class="section-head"><strong>내 경로</strong><span>${esc(org?.userPosition ?? snapshot.userPlayer.primaryPosition ?? "-")}</span></div>
    <div class="org-path-grid">
      <div><span>현재 레벨</span><b>${esc(levelLabel(org?.userLevel))}</b><small>${esc(snapshot.userPlayer.team?.shortName ?? "")}</small></div>
      <div><span>다음 레벨</span><b>${org?.pathway?.nextLevel ? esc(levelLabel(org.pathway.nextLevel)) : "최상위"}</b><small>${blocker ? `${esc(blocker.name)} · ${roleLabel(blocker.role)}` : "상위 레벨 없음"}</small></div>
    </div>
    ${evaluation ? (evaluation.perspective === "MLB_INCUMBENT" || evaluation.perspective === "UPPER_LEVEL_INCUMBENT" ? `<div class="role-status-grid org-eval-grid">
      <div><span>${evaluation.perspective === "MLB_INCUMBENT" || evaluation.toLevel === "MLB" ? "최근 MLB 평가" : "현재 레벨 평가"}</span><b>${evaluation.decision === "DEMOTE" ? `${evaluation.fromLevel ? esc(levelLabel(evaluation.fromLevel)) : (evaluation.perspective === "MLB_INCUMBENT" ? "AAA" : "하위")} 재배치` : `${esc(levelLabel(evaluation.toLevel ?? org?.userLevel))} 역할 유지`}</b><small>${evaluation.sampleReady ? `${evaluation.toLevel ? esc(levelLabel(evaluation.toLevel)) : "현재"} 경기 표본 반영` : `${evaluation.toLevel ? esc(levelLabel(evaluation.toLevel)) : "현재"} 표본 축적 중`}</small></div>
      <div><span>대체 경쟁</span><b>${evaluation.replacementPressure === "ACTION" ? "교체 결정" : evaluation.replacementPressure === "WATCH" ? "경쟁 관찰" : "안정"}</b><small>${evaluation.cooldown ? "이동 후 안정화 기간" : `다음 검토 ${review?.nextReviewInDays ?? "-"}일`}</small></div>
    </div><p class="condition-note">최근 평가 요인: ${esc(reasons)}. 강등은 벌점이 아니라 현재 역할과 하위 레벨 대체 depth를 함께 본 조직 결정이며, 내부 가중치·성장 ceiling은 표시하지 않습니다.</p>` : `<div class="role-status-grid org-eval-grid">
      <div><span>${evaluation.toLevel ? esc(levelLabel(evaluation.toLevel)) : "상위"} 준비도</span><b>${readinessLabel(evaluation.readiness)}</b><small>${evaluation.sampleReady ? "경기 표본 반영" : "표본 축적 중"}</small></div>
      <div><span>조직 경로</span><b>${pathwayLabel(evaluation.path)}</b><small>${evaluation.cooldown ? "이동 후 안정화 기간" : `다음 검토 ${review?.nextReviewInDays ?? "-"}일`}</small></div>
    </div><p class="condition-note">최근 평가 요인: ${esc(reasons)}. 내부 가중치·실제 성장 ceiling은 표시하지 않습니다.</p>`) : `<p class="condition-note">조직 평가는 7일 간격으로 진행됩니다. 현재는 경기 표본을 모으는 중입니다.</p>`}
    ${pitcherMovementReview(org)}
    ${transactions.length ? `<div class="org-transaction-list"><div class="section-head"><strong>최근 조직 이동</strong><span>최신순</span></div>${transactions.map((event) => `<p><span>${dateLabel(event.date)}</span><strong>${event.type === "PLAYER_PROMOTED" ? "승격" : "강등"} · ${esc(event.playerName)}</strong><small>${esc(levelLabel(event.fromLevel))} → ${esc(levelLabel(event.toLevel))} · ${esc(event.position ?? "")}</small></p>`).join("")}</div>` : ""}
    <p class="condition-note">PromotionAI가 각 인접 레벨의 실제 시즌 기록과 Depth Chart·Role을 함께 평가하고 RosterService가 원자적으로 이동을 실행합니다. A↔High-A(A+)↔AA↔AAA↔MLB 모두 한 단계씩만 이동하며, 포지션 플레이어와 SP/RP 모두 실제 성적·workload/readiness를 사용합니다. 사용자 전용 보정은 사용하지 않습니다.</p>
  </section>`;
}
function organizationDepthChart(snapshot, uiState = {}) {
  const org = snapshot.organization;
  if (!org) return `<section class="card org-depth-card"><p class="season-empty">조직 데이터가 없습니다.</p></section>`;
  const position = org.positionOptions.includes(uiState.orgPosition) ? uiState.orgPosition : org.userPosition;
  const groups = org.depthCharts?.[position] ?? [];
  return `<section class="card org-depth-card">
    <div class="section-head"><strong>Depth Chart</strong><span>${esc(position)} · MLB → A</span></div>
    <div class="org-position-grid">${org.positionOptions.map((key) => `<button type="button" data-org-position="${esc(key)}" class="${position === key ? "active" : ""}">${esc(key)}</button>`).join("")}</div>
    <div class="org-depth-groups">${groups.map((group) => `<div class="org-depth-group">
      <div class="org-depth-head"><strong>${esc(levelLabel(group.level))}</strong><span>${esc(group.team.shortName)}${group.simulated ? " · ACTIVE" : ""}</span></div>
      ${group.entries.length ? group.entries.map((entry) => `<button type="button" class="org-depth-row ${entry.isUser ? "user-depth-row" : ""}" data-player-detail="${esc(entry.id)}">
        <span class="org-depth-rank">${entry.rank}</span><span class="org-depth-name"><strong>${esc(entry.name)}</strong><small>${esc(roleLabel(entry.role))} · ${esc(entry.primaryPosition ?? position)}</small></span><b>${entry.isUser ? "YOU" : ""}</b>
      </button>`).join("") : `<p class="season-empty">해당 포지션 선수가 없습니다.</p>`}
    </div>`).join("")}</div>
    <p class="condition-note">정렬용 평가값은 Depth Chart 내부에서만 사용하며 PA 결과 공식에는 입력되지 않습니다.</p>
  </section>`;
}

function organizationProspects(snapshot) {
  const rows = snapshot.organization?.prospectRankings ?? [];
  return `<section class="card org-depth-card scouting-card"><div class="section-head"><strong>조직 유망주 순위</strong><span>Scouted FV · Top 10</span></div>
    ${rows.length ? `<div class="leader-list">${rows.slice(0,10).map((row) => `<button type="button" class="leader-row ${row.isUser ? "user-leader-row" : ""}" data-player-detail="${esc(row.id)}"><span class="leader-rank">${row.rank}</span><span class="leader-name"><strong>${esc(row.name)}</strong><small>${esc(levelLabel(row.level))} · ${esc(row.position)} · ${row.age}세 · ${esc(scoutingConfidenceLabel(row.confidence))} 신뢰</small></span><b>FV ${row.futureValue}</b></button>`).join("")}</div>` : `<p class="season-empty">순위 대상 선수가 없습니다.</p>`}
    <p class="condition-note">순위는 표시된 Scouted FV, 나이-레벨 맥락, 위험도와 포지션 가치를 사용합니다. 숨은 true ceiling으로 정렬하지 않습니다.</p></section>`;
}

function organizationView(snapshot, uiState = {}) {
  const org = snapshot.organization;
  if (!org) return `<section class="card"><p class="season-empty">조직 데이터가 없습니다.</p></section>`;
  return `${organizationLevelStrip(org)}${organizationPathway(snapshot)}${organizationProspects(snapshot)}${organizationDepthChart(snapshot, uiState)}`;
}

function moreSectionNav(section) {
  const tabs = [["ORG", "Organization", "조직"], ["FEED", "Career Feed", "커리어"], ["SETTINGS", "Settings", "설정"]];
  return `<div class="subnav more-subnav" aria-label="더보기 메뉴">${tabs.map(([key,en,ko]) => `<button type="button" data-more-section="${key}" class="${section === key ? "active" : ""}"><strong>${ko}</strong><small>${en}</small></button>`).join("")}</div>`;
}

function careerFeedView(snapshot) {
  const timeline = snapshot.careerTimeline ?? { totalEvents: 0, events: [] };
  const rows = [...(timeline.events ?? [])].reverse();
  return `<section class="card player-detail-card career-feed-card">
    <div class="section-head"><strong>Career Feed</strong><span>${timeline.totalEvents ?? rows.length} events</span></div>
    ${rows.length === 0 ? `<p class="season-empty">아직 기록된 커리어 이벤트가 없습니다.</p>` : `<div class="career-timeline-list">${rows.map((event) => `<div class="career-timeline-row importance-${String(event.importance ?? "NORMAL").toLowerCase()}"><span>${dateLabel(event.date)}</span><div><strong>${esc(careerEventLabel(event))}</strong><small>${esc(careerEventDetail(event))}</small></div></div>`).join("")}</div>`}
    <p class="condition-note">가장 최근 이벤트부터 표시합니다. 승격·강등·역할 변경·프로/MLB 첫 기록처럼 확정된 상태 변화만 피드에 남기며, 과거 이벤트를 임의로 만들어내지 않습니다.</p>
  </section>`;
}

function settingsView(snapshot, uiState = {}) {
  return `<section class="card settings-summary-card">
    <div class="section-head"><strong>Settings</strong><span>MVP 1.0</span></div>
    <div class="settings-summary-grid">
      <div><span>게임 진행</span><b>Quick AB</b><small>수비 자동 · 주루 대부분 자동</small></div>
      <div><span>AI 경기</span><b>FAST</b><small>사용자 포함 경기는 DETAILED</small></div>
      <div><span>저장</span><b>IndexedDB</b><small>자동 저장 · 체크포인트 · .tcu</small></div>
      <div><span>커리어 월드</span><b>${esc(snapshot.dataUniverse?.origin === "MASTER_SNAPSHOT" ? "독립 스냅샷" : "독립 세이브")}</b><small>생성 후 원본 데이터와 분리</small></div>
    </div>
  </section>${saveCard(uiState)}`;
}

function moreView(snapshot, uiState = {}) {
  const section = ["ORG", "FEED", "SETTINGS"].includes(uiState.moreSection) ? uiState.moreSection : "ORG";
  const body = section === "FEED" ? careerFeedView(snapshot) : section === "SETTINGS" ? settingsView(snapshot, uiState) : organizationView(snapshot, uiState);
  return `${moreSectionNav(section)}${body}`;
}

function leagueProspects(snapshot) {
  const rows = snapshot.worldProspectRankings ?? [];
  return `<section class="card leader-page-card scouting-card">
    <div class="section-head"><strong>전체 유망주 Top 100</strong><span>Scouted FV</span></div>
    ${rows.length ? `<div class="leader-list">${rows.map((row) => `<button type="button" class="leader-row ${row.isUser ? "user-leader-row" : ""}" data-player-detail="${esc(row.id)}"><span class="leader-rank">${row.rank}</span><span class="leader-name"><strong>${esc(row.name)}</strong><small>${esc(row.team?.shortName ?? "-")} · ${esc(levelLabel(row.level))} · ${esc(row.position)} · ${row.age}세 · ${esc(scoutingConfidenceLabel(row.confidence))} 신뢰</small></span><b>FV ${row.futureValue}</b></button>`).join("")}</div>` : `<p class="season-empty">순위 대상 선수가 없습니다.</p>`}
    <p class="condition-note">전체 Top 100은 표시된 Scouted FV, 나이-레벨 맥락, 위험도, 포지션 가치만 사용합니다. Production 월드는 현재 스냅샷에 공식 rookie-eligibility/service threshold가 없으므로 MLB 데뷔 이력이 없는 마이너리그 선수만 보수적으로 포함합니다.</p>
  </section>`;
}

function leagueView(snapshot, uiState = {}) {
  const section = uiState.leagueSection ?? "STANDINGS";
  const body = section === "LEADERS" ? leagueLeaders(snapshot, uiState)
    : section === "PROSPECTS" ? leagueProspects(snapshot)
    : `${standingsTable(snapshot)}
    <section class="card league-info-card"><div class="section-head"><strong>개발 테스트 리그</strong><span>Phase 2</span></div>
      <p>${esc(levelLabel(snapshot.currentLevel ?? "AAA"))} · 8팀 · 팀당 ${snapshot.progress.totalGames}경기. A / High-A(A+) / AA / AAA / MLB 모두 같은 GameEngine 결과에서 순위와 기록을 누적합니다.</p>
    </section>`;
  return `${leagueSectionNav(section)}${body}`;
}

function majorEventTitle(event) {
  if (!event) return "커리어 이벤트";
  if (event.type === "PLAYER_PROMOTED" && event.toLevel === "MLB") return "THE CALL-UP";
  if (event.type === "MLB_DEBUT") return "MLB 데뷔";
  if (event.type === "FIRST_MLB_HR") return "첫 MLB 홈런";
  if (event.type === "PRO_DEBUT") return "프로 데뷔";
  if (event.type === "PLAYER_PROMOTED") return `${levelLabel(event.toLevel)} 승격`;
  if (event.type === "PLAYER_DEMOTED") return `${levelLabel(event.toLevel)} 재배치`;
  return "커리어 모먼트";
}

function majorEventPresentation(event) {
  if (!event || !["MAJOR", "CAREER"].includes(event.importance)) return "";
  return `<div class="major-event-overlay" role="dialog" aria-modal="true" aria-label="주요 커리어 이벤트">
    <section class="major-event-card">
      <p class="major-event-kicker">CAREER MOMENT · ${dateLabel(event.date)}</p>
      <h2>${esc(majorEventTitle(event))}</h2>
      <strong>${esc(careerEventLabel(event))}</strong>
      <p>${esc(careerEventDetail(event))}</p>
      <button type="button" class="primary major-event-continue" data-major-event-dismiss>계속</button>
    </section>
  </div>`;
}

function playerDetailSheet(detail) {
  if (!detail) return "";
  const ratings = detail.ratings?.current ?? {};
  const line = detail.seasonLine ?? {};
  return `<div class="player-sheet-backdrop" data-player-detail-close><section class="player-sheet" role="dialog" aria-modal="true" aria-label="선수 상세" data-player-sheet>
    <div class="player-sheet-handle"></div>
    <div class="section-head"><div><strong>${esc(detail.name)}</strong><span>${esc(detail.team?.shortName ?? "")} · ${esc(detail.primaryPosition ?? "-")}</span></div><button type="button" class="sheet-close" data-player-detail-close>닫기</button></div>
    <div class="player-sheet-rates"><div><span>AVG</span><b>${fmtRate(line.AVG)}</b></div><div><span>OPS</span><b>${fmtRate(line.OPS)}</b></div><div><span>HR</span><b>${line.HR ?? 0}</b></div><div><span>RBI</span><b>${line.RBI ?? 0}</b></div></div>
    <div class="player-sheet-ratings">${[["CON R",ratings.contactR],["CON L",ratings.contactL],["POWER",ratings.rawPower],["VISION",ratings.vision],["DISC",ratings.discipline],["SPEED",ratings.speed],["FIELD",ratings.fielding],["ARM",ratings.armStrength]].map(([label,value]) => `<div><span>${label}</span><b>${value ?? "-"}</b></div>`).join("")}</div>
    ${detail.scouting ? `<div class="player-sheet-rates"><div><span>CUR</span><b>${detail.scouting.currentGrade}</b></div><div><span>FV</span><b>${detail.scouting.futureValue}</b></div><div><span>F-CONF</span><b>${esc(scoutingConfidenceLabel(detail.scouting.futureConfidence ?? detail.scouting.confidence))}</b></div><div><span>RISK</span><b>${esc(scoutingRiskLabel(detail.scouting.risk))}</b></div></div>` : ""}
    <p class="condition-note">현재 ratings와 시즌 성적, 스카우팅 추정치를 표시합니다. FV/미래 툴은 true ceiling이 아니며 숨은 성장 상태는 노출하지 않습니다.</p>
  </section></div>`;
}

function renderSeason(root, snapshot, handlers, tab = "HOME", uiState = {}) {
  const content = tab === "PLAYER" ? playerView(snapshot, uiState) : tab === "ORG" ? organizationView(snapshot, uiState) : tab === "LEAGUE" ? leagueView(snapshot, uiState) : tab === "MORE" ? moreView(snapshot, uiState) : homeView(snapshot, uiState);
  root.innerHTML = `<main class="season-screen">
    ${topbar(snapshot, tab)}
    <div class="season-content">${content}</div>
    ${bottomNav(tab)}
    ${playerDetailSheet(uiState.playerDetail)}
    ${majorEventPresentation(uiState.majorEvent)}
  </main>`;
  root.querySelectorAll("[data-season-tab]").forEach((button) => button.addEventListener("click", () => handlers.onTab(button.dataset.seasonTab)));
  root.querySelectorAll("[data-season-action]").forEach((button) => button.addEventListener("click", () => handlers.onAction(button.dataset.seasonAction)));
  root.querySelectorAll("[data-training-focus]").forEach((button) => button.addEventListener("click", () => handlers.onTrainingFocus?.(button.dataset.trainingFocus)));
  root.querySelectorAll("[data-backup-restore]").forEach((button) => button.addEventListener("click", () => handlers.onRestoreBackup?.(button.dataset.backupRestore)));
  root.querySelectorAll("[data-player-section]").forEach((button) => button.addEventListener("click", () => handlers.onPlayerSection?.(button.dataset.playerSection)));
  root.querySelectorAll("[data-league-section]").forEach((button) => button.addEventListener("click", () => handlers.onLeagueSection?.(button.dataset.leagueSection)));
  root.querySelectorAll("[data-more-section]").forEach((button) => button.addEventListener("click", () => handlers.onMoreSection?.(button.dataset.moreSection)));
  root.querySelectorAll("[data-leader-category]").forEach((button) => button.addEventListener("click", () => handlers.onLeaderCategory?.(button.dataset.leaderCategory)));
  root.querySelectorAll("[data-org-position]").forEach((button) => button.addEventListener("click", () => handlers.onOrgPosition?.(button.dataset.orgPosition)));
  root.querySelectorAll("[data-player-detail]").forEach((button) => button.addEventListener("click", () => handlers.onPlayerDetail?.(button.dataset.playerDetail)));
  root.querySelectorAll("[data-player-detail-close]").forEach((element) => element.addEventListener("click", (event) => {
    if (event.target.closest("[data-player-sheet]") && !event.target.closest(".sheet-close")) return;
    handlers.onPlayerDetailClose?.();
  }));
  root.querySelectorAll("[data-major-event-dismiss]").forEach((button) => button.addEventListener("click", () => handlers.onMajorEventDismiss?.()));
  const importInput = root.querySelector("[data-tcu-import]");
  importInput?.addEventListener("change", () => {
    const file = importInput.files?.[0] ?? null;
    if (file) handlers.onImportFile?.(file);
    importInput.value = "";
  });
}

export { renderSeason };
