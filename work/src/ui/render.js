const APPROACHES = Object.freeze([
  ["AGGRESSIVE", "공격적", "장타 기회 ↑ · 헛스윙/추격 위험 ↑"],
  ["BALANCED", "균형", "기본 접근 · 재능을 가장 자연스럽게 반영"],
  ["CONTACT", "컨택트", "삼진 위험 ↓ · 강한 타구 가치 ↓"],
  ["PATIENT", "인내", "볼넷 기회 ↑ · 좋은 공을 지켜볼 위험"]
]);

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtRate(value) {
  return Number(value ?? 0).toFixed(3).replace(/^0/, "");
}

function fmtIP(outs) {
  const value = Number(outs ?? 0);
  return `${Math.floor(value / 3)}.${value % 3}`;
}

function halfLabel(half) {
  return half === "TOP" ? "초" : "말";
}

function outcomeLabel(outcome) {
  return ({ BB: "볼넷", HBP: "몸에 맞는 공", K: "삼진", OUT: "아웃", ROE: "실책 출루", "1B": "안타", "2B": "2루타", "3B": "3루타", HR: "홈런" })[outcome] ?? outcome ?? "-";
}

function approachLabel(value) {
  return ({ BALANCED: "균형", AGGRESSIVE: "공격적", CONTACT: "컨택트", PATIENT: "인내" })[value] ?? value;
}

function contactLabel(value) {
  return ({ POOR: "빗맞음", WEAK: "약한 타구", NORMAL: "보통", SOLID: "강한 타구", PERFECT: "정타" })[value] ?? value;
}

function sprayLabel(value) {
  return ({ PULL: "당겨침", CENTER: "중앙", OPPO: "밀어침" })[value] ?? value;
}

function lastPAHtml(snapshot) {
  const record = snapshot.lastUserPAView;
  if (!record) return `<div class="result-empty">첫 타석을 기다리고 있습니다.</div>`;
  const bip = record.exitVelocityMph != null;
  const rbi = record.rbi > 0 ? `<span class="impact">${record.rbi}타점</span>` : "";
  const distance = record.projectedDistanceFt != null ? `<span>비거리 <b>${record.projectedDistanceFt.toFixed(0)}ft</b></span>` : "";
  return `
    <div class="result-main">
      <span class="result-kicker">직전 내 타석</span>
      <strong>${outcomeLabel(record.outcome)}</strong>
      <span>${approachLabel(record.approach)} 접근 · ${record.pitchCount}구</span>
    </div>
    <div class="result-tags">${rbi}${record.reachedOnError ? `<span class="warn">실책 출루</span>` : ""}</div>
    ${bip ? `
      <div class="result-metrics">
        <span>${contactLabel(record.contactQuality)}</span>
        <span>EV <b>${record.exitVelocityMph.toFixed(1)}</b></span>
        <span>LA <b>${record.launchAngleDegrees.toFixed(1)}°</b></span>
        <span>${esc(record.battedBallType)}</span>
        <span>${sprayLabel(record.sprayZone)}</span>
        ${distance}
      </div>
      ${record.fielder ? `<p class="micro">수비: ${esc(record.fielder.position)} ${esc(record.fielder.name)}${record.hardHit ? " · Hard-Hit" : ""}</p>` : ""}
    ` : `<div class="result-metrics"><span>${record.pitchCount}구 승부</span></div>`}
  `;
}

function baseClass(base) {
  return base ? "base occupied" : "base";
}

function playerLabel(base) {
  return base ? `<span>${esc(base.name)}</span>` : "";
}

