import { seasonApi } from "../api/seasonApi.js";
import { seasonBackupService } from "../services/seasonBackupService.js";
import { seasonSaveService } from "../services/seasonSaveService.js";
import { seasonTransferService } from "../services/seasonTransferService.js";
import { renderSaveSelect } from "../ui/saveSelectRender.js";
import { renderNewCareer } from "../ui/newCareerRender.js";
import { renderSeason } from "../ui/seasonRender.js";
import { renderQuickAB } from "../ui/render.js";

function downloadTextFile({ filename, mimeType, text }) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function milestoneLabel(milestone) {
  return ({ OPENING_DAY: "오프닝 데이", OFFSEASON_START: "오프시즌 시작", SEASON_END: "시즌 종료" })[milestone] ?? milestone;
}

function careerSeed(index) {
  return `THE_CALL_UP_CAREER_${Date.now()}_${index}`;
}

function latestMajorCareerEvent(snapshot, afterSequence = 0) {
  const events = snapshot?.careerTimeline?.events ?? [];
  return events
    .filter((event) => Number(event?.sequence ?? 0) > Number(afterSequence ?? 0) && ["MAJOR", "CAREER"].includes(event?.importance))
    .sort((a, b) => Number(b.sequence ?? 0) - Number(a.sequence ?? 0))[0] ?? null;
}

function latestCareerSequence(snapshot) {
  return Math.max(0, ...(snapshot?.careerTimeline?.events ?? []).map((event) => Number(event?.sequence ?? 0)));
}

function defaultCareerDraft(catalog) {
  return {
    name: "강민준",
    nationality: "대한민국",
    hometown: "서울",
    age: 20,
    heightCm: 180,
    weightKg: 80,
    bodyType: "AVERAGE",
    bats: "R",
    throws: "R",
    primaryPosition: "CF",
    archetype: "BALANCED",
    visibleTraits: [],
    organizationMode: "RANDOM",
    favoriteOrganizationId: catalog.organizations?.[0]?.id ?? "BLU"
  };
}

