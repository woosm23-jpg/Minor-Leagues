const DB_NAME = "the-call-up";
const DB_VERSION = 3;

function metadataFromLegacyRecord(record) {
  if (!record || typeof record !== "object") return null;
  const { payload, ...meta } = record;
  if (!meta.saveId) return null;
  if (!payload?.fixture || !payload?.season) return meta;
  const teamId = payload.fixture.userTeamId;
  const playerId = payload.fixture.userPlayerId;
  const roster = payload.fixture.rosters?.[teamId];
  const team = payload.season.teams?.[teamId] ?? payload.fixture.teams?.[teamId] ?? null;
  const line = payload.season.standings?.[teamId] ?? { W: 0, L: 0 };
  const schedule = (payload.season.schedule ?? []).filter((game) => game.awayTeamId === teamId || game.homeTeamId === teamId);
  return {
    ...meta,
    userPlayerName: meta.userPlayerName ?? roster?.names?.[playerId] ?? playerId ?? "선수",
    userTeamName: meta.userTeamName ?? team?.name ?? teamId ?? "팀",
    userTeamShortName: meta.userTeamShortName ?? team?.shortName ?? teamId ?? "",
    wins: meta.wins ?? Number(line.W ?? 0),
    losses: meta.losses ?? Number(line.L ?? 0),
    gamesPlayed: meta.gamesPlayed ?? schedule.filter((game) => game.status === "FINAL").length,
    totalGames: meta.totalGames ?? schedule.length
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains("saves")) {
        db.createObjectStore("saves", { keyPath: "saveId" });
      }
      if (!db.objectStoreNames.contains("backups")) {
        db.createObjectStore("backups", { keyPath: "backupId" });
      }
      let metaStore = null;
      if (!db.objectStoreNames.contains("save_meta")) {
        metaStore = db.createObjectStore("save_meta", { keyPath: "saveId" });
      }

      // v17 and earlier stored metadata beside the heavy payload in `saves`.
      // Build the lightweight Continue index once during the DB v3 upgrade.
      if (metaStore && request.transaction) {
        const savesStore = request.transaction.objectStore("saves");
        if (typeof savesStore.openCursor === "function") {
          const cursorRequest = savesStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const meta = metadataFromLegacyRecord(cursor.value);
            if (meta) metaStore.put(meta);
            cursor.continue();
          };
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export { openDatabase };
