function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function selected(value, current) { return value === current ? " selected" : ""; }
function checked(value) { return value ? " checked" : ""; }

function toolLabel(key) {
  return ({ contact: "컨택", power: "파워", vision: "비전", discipline: "선구안", defense: "수비", reaction: "반응", arm: "송구", speed: "스피드" })[key] ?? key;
}

function selectOptions(rows, current, { valueKey = "key", labelKey = "label" } = {}) {
  return rows.map((row) => {
    const value = typeof row === "string" ? row : row[valueKey];
    const label = typeof row === "string" ? row : row[labelKey];
    return `<option value="${esc(value)}"${selected(value, current)}>${esc(label)}</option>`;
  }).join("");
}

function previewCard(preview) {
  if (!preview) return `<section class="card career-preview-card"><div class="section-head"><strong>예상 프로필</strong><span>입력을 확인해주세요</span></div><p class="career-helper">입력값이 유효하면 여기에서 시작 능력 분포를 미리 확인할 수 있습니다.</p></section>`;
  const identity = preview.identity;
  const profile = preview.profile;
  return `<section class="card career-preview-card">
    <div class="section-head"><strong>예상 프로필</strong><span>${esc(preview.archetypeLabel)} · ${esc(identity.primaryPosition)}</span></div>
    <div class="career-preview-head">
      <div><span>${esc(preview.organization.teamShortName)}</span><strong>${esc(identity.name)}</strong><small>${identity.age}세 · ${identity.heightCm}cm / ${identity.weightKg}kg · ${esc(identity.bats)}/${esc(identity.throws)}</small></div>
      <div><span>조직</span><b>${esc(preview.organization.teamName)}</b><small>${preview.organization.mode === "RANDOM" ? "랜덤 배정" : "선호 조직"}</small></div>
    </div>
    <div class="career-tool-grid">${Object.entries(profile.tools).map(([key, value]) => `<div><span>${esc(toolLabel(key))}</span><b>${Number(value)}</b></div>`).join("")}</div>
    <div class="career-preview-tags">${preview.visibleTraits.length ? preview.visibleTraits.map((row) => `<span>${esc(row.label)}</span>`).join("") : `<span>공개 특성 없음</span>`}</div>
    <p class="career-helper">표시값은 시작 시점의 현재 능력입니다. 실제 성장 ceiling과 숨은 성장 성향은 보여주지 않습니다.</p>
  </section>`;
}