function startSeasonApp(root) {
  let seedIndex = 1;
  let tab = "HOME";
  let gameView = "GAME";
  let playerSection = "RATINGS";
  let leagueSection = "STANDINGS";
  let moreSection = "ORG";
  let leaderCategory = "OPS";
  let orgPosition = "CF";
  let playerDetail = null;
  let majorEvent = null;
  let saveMessage = "";
  let launcherMessage = "";
  let backups = [];
  let saves = [];
  let snapshot = null;
  let currentSaveId = null;
  let currentSaveLabel = null;
  const masterSnapshot = globalThis.__THE_CALL_UP_MASTER_SNAPSHOT__ ?? null;
  const careerCatalog = seasonApi.getCareerCreationCatalog({ masterSnapshot });
  let creationSeed = null;
  let creationDraft = null;
  let creationMessage = "";

  const saveUi = () => ({ saveMessage, currentSaveId, backups, playerSection, leagueSection, moreSection, leaderCategory, orgPosition, playerDetail, majorEvent });

  const refreshSaves = async () => {
    saves = await seasonSaveService.listSaves();
    return saves;
  };

  const refreshBackups = async () => {
    if (!currentSaveId) {
      backups = [];
      return;
    }
    try {
      backups = await seasonBackupService.listBackups(currentSaveId);
    } catch (error) {
      backups = [];
      saveMessage = `백업 목록 실패: ${error?.message ?? error}`;
    }
  };

  const autosave = async ({ milestone = null } = {}) => {
    if (!snapshot || !currentSaveId) return false;
    try {
      const meta = await seasonSaveService.autosaveSeason(snapshot.seasonId, { saveId: currentSaveId });
      currentSaveLabel = meta.label;
      if (milestone) {
        await seasonBackupService.createMilestoneBackup(snapshot.seasonId, { saveId: currentSaveId, milestone });
        await refreshBackups();
        saveMessage = `자동 저장됨 · ${milestoneLabel(milestone)} 백업`;
      } else {
        saveMessage = "자동 저장됨";
      }
      return true;
    } catch (error) {
      saveMessage = `자동 저장 실패: ${error?.message ?? error}`;
      return false;
    }
  };

  let autosaveQueue = Promise.resolve(true);
  const waitForAutosaveIdle = () => new Promise((resolve) => {
    if (typeof globalThis.requestIdleCallback === "function") {
      globalThis.requestIdleCallback(() => resolve(), { timeout: 750 });
    } else {
      globalThis.setTimeout(resolve, 0);
    }
  });
  const queueAutosave = ({ milestone = null } = {}) => {
    autosaveQueue = autosaveQueue.catch(() => false).then(async () => {
      await waitForAutosaveIdle();
      return autosave({ milestone });
    });
    return autosaveQueue;
  };

  let careerRenderTimer = null;
  const scheduleCareerCreationRender = () => {
    if (careerRenderTimer != null) clearTimeout(careerRenderTimer);
    careerRenderTimer = setTimeout(() => {
      careerRenderTimer = null;
      if (creationSeed && creationDraft) renderCareerCreation();
    }, 0);
  };

  const renderCareerCreation = () => {
    if (!creationSeed || !creationDraft) return renderLauncher();
    let preview = null;
    let previewError = "";
    try {
      preview = seasonApi.previewNewCareer({ seed: creationSeed, input: creationDraft, masterSnapshot });
    } catch (error) {
      previewError = error?.message ?? String(error);
    }
    renderNewCareer(root, {
      draft: creationDraft,
      catalog: careerCatalog,
      preview,
      message: creationMessage || previewError
    }, {
      onBack() {
        creationSeed = null;
        creationDraft = null;
        creationMessage = "";
        renderLauncher();
      },
      onField(field, value) {
        creationDraft = { ...creationDraft, [field]: value };
        creationMessage = "";
        scheduleCareerCreationRender();
      },
      onTrait(trait, enabled) {
        const current = new Set(creationDraft.visibleTraits ?? []);
        if (enabled) {
          if (current.size >= 2 && !current.has(trait)) return;
          current.add(trait);
        } else current.delete(trait);
        creationDraft = { ...creationDraft, visibleTraits: [...current] };
        creationMessage = "";
        scheduleCareerCreationRender();
      },
      async onCreate() {
        try {
          creationMessage = "새 커리어 생성 중...";
          renderCareerCreation();
          snapshot = seasonApi.createCareerSeason({ seed: creationSeed, startDate: "2026-04-01", input: creationDraft, masterSnapshot });
          currentSaveId = snapshot.seasonId;
          currentSaveLabel = `${snapshot.userPlayer.name} · ${snapshot.userTeam.shortName} 커리어`;
          const createdAt = new Date().toISOString();
          await seasonSaveService.saveSeason(snapshot.seasonId, {
            saveId: currentSaveId,
            label: currentSaveLabel,
            extraMetadata: { createdAt }
          });
          await seasonBackupService.createMilestoneBackup(snapshot.seasonId, { saveId: currentSaveId, milestone: "OPENING_DAY" });
          await refreshBackups();
          saveMessage = "자동 저장됨 · 오프닝 데이 백업";
          creationMessage = "";
          creationSeed = null;
          creationDraft = null;
          launcherMessage = "";
          tab = "HOME";
          playerSection = "RATINGS";
          leagueSection = "STANDINGS";
          moreSection = "ORG";
          leaderCategory = "OPS";
          orgPosition = snapshot.organization?.userPosition ?? snapshot.userPlayer.primaryPosition ?? "CF";
          playerDetail = null;
          majorEvent = null;
          renderHome();
        } catch (error) {
          creationMessage = `새 커리어 생성 실패: ${error?.message ?? error}`;
          snapshot = null;
          currentSaveId = null;
          currentSaveLabel = null;
          renderCareerCreation();
        }
      }
    });
  };

  const renderLauncher = () => {
    renderSaveSelect(root, saves, {
      onNewCareer() {
        creationSeed = careerSeed(seedIndex++);
        creationDraft = defaultCareerDraft(careerCatalog);
        creationMessage = "";
        renderCareerCreation();
      },
      async onContinue(saveId) {
        try {
          launcherMessage = "커리어 불러오는 중...";
          renderLauncher();
          const meta = saves.find((row) => row.saveId === saveId) ?? null;
          const loaded = await seasonSaveService.loadSeason(saveId);
          if (!loaded) throw new RangeError("선택한 커리어를 찾을 수 없습니다.");
          snapshot = loaded;
          currentSaveId = saveId;
          currentSaveLabel = meta?.label ?? `${loaded.userPlayer.name} 커리어`;
          await refreshBackups();
          saveMessage = meta?.hasActiveGame ? "진행 중 경기를 복원했습니다." : "저장된 커리어를 이어갑니다.";
          launcherMessage = "";
          tab = "HOME";
          playerSection = "RATINGS";
          leagueSection = "STANDINGS";
          moreSection = "ORG";
          leaderCategory = "OPS";
          orgPosition = snapshot.organization?.userPosition ?? "CF";
          playerDetail = null;
          majorEvent = null;
          renderHome();
        } catch (error) {
          launcherMessage = `불러오기 실패: ${error?.message ?? error}`;
          snapshot = null;
          currentSaveId = null;
          renderLauncher();
        }
      },
      async onDelete(saveId) {
        const meta = saves.find((row) => row.saveId === saveId);
        const label = meta?.label ?? saveId;
        if (typeof globalThis.confirm === "function" && !globalThis.confirm(`'${label}' 커리어를 삭제할까요? 관련 자동 백업도 함께 삭제됩니다.`)) return;
        try {
          await seasonBackupService.deleteBackupsForSave(saveId);
          await seasonSaveService.deleteSave(saveId);
          launcherMessage = `삭제 완료 · ${label}`;
          await refreshSaves();
        } catch (error) {
          launcherMessage = `삭제 실패: ${error?.message ?? error}`;
        }
        renderLauncher();
      },
      async onImportFile(file) {
        try {
          launcherMessage = ".tcu 검증 중...";
          renderLauncher();
          const imported = await seasonTransferService.importAndLoadSeason(await file.text());
          snapshot = imported.snapshot;
          currentSaveId = imported.meta.saveId;
          currentSaveLabel = imported.meta.label;
          await refreshBackups();
          await refreshSaves();
          saveMessage = `가져오기 완료 · ${currentSaveLabel}`;
          launcherMessage = "";
          tab = "HOME";
          playerSection = "RATINGS";
          leagueSection = "STANDINGS";
          moreSection = "ORG";
          leaderCategory = "OPS";
          orgPosition = snapshot.organization?.userPosition ?? "CF";
          playerDetail = null;
          majorEvent = null;
          renderHome();
        } catch (error) {
          launcherMessage = `가져오기 실패: ${error?.message ?? error}`;
          renderLauncher();
        }
      }
    }, { message: launcherMessage });
  };

  const goToCareerSelect = async () => {
    if (snapshot && currentSaveId) await queueAutosave();
    snapshot = null;
    currentSaveId = null;
    currentSaveLabel = null;
    backups = [];
    playerDetail = null;
    majorEvent = null;
    playerSection = "RATINGS";
    leagueSection = "STANDINGS";
    moreSection = "ORG";
    leaderCategory = "OPS";
    orgPosition = "CF";
    saveMessage = "";
    launcherMessage = "";
    creationSeed = null;
    creationDraft = null;
    creationMessage = "";
    try {
      await refreshSaves();
    } catch (error) {
      launcherMessage = `커리어 목록 실패: ${error?.message ?? error}`;
      saves = [];
    }
    renderLauncher();
  };

  const renderHome = () => {
    if (!snapshot) return renderLauncher();
    renderSeason(root, snapshot, {
      onTab(nextTab) {
        tab = ["HOME", "PLAYER", "ORG", "LEAGUE", "MORE"].includes(nextTab) ? nextTab : "HOME";
        playerDetail = null;
        renderHome();
      },
      onPlayerSection(section) {
        playerSection = ["RATINGS", "SCOUTING", "STATS", "DEVELOPMENT", "CONTRACT", "CAREER"].includes(section) ? section : "RATINGS";
        playerDetail = null;
        renderHome();
      },
      onLeagueSection(section) {
        leagueSection = ["STANDINGS", "LEADERS", "PROSPECTS"].includes(section) ? section : "STANDINGS";
        playerDetail = null;
        renderHome();
      },
      onMoreSection(section) {
        moreSection = ["ORG", "FEED", "HISTORY", "SETTINGS"].includes(section) ? section : "ORG";
        playerDetail = null;
        renderHome();
      },
      onLeaderCategory(category) {
        if (snapshot.leaders?.categories?.[category]) leaderCategory = category;
        renderHome();
      },
      onOrgPosition(position) {
        if (snapshot.organization?.positionOptions?.includes(position)) orgPosition = position;
        playerDetail = null;
        renderHome();
      },
      onPlayerDetail(playerId) {
        try {
          playerDetail = seasonApi.getPlayerDetail(snapshot.seasonId, playerId);
        } catch (error) {
          saveMessage = `선수 정보 조회 실패: ${error?.message ?? error}`;
          playerDetail = null;
        }
        renderHome();
      },
      onPlayerDetailClose() {
        playerDetail = null;
        renderHome();
      },
      onMajorEventDismiss() {
        majorEvent = null;
        renderHome();
      },
      async onTrainingFocus(focus) {
        snapshot = seasonApi.setTrainingFocus(snapshot.seasonId, focus);
        renderHome();
        void queueAutosave();
      },
      async onImportFile(file) {
        try {
          saveMessage = ".tcu 검증 중...";
          renderHome();
          const imported = await seasonTransferService.importAndLoadSeason(await file.text());
          snapshot = imported.snapshot;
          currentSaveId = imported.meta.saveId;
          currentSaveLabel = imported.meta.label;
          await refreshBackups();
          tab = "HOME";
          playerDetail = null;
          majorEvent = null;
          saveMessage = `가져오기 완료 · ${currentSaveLabel}`;
        } catch (error) {
          saveMessage = `가져오기 실패: ${error?.message ?? error}`;
        }
        renderHome();
      },
      async onRestoreBackup(backupId) {
        try {
          saveMessage = "마일스톤 백업 검증 중...";
          renderHome();
          const restored = await seasonBackupService.restoreBackupAsCopy(backupId);
          if (!restored) {
            saveMessage = "복구할 백업을 찾을 수 없습니다.";
          } else {
            snapshot = restored.snapshot;
            currentSaveId = restored.meta.saveId;
            currentSaveLabel = restored.meta.label;
            await refreshBackups();
            tab = "HOME";
            playerDetail = null;
            majorEvent = null;
            saveMessage = `백업 복구 완료 · ${currentSaveLabel}`;
          }
        } catch (error) {
          saveMessage = `백업 복구 실패: ${error?.message ?? error}`;
        }
        renderHome();
      },
      async onAction(action) {
        if (action === "CAREERS") {
          await goToCareerSelect();
          return;
        }
        if (action === "PLAY") {
          saveMessage = "";
          snapshot = seasonApi.startCurrentGame(snapshot.seasonId);
          if (snapshot.activeGame) {
            gameView = "GAME";
            renderGame();
            void queueAutosave();
          }
          return;
        }
        if (action === "SAVE") {
          try {
            await autosaveQueue.catch(() => false);
            const meta = await seasonSaveService.saveSeason(snapshot.seasonId, { saveId: currentSaveId });
            currentSaveLabel = meta.label;
            saveMessage = "수동 저장 완료";
          } catch (error) {
            saveMessage = `저장 실패: ${error?.message ?? error}`;
          }
          renderHome();
          return;
        }
        if (action === "LOAD") {
          try {
            const loaded = await seasonSaveService.loadSeason(currentSaveId);
            if (loaded) {
              snapshot = loaded;
              await refreshBackups();
              tab = "HOME";
              playerDetail = null;
              saveMessage = "현재 커리어의 저장 상태를 다시 불러왔습니다.";
            } else {
              saveMessage = "불러올 저장 데이터가 없습니다.";
            }
          } catch (error) {
            saveMessage = `불러오기 실패: ${error?.message ?? error}`;
          }
          renderHome();
          return;
        }
        if (action === "EXPORT") {
          try {
            const exported = seasonTransferService.exportSeason(snapshot.seasonId, { saveId: currentSaveId, label: currentSaveLabel ?? "THE CALL-UP 커리어" });
            downloadTextFile(exported);
            saveMessage = `.tcu 내보내기 완료 · SHA-256 ${exported.checksum.slice(0, 12)}…`;
          } catch (error) {
            saveMessage = `내보내기 실패: ${error?.message ?? error}`;
          }
          renderHome();
          return;
        }
        if (action === "IMPORT") {
          root.querySelector("[data-tcu-import]")?.click();
          return;
        }
        const previousStatus = snapshot.status;
        const previousYear = snapshot.seasonYear;
        const previousCareerSequence = latestCareerSequence(snapshot);
        if (action === "START_POSTSEASON") snapshot = seasonApi.startPostseason(snapshot.seasonId);
        if (action === "POSTSEASON_NEXT") snapshot = seasonApi.advancePostseasonRound(snapshot.seasonId);
        if (action === "START_OFFSEASON") snapshot = seasonApi.startOffseason(snapshot.seasonId);
        if (action === "OFFSEASON_NEXT") snapshot = seasonApi.advanceOffseasonPhase(snapshot.seasonId);
        if (action === "SIM_GAME") snapshot = seasonApi.simulateCurrentGame(snapshot.seasonId);
        if (action === "SIM_SERIES") snapshot = seasonApi.simulateCurrentSeries(snapshot.seasonId);
        if (action === "SIM_7_DAYS") snapshot = seasonApi.simulateSevenDays(snapshot.seasonId);
        if (action === "SIM_IMPORTANT") snapshot = seasonApi.simulateToImportantEvent(snapshot.seasonId);
        majorEvent = latestMajorCareerEvent(snapshot, previousCareerSequence);
        const milestone = action === "START_OFFSEASON" ? "OFFSEASON_START"
          : previousStatus === "OFFSEASON" && snapshot.status === "REGULAR_SEASON" && snapshot.seasonYear > previousYear ? "OPENING_DAY"
          : previousStatus !== "COMPLETE" && snapshot.status === "COMPLETE" ? "SEASON_END" : null;
        tab = "HOME";
        renderHome();
        if (milestone) {
          await queueAutosave({ milestone });
          renderHome();
        } else {
          void queueAutosave();
        }
      }
    }, tab, saveUi());
  };

  const returnToSeason = async () => {
    if (snapshot.activeGame?.status === "FINAL") snapshot = seasonApi.closeActiveGame(snapshot.seasonId);
    else snapshot = seasonApi.getSeason(snapshot.seasonId);
    tab = "HOME";
    renderHome();
    await queueAutosave();
    snapshot = seasonApi.getSeason(snapshot.seasonId);
    renderHome();
  };

  const renderGame = () => {
    if (!snapshot?.activeGame) return renderHome();
    renderQuickAB(root, snapshot.activeGame, {
      onApproach(approach) {
        const previousStatus = snapshot.status;
        const previousCareerSequence = latestCareerSequence(snapshot);
        snapshot = seasonApi.playUserPA(snapshot.seasonId, approach);
        majorEvent = latestMajorCareerEvent(snapshot, previousCareerSequence) ?? majorEvent;
        const milestone = previousStatus !== "COMPLETE" && snapshot.status === "COMPLETE" ? "SEASON_END" : null;
        renderGame();
        void queueAutosave({ milestone });
      },
      onRunningChoice(choice) {
        const previousStatus = snapshot.status;
        const previousCareerSequence = latestCareerSequence(snapshot);
        snapshot = seasonApi.resolveUserRunningDecision(snapshot.seasonId, choice);
        majorEvent = latestMajorCareerEvent(snapshot, previousCareerSequence) ?? majorEvent;
        const milestone = previousStatus !== "COMPLETE" && snapshot.status === "COMPLETE" ? "SEASON_END" : null;
        renderGame();
        void queueAutosave({ milestone });
      },
      onView(view) {
        gameView = view === "BOX" ? "BOX" : "GAME";
        renderGame();
      },
      onReset() {
        void returnToSeason();
      }
    }, gameView, {
      resetLabel: "시즌 홈",
      finalActionLabel: "시즌 홈"
    });
  };

  const bootstrapPersistence = async () => {
    try {
      await refreshSaves();
    } catch (error) {
      saves = [];
      launcherMessage = `커리어 목록 준비 실패: ${error?.message ?? error}`;
    }
    renderLauncher();
  };

  renderLauncher();
  void bootstrapPersistence();
}

export { startSeasonApp };
