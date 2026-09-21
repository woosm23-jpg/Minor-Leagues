function esc(value) {
  return String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function dateLabel(value) {
  if (!value) return "-";
  const [, month, day] = String(value).split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function statusLabel(status) {
  return status === "COMPLETE" ? "시즌 완료" : "시즌 진행 중";
}

function saveRow(meta) {
  const active = meta.hasActiveGame ? `<span class="save-slot-badge">진행 중 경기</span>` : "";
  const origin = meta.importedFrom ? `<span class="save-slot-origin">가져온 커리어</span>` : meta.recoveredFrom ? `<span class="save-slot-origin">백업 복구본</span>` : "";
  return `<article class="save-slot" data-save-slot="${esc(meta.saveId)}">
    <button type="button" class="save-slot-main" data-save-continue="${esc(meta.saveId)}">
      <span class="save-slot-kicker">${esc(meta.userTeamShortName || "DEV")} · ${esc(statusLabel(meta.status))}</span>
      <strong>${esc(meta.label || `${meta.userPlayerName ?? "선수"} 커리어`)}</strong>
      <span class="save-slot-player">${esc(meta.userPlayerName ?? "선수")} · ${Number(meta.wins ?? 0)}-${Number(meta.losses ?? 0)}</span>
      <span class="save-slot-progress">${dateLabel(meta.currentDate)} · ${Number(meta.gamesPlayed ?? 0)}/${Number(meta.totalGames ?? 0)} 경기</span>
      <span class="save-slot-meta">${active}${origin}</span>
    </button>
    <button type="button" class="save-slot-delete" aria-label="${esc(meta.label ?? meta.saveId)} 삭제" data-save-delete="${esc(meta.saveId)}">삭제</button>
  </article>`;
}

function renderSaveSelect(root, saves, handlers, { message = "" } = {}) {
  const rows = Array.isArray(saves) ? saves : [];
  root.innerHTML = `<main class="save-select-screen">
    <header class="save-select-hero">
      <p class="eyebrow">BASEBALL CAREER SIMULATOR</p>
      <h1>THE CALL-UP</h1>
      <p>한 선수를 만들고, 독립된 야구 세계에서 커리어를 이어가세요.</p>
    </header>
    <section class="card save-select-actions">
      <button type="button" class="primary" data-career-new>새 커리어</button>
      <button type="button" class="secondary" data-career-import>.tcu 가져오기</button>
      <input type="file" accept=".tcu,application/json,application/vnd.the-call-up+json" data-career-import-input hidden />
    </section>
    <section class="save-select-list-wrap">
      <div class="section-head"><strong>계속하기</strong><span>${rows.length}개 커리어</span></div>
      ${rows.length ? `<div class="save-select-list">${rows.map(saveRow).join("")}</div>` : `<div class="card save-select-empty"><strong>저장된 커리어가 없습니다.</strong><p>새 커리어를 시작하거나 .tcu 파일을 가져올 수 있습니다.</p></div>`}
      ${message ? `<p class="save-select-message">${esc(message)}</p>` : ""}
    </section>
    <p class="status">커리어 목록은 가벼운 Save Metadata만 읽습니다. 각 커리어의 전체 시즌 데이터는 선택할 때만 불러옵니다.</p>
  </main>`;

  root.querySelector("[data-career-new]")?.addEventListener("click", () => handlers.onNewCareer?.());
  root.querySelector("[data-career-import]")?.addEventListener("click", () => root.querySelector("[data-career-import-input]")?.click());
  root.querySelector("[data-career-import-input]")?.addEventListener("change", (event) => {
    const file = event.currentTarget.files?.[0] ?? null;
    if (file) handlers.onImportFile?.(file);
    event.currentTarget.value = "";
  });
  root.querySelectorAll("[data-save-continue]").forEach((button) => button.addEventListener("click", () => handlers.onContinue?.(button.dataset.saveContinue)));
  root.querySelectorAll("[data-save-delete]").forEach((button) => button.addEventListener("click", () => handlers.onDelete?.(button.dataset.saveDelete)));
}

export { renderSaveSelect };
