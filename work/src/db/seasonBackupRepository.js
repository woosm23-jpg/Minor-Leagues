import { openDatabase } from "./db.js";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function createSeasonBackupRepository({ openDb = openDatabase } = {}) {
  return Object.freeze({
    async put(record) {
      if (!record?.backupId || !record?.saveId || !record?.payload) throw new TypeError("backupId, saveId와 payload가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("backups", "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("backups").put(record);
        await done;
        return record;
      } finally {
        db.close?.();
      }
    },

    async get(backupId) {
      if (typeof backupId !== "string" || !backupId) throw new TypeError("backupId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("backups", "readonly");
        const done = transactionDone(tx);
        const result = await requestResult(tx.objectStore("backups").get(backupId));
        await done;
        return result ?? null;
      } finally {
        db.close?.();
      }
    },

    async listBySaveId(saveId) {
      if (typeof saveId !== "string" || !saveId) throw new TypeError("saveId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("backups", "readonly");
        const done = transactionDone(tx);
        const rows = await requestResult(tx.objectStore("backups").getAll());
        await done;
        return (rows ?? [])
          .filter((row) => row.saveId === saveId)
          .map(({ payload: _payload, ...meta }) => meta)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.backupId).localeCompare(String(a.backupId)));
      } finally {
        db.close?.();
      }
    },

    async delete(backupId) {
      if (typeof backupId !== "string" || !backupId) throw new TypeError("backupId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("backups", "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("backups").delete(backupId);
        await done;
        return true;
      } finally {
        db.close?.();
      }
    },

    async deleteBySaveId(saveId) {
      if (typeof saveId !== "string" || !saveId) throw new TypeError("saveId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("backups", "readwrite");
        const done = transactionDone(tx);
        const store = tx.objectStore("backups");
        const rows = await requestResult(store.getAll());
        let deleted = 0;
        for (const row of rows ?? []) {
          if (row.saveId !== saveId) continue;
          store.delete(row.backupId);
          deleted += 1;
        }
        await done;
        return deleted;
      } finally {
        db.close?.();
      }
    }
  });
}

const seasonBackupRepository = createSeasonBackupRepository();

export { createSeasonBackupRepository, seasonBackupRepository };
