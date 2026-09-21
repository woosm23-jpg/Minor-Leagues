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

function metadataOnly(record) {
  if (!record) return null;
  const { payload: _payload, ...meta } = record;
  return meta;
}

function createSeasonSaveRepository({ openDb = openDatabase } = {}) {
  return Object.freeze({
    async put(record) {
      if (!record?.saveId || !record?.payload) throw new TypeError("saveId와 payload가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction(["saves", "save_meta"], "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("saves").put(record);
        tx.objectStore("save_meta").put(metadataOnly(record));
        await done;
        return record;
      } finally {
        db.close?.();
      }
    },

    async get(saveId) {
      if (typeof saveId !== "string" || !saveId) throw new TypeError("saveId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("saves", "readonly");
        const done = transactionDone(tx);
        const result = await requestResult(tx.objectStore("saves").get(saveId));
        await done;
        return result ?? null;
      } finally {
        db.close?.();
      }
    },

    async getMeta(saveId) {
      if (typeof saveId !== "string" || !saveId) throw new TypeError("saveId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction("save_meta", "readonly");
        const done = transactionDone(tx);
        const result = await requestResult(tx.objectStore("save_meta").get(saveId));
        await done;
        return result ?? null;
      } finally {
        db.close?.();
      }
    },

    async list() {
      const db = await openDb();
      try {
        const tx = db.transaction("save_meta", "readonly");
        const done = transactionDone(tx);
        const rows = await requestResult(tx.objectStore("save_meta").getAll());
        await done;
        return (rows ?? []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.saveId).localeCompare(String(b.saveId)));
      } finally {
        db.close?.();
      }
    },

    async delete(saveId) {
      if (typeof saveId !== "string" || !saveId) throw new TypeError("saveId가 필요합니다.");
      const db = await openDb();
      try {
        const tx = db.transaction(["saves", "save_meta"], "readwrite");
        const done = transactionDone(tx);
        tx.objectStore("saves").delete(saveId);
        tx.objectStore("save_meta").delete(saveId);
        await done;
        return true;
      } finally {
        db.close?.();
      }
    }
  });
}

const seasonSaveRepository = createSeasonSaveRepository();

export { createSeasonSaveRepository, seasonSaveRepository };
