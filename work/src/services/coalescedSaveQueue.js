// Merge only adjacent autosaves belonging to the same career; milestone boundaries
// carry immutable serialized payloads captured by the caller.
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
  function sameContext(a, b) {
    return (a?.seasonId ?? null) === (b?.seasonId ?? null) &&
      (a?.saveId ?? null) === (b?.saveId ?? null);
  }
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
          outcome = await save({ milestone: entry.milestone, context: entry.context });
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
  function request({ milestone = null, context = null } = {}) {
    if (milestone !== null && (typeof milestone !== "string" || !milestone)) {
      throw new TypeError("milestone must be null or a non-empty string");
    }
    requested += 1;
    let entry = pending.at(-1);
    if (milestone === null && entry && entry.milestone === null && sameContext(entry.context, context)) {
      coalesced += 1;
    } else {
      entry = { milestone, context, waiters: [] };
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
