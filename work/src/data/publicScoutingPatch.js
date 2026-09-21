function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freeze(v)])));
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export function publicScoutingGrade(value) {
  if (value == null) return null;
  if (typeof value === 'number' || typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') {
    for (const key of ['grade', 'future', 'value', 'fv']) {
      const n = Number(value[key]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function applyPublicScoutingPatchToSnapshot(snapshot, patch, { requireBaseHash = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.players)) throw new TypeError('snapshot.players가 필요합니다.');
  if (!patch || typeof patch !== 'object' || !Array.isArray(patch.records)) throw new TypeError('public scouting patch.records가 필요합니다.');
  const baseHash = String(snapshot.metadata?.contentHash ?? '');
  const patchHash = String(patch.baseSnapshotHash ?? '');
  if (requireBaseHash && (!baseHash || !patchHash || baseHash !== patchHash)) {
    throw new RangeError(`public scouting base hash mismatch: ${patchHash || 'MISSING'} != ${baseHash || 'MISSING'}`);
  }

  const playerIds = new Set(snapshot.players.map((p) => String(p.id)));
  const byId = new Map();
  const unknown = [];
  for (const row of patch.records) {
    const id = String(row?.playerId ?? '');
    if (!id) throw new RangeError('public scouting record playerId가 없습니다.');
    if (byId.has(id)) throw new RangeError(`public scouting playerId 중복: ${id}`);
    if (!playerIds.has(id)) { unknown.push(id); continue; }
    if (!row.publicScouting || typeof row.publicScouting !== 'object') throw new RangeError(`public scouting payload가 없습니다: ${id}`);
    byId.set(id, clone(row.publicScouting));
  }
  if (unknown.length) throw new RangeError(`snapshot에 없는 public scouting playerId: ${unknown.slice(0, 8).join(',')}${unknown.length > 8 ? '...' : ''}`);

  const players = snapshot.players.map((p) => byId.has(String(p.id)) ? { ...p, publicScouting: byId.get(String(p.id)) } : { ...p });
  const metadata = {
    ...(snapshot.metadata ?? {}),
    stagedPublicScouting: {
      schema: patch.schema ?? null,
      sha256: patch.sha256 ?? null,
      createdAt: patch.createdAt ?? null,
      matchedPlayers: byId.size
    }
  };
  return freeze({ ...snapshot, metadata, players });
}
