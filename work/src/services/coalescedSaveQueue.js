// A high-frequency user PA may schedule many full-world IndexedDB writes.
// Merge ONLY adjacent ordinary autosaves. Never merge a milestone with another
// milestone or a normal write across a milestone boundary.
function createCoalescedSaveQueue({ save, waitForIdle = async () => {} } = {}) {
  if (typeof save !== "function" || typeof waitForIdle !== "function") {
    throw new TypeError("save and waitForIdle callbacks are required");
  }
  const pending = [];
  let processing = false;
  let requested = 0;
  let attemptedWrites = 0;
  let coalesced = 0;
  let failed = 0;

  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (pending.length) {
        const entry = pending.shift();
        let outcome = false;
        try {
          await waitForIdle();
          attemptedWrites += 1;
          // The actual save takes the latest authoritative season snapshot.
          outcome = await save({ milestone: entry.milestone });
          if (outcome === false) failed += 1;
        } catch {
          failed += 1;
          outcome = false;
        }
        for (const resolve of entry.waiters) resolve(outcome);
      }
    } finally {
      processing = false;
      if (pending.length) void drain();
    }
  }

  function request({ milestone = null } = {}) {
    if (milestone !== null && (typeof milestone !== "string" || !milestone)) {
      throw new TypeError("milestone must be null or a non-empty string");
    }
    requested += 1;
    let entry = pending.at(-1);
    if (milestone === null && entry && entry.milestone === null) {
      coalesced += 1;
    } else {
      entry = { milestone, waiters: [] };
      pending.push(entry);
    }
    return new Promise(resolve => {
      entry.waiters.push(resolve);
      void drain();
    });
  }

  function diagnostics() {
    return Object.freeze({ requested, attemptedWrites, coalesced,
      failed, pending: pending.length, processing });
  }
  return Object.freeze({ request, diagnostics });
}

export { createCoalescedSaveQueue };