function playFeedText(item) {
  if (item.type === "SUBSTITUTION") {
    const reason = ({ PINCH_HIT: "대타", PINCH_RUN: "대주자", DEFENSIVE_REPLACEMENT: "수비 교체" })[item.reason] ?? "선수 교체";
    return `${esc(item.outPlayer?.name)} → ${esc(item.inPlayer?.name)} · ${reason}${item.position && item.position !== "DH" ? ` (${esc(item.position)})` : ""}`;
  }
  if (item.type === "PITCHING_CHANGE") return `${esc(item.pitcher.name)} 투수 교체`;
  if (item.type === "RUNNING") {
    const label = item.kind === "SB" ? "도루 성공" : item.kind === "CS" ? "도루 실패" : "견제사";
    return `${esc(item.runner.name)} · ${label}`;
  }
  if (item.type === "PA") {
    const extras = [];
    if (item.rbi > 0) extras.push(`${item.rbi}타점`);
    if (item.runsScored > 0 && item.rbi === 0) extras.push(`${item.runsScored}득점 발생`);
    if (item.responsiblePosition && item.outcome === "OUT") extras.push(item.responsiblePosition);
    return `${esc(item.batter.name)} · ${outcomeLabel(item.outcome)}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
  }
  return item.type;
}

function playFeedHtml(snapshot) {
  const items = snapshot.playFeed ?? [];
  if (items.length === 0) return `<div class="result-empty">아직 기록된 플레이가 없습니다.</div>`;
  return `<div class="play-feed">${items.map((item) => {
    const inning = item.inning ? `${item.inning}회 ${halfLabel(item.half)}` : "경기";
    const user = item.type === "PA" && item.batter?.id === snapshot.userPlayer.id;
    return `
      <div class="feed-row${user ? " user-feed" : ""}">
        <span class="feed-inning">${inning}</span>
        <div><strong>${playFeedText(item)}</strong>${item.type === "PA" && item.pitchCount ? `<small>${item.pitchCount}구</small>` : ""}</div>
      </div>`;
  }).join("")}</div>`;
}

function gameHeader(snapshot, activeView, options = {}) {
  const final = snapshot.status === "FINAL";
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">THE CALL-UP · QUICK AB</p>
        <h1 class="game-title">${final ? "경기 종료" : `${snapshot.inning}회 ${halfLabel(snapshot.half)}`}</h1>
      </div>
      ${options.hideReset ? "" : `<button class="ghost" id="reset-game" type="button">${esc(options.resetLabel ?? "새 경기")}</button>`}
    </header>
    <nav class="view-tabs" aria-label="경기 보기">
      <button type="button" data-view="GAME" class="${activeView === "GAME" ? "active" : ""}">경기</button>
      <button type="button" data-view="BOX" class="${activeView === "BOX" ? "active" : ""}">박스스코어</button>
    </nav>`;
}

function scoreCard(snapshot) {
  return `
    <section class="score-card" aria-label="점수판">
      <div class="team-row"><span>${esc(snapshot.teams.away.shortName)}</span><strong>${snapshot.score.away}</strong></div>
      <div class="team-row active"><span>${esc(snapshot.teams.home.shortName)}</span><strong>${snapshot.score.home}</strong></div>
      <div class="count-strip"><span>${snapshot.outs} OUT</span><span>${snapshot.plateAppearances} PA</span></div>
    </section>`;
}

function gameView(snapshot, options = {}) {
  const final = snapshot.status === "FINAL";
  const line = snapshot.userLine;
  const matchup = snapshot.matchup;
  return `
    ${scoreCard(snapshot)}

    <section class="diamond-card" aria-label="주자 상황">
      <div class="diamond">
        <div class="${baseClass(snapshot.bases.second)} second">${playerLabel(snapshot.bases.second)}</div>
        <div class="${baseClass(snapshot.bases.third)} third">${playerLabel(snapshot.bases.third)}</div>
        <div class="${baseClass(snapshot.bases.first)} first">${playerLabel(snapshot.bases.first)}</div>
        <div class="plate"></div>
      </div>
      <div class="matchup">
        ${final ? `<strong>${esc(snapshot.result.winnerName)} 승리${snapshot.result.walkOff ? " · 끝내기" : ""}</strong>` : `
          <span class="muted">타자</span><strong>${esc(matchup.batter.name)}</strong>
          <span class="versus">VS</span>
          <span class="muted">투수</span><strong>${esc(matchup.pitcher.name)}</strong>
        `}
      </div>
    </section>

    <section class="card player-line-card">
      <div class="section-head"><strong>${esc(snapshot.userPlayer.name)}</strong><span>오늘</span></div>
      <div class="line-grid">
        <div><span>AB</span><b>${line.AB}</b></div>
        <div><span>H</span><b>${line.H}</b></div>
        <div><span>HR</span><b>${line.HR}</b></div>
        <div><span>RBI</span><b>${line.RBI}</b></div>
        <div><span>BB</span><b>${line.BB}</b></div>
        <div><span>AVG</span><b>${fmtRate(line.AVG)}</b></div>
      </div>
    </section>

    <section class="card result-card">${lastPAHtml(snapshot)}</section>

    ${final ? `
      <button class="primary" id="play-again" type="button">${esc(options.finalActionLabel ?? "다시 경기하기")}</button>
    ` : snapshot.userRunningDecision ? `
      <section class="approach-panel running-decision-panel">
        <div class="section-head"><strong>주루 선택</strong><span>간단 도루 결정</span></div>
        <p class="status">${esc(snapshot.userRunningDecision.prompt)}</p>
        <div class="approach-grid running-choice-grid">
          <button class="approach" data-running-choice="STEAL" type="button"><strong>도루 시도</strong><span>${snapshot.userRunningDecision.targetBase}루를 노립니다</span></button>
          <button class="approach" data-running-choice="HOLD" type="button"><strong>유지</strong><span>주자를 그대로 두고 다음 플레이 진행</span></button>
        </div>
      </section>
    ` : `
      <section class="approach-panel">
        <div class="section-head"><strong>접근법 선택</strong><span>내 타석만 직접 결정</span></div>
        <div class="approach-grid">
          ${APPROACHES.map(([value, label, desc]) => `
            <button class="approach" data-approach="${value}" type="button">
              <strong>${label}</strong><span>${desc}</span>
            </button>
          `).join("")}
        </div>
      </section>
    `}

    <section class="card feed-card">
      <div class="section-head"><strong>최근 플레이</strong><span>최신순</span></div>
      ${playFeedHtml(snapshot)}
    </section>

    <p class="status">비사용자 타석·수비·주루·투수 교체와 후반 대타·대주자·수비 교체는 같은 경기 엔진으로 자동 진행됩니다.</p>`;
}

function lineScoreHtml(snapshot) {
  const box = snapshot.boxScore;
  const innings = box.innings;
  const row = (teamKey) => {
    const totals = box.totals[teamKey];
    return `<tr>
      <th>${esc(snapshot.teams[teamKey].shortName)}</th>
      ${innings.map((inning) => `<td>${box.lineScore[teamKey][String(inning)] ?? 0}</td>`).join("")}
      <td class="total">${snapshot.score[teamKey]}</td>
      <td class="total">${totals.batting.H}</td>
      <td class="total">${totals.fielding.E}</td>
    </tr>`;
  };
  return `<div class="table-scroll"><table class="line-score">
    <thead><tr><th>팀</th>${innings.map((n) => `<th>${n}</th>`).join("")}<th>R</th><th>H</th><th>E</th></tr></thead>
    <tbody>${row("away")}${row("home")}</tbody>
  </table></div>`;
}

function battingTable(snapshot, teamKey) {
  const rows = snapshot.boxScore.batting[teamKey];
  return `<div class="table-scroll"><table class="stat-table batting-table">
    <thead><tr><th>타자</th><th>AB</th><th>R</th><th>H</th><th>2B</th><th>3B</th><th>HR</th><th>RBI</th><th>BB</th><th>SO</th><th>SB</th><th>AVG</th></tr></thead>
    <tbody>${rows.map((line) => `<tr class="${line.id === snapshot.userPlayer.id ? "user-row" : ""}">
      <th>${line.substitute ? "교체 · " : `${line.order}. `}${esc(line.name)}</th><td>${line.AB}</td><td>${line.R}</td><td>${line.H}</td><td>${line.doubles}</td><td>${line.triples}</td><td>${line.HR}</td><td>${line.RBI}</td><td>${line.BB}</td><td>${line.SO}</td><td>${line.SB}</td><td>${fmtRate(line.AVG)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function pitchingTable(snapshot, teamKey) {
  const rows = snapshot.boxScore.pitching[teamKey];
  return `<div class="table-scroll"><table class="stat-table pitching-table">
    <thead><tr><th>투수</th><th>IP</th><th>H</th><th>R</th><th>HR</th><th>BB</th><th>SO</th><th>투구</th></tr></thead>
    <tbody>${rows.map((line) => `<tr><th>${esc(line.name)}</th><td>${fmtIP(line.outsRecorded)}</td><td>${line.H}</td><td>${line.R}</td><td>${line.HR}</td><td>${line.BB}</td><td>${line.SO}</td><td>${line.Pitches}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function teamBoxSection(snapshot, teamKey) {
  const totals = snapshot.boxScore.totals[teamKey];
  return `<section class="card box-team-card">
    <div class="section-head"><strong>${esc(snapshot.teams[teamKey].name)}</strong><span>H ${totals.batting.H} · E ${totals.fielding.E}</span></div>
    <h3 class="table-title">타격</h3>
    ${battingTable(snapshot, teamKey)}
    <h3 class="table-title">투수</h3>
    ${pitchingTable(snapshot, teamKey)}
  </section>`;
}

function boxScoreView(snapshot) {
  return `
    ${scoreCard(snapshot)}
    <section class="card line-score-card">
      <div class="section-head"><strong>라인 스코어</strong><span>R · H · E</span></div>
      ${lineScoreHtml(snapshot)}
    </section>
    ${teamBoxSection(snapshot, "away")}
    ${teamBoxSection(snapshot, "home")}
    <p class="status">박스스코어는 중앙 공식기록 이벤트에서 생성됩니다.</p>`;
}

function renderQuickAB(root, snapshot, handlers, activeView = "GAME", options = {}) {
  root.innerHTML = `<main class="game-screen">
    ${gameHeader(snapshot, activeView, options)}
    ${activeView === "BOX" ? boxScoreView(snapshot) : gameView(snapshot, options)}
  </main>`;

  root.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => handlers.onView(button.dataset.view));
  });
  root.querySelectorAll("[data-approach]").forEach((button) => {
    button.addEventListener("click", () => handlers.onApproach(button.dataset.approach));
  });
  root.querySelectorAll("[data-running-choice]").forEach((button) => {
    button.addEventListener("click", () => handlers.onRunningChoice?.(button.dataset.runningChoice));
  });
  root.querySelector("#reset-game")?.addEventListener("click", handlers.onReset);
  root.querySelector("#play-again")?.addEventListener("click", handlers.onReset);
}

export { renderQuickAB };