function renderNewCareer(root, { draft, catalog, preview = null, message = "" }, handlers = {}) {
  const traits = new Set(draft.visibleTraits ?? []);
  const traitLimitReached = traits.size >= 2;
  const selectedArchetype = catalog.archetypes.find((row) => row.key === draft.archetype) ?? catalog.archetypes[0];
  const selectedBody = catalog.bodyTypes.find((row) => row.key === draft.bodyType) ?? catalog.bodyTypes[0];
  const favoriteMode = draft.organizationMode === "FAVORITE";

  root.innerHTML = `<main class="new-career-screen">
    <header class="new-career-topbar">
      <div><p class="eyebrow">NEW CAREER</p><h1>선수 만들기</h1></div>
      <button type="button" class="ghost" data-career-create-back>뒤로</button>
    </header>

    <section class="card career-form-card">
      <div class="section-head"><strong>1. 기본 정보</strong><span>커리어 신상정보</span></div>
      <div class="career-field-grid">
        <label class="career-field career-field-wide"><span>이름</span><input type="text" maxlength="24" value="${esc(draft.name)}" data-career-field="name" autocomplete="name" /></label>
        <label class="career-field"><span>국적</span><input type="text" maxlength="24" value="${esc(draft.nationality)}" data-career-field="nationality" /></label>
        <label class="career-field"><span>출신지</span><input type="text" maxlength="36" value="${esc(draft.hometown)}" data-career-field="hometown" /></label>
        <label class="career-field"><span>나이</span><select data-career-field="age">${catalog.ages.map((age) => `<option value="${age}"${selected(Number(age), Number(draft.age))}>${age}세</option>`).join("")}</select></label>
        <label class="career-field"><span>키</span><input type="number" min="160" max="205" step="1" value="${esc(draft.heightCm)}" data-career-field="heightCm" inputmode="numeric" /></label>
        <label class="career-field"><span>몸무게</span><input type="number" min="55" max="125" step="1" value="${esc(draft.weightKg)}" data-career-field="weightKg" inputmode="numeric" /></label>
        <label class="career-field"><span>체형</span><select data-career-field="bodyType">${selectOptions(catalog.bodyTypes, draft.bodyType)}</select></label>
      </div>
      <p class="career-helper">18세는 당장 완성도가 조금 낮은 대신 성장 여지가 더 크고, 22세는 현재 준비도가 조금 높지만 남은 성장 여지는 상대적으로 작습니다. 체형은 재능을 추가하지 않고 분포에 작은 경향만 줍니다.</p>
      <p class="career-inline-note"><strong>${esc(selectedBody?.label ?? "")}</strong> · ${esc(selectedBody?.description ?? "")}</p>
    </section>

    <section class="card career-form-card">
      <div class="section-head"><strong>2. 야구 프로필</strong><span>포지션 · 좌우</span></div>
      <div class="career-field-grid">
        <label class="career-field"><span>주포지션</span><select data-career-field="primaryPosition">${catalog.positions.map((position) => `<option value="${esc(position)}"${selected(position, draft.primaryPosition)}>${esc(position)}</option>`).join("")}</select></label>
        <label class="career-field"><span>타석</span><select data-career-field="bats">${catalog.bats.map((side) => `<option value="${side}"${selected(side, draft.bats)}>${side === "R" ? "우타" : side === "L" ? "좌타" : "스위치"}</option>`).join("")}</select></label>
        <label class="career-field"><span>송구손</span><select data-career-field="throws">${catalog.throws.map((side) => `<option value="${side}"${selected(side, draft.throws)}>${side === "R" ? "우투" : "좌투"}</option>`).join("")}</select></label>
      </div>
      <p class="career-helper">사용자 커리어는 현재 1B / 2B / 3B / SS / LF / CF / RF를 지원합니다. 포수와 투수 커리어는 Complete 이후 확장 범위입니다.</p>
    </section>

    <section class="card career-form-card">
      <div class="section-head"><strong>3. 선수 유형</strong><span>능력치 직접 배분 없음</span></div>
      <label class="career-field career-field-wide"><span>아키타입</span><select data-career-field="archetype">${selectOptions(catalog.archetypes, draft.archetype)}</select></label>
      <p class="career-inline-note"><strong>${esc(selectedArchetype?.label ?? "")}</strong> · ${esc(selectedArchetype?.description ?? "")}</p>
      <div class="section-head career-trait-head"><strong>공개 특성</strong><span>${traits.size}/2 선택</span></div>
      <div class="career-trait-grid">${catalog.traits.map((row) => {
        const isChecked = traits.has(row.key);
        const disabled = traitLimitReached && !isChecked;
        return `<label class="career-trait ${isChecked ? "selected" : ""} ${disabled ? "disabled" : ""}"><input type="checkbox" value="${esc(row.key)}" data-career-trait${checked(isChecked)}${disabled ? " disabled" : ""} /><span>${esc(row.label)}</span></label>`;
      }).join("")}</div>
      <p class="career-helper">특성은 특정 능력과 플레이 성향에 작은 방향성을 줍니다. ‘+5 전 능력’ 같은 보너스는 없고 총 시작 재능 예산은 통제됩니다.</p>
    </section>

    <section class="card career-form-card">
      <div class="section-head"><strong>4. 시작 조직</strong><span>v40 개발용 경로</span></div>
      <div class="career-segmented" role="group" aria-label="조직 선택 방식">
        <label><input type="radio" name="organizationMode" value="RANDOM" data-career-org-mode${checked(!favoriteMode)} /><span>랜덤</span></label>
        <label><input type="radio" name="organizationMode" value="FAVORITE" data-career-org-mode${checked(favoriteMode)} /><span>선호 조직</span></label>
      </div>
      ${favoriteMode ? `<label class="career-field career-field-wide"><span>선호 조직</span><select data-career-field="favoriteOrganizationId">${catalog.organizations.map((team) => `<option value="${esc(team.id)}"${selected(team.id, draft.favoriteOrganizationId)}>${esc(team.name)} (${esc(team.shortName)})</option>`).join("")}</select></label>` : ""}
      <p class="career-helper">현재 RC standalone에는 전체 2026 Production snapshot이 번들되지 않아 8개 개발용 조직으로 시작합니다. Production standalone에서는 v47에서 검증된 30개 MLB 조직·실존 로스터·실제 시작연도 일정 경로가 그대로 활성화됩니다.</p>
    </section>

    ${previewCard(preview)}
    ${message ? `<p class="save-select-message">${esc(message)}</p>` : ""}
    <button type="button" class="primary career-create-submit" data-career-create-submit>이 선수로 커리어 시작</button>
    <p class="status">새 커리어를 만들면 오프닝 데이 상태가 즉시 저장되고 첫 마일스톤 백업이 생성됩니다.</p>
  </main>`;

  root.querySelector("[data-career-create-back]")?.addEventListener("click", () => handlers.onBack?.());
  root.querySelectorAll("[data-career-field]").forEach((element) => element.addEventListener("change", () => {
    const field = element.dataset.careerField;
    const numeric = ["age", "heightCm", "weightKg"].includes(field);
    handlers.onField?.(field, numeric ? Number(element.value) : element.value);
  }));
  root.querySelectorAll("[data-career-trait]").forEach((element) => element.addEventListener("change", () => handlers.onTrait?.(element.value, element.checked)));
  root.querySelectorAll("[data-career-org-mode]").forEach((element) => element.addEventListener("change", () => {
    if (element.checked) handlers.onField?.("organizationMode", element.value);
  }));
  root.querySelector("[data-career-create-submit]")?.addEventListener("click", () => handlers.onCreate?.());
}

export { renderNewCareer };
