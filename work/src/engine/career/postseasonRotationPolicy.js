import { pitcherAvailability } from '../season/pitcherSeasonState.js';
import { assessBullpenRecovery } from '../season/bullpenRecoveryPolicy.js';

const DEFAULT_ROTATION_SIZE = 4;
const MS_PER_DAY = 86400000;

function isoDay(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label}는 YYYY-MM-DD여야 합니다.`);
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new RangeError(`${label}가 잘못된 날짜입니다.`);
  return time / MS_PER_DAY;
}

function appearanceGap(gameDay, state) {
  const prior = state?.lastAppearanceDate;
  if (prior == null) return null;
  const gap = gameDay - isoDay(prior, 'lastAppearanceDate');
  if (gap < 0) throw new RangeError('postseason pitcher lastAppearanceDate가 경기 날짜보다 미래입니다.');
  return gap;
}

function requiredRestDays(lastPitchCount) {
  const count = Math.max(0, Number(lastPitchCount ?? 0) || 0);
  // Calendar-day gap, not the number of full off-days.
  if (count >= 70) return 4;
  if (count >= 35) return 3;
  if (count > 0) return 2;
  return 1;
}

function selectPostseasonStarter(roster, pitcherStates = {}, {
  gameDate, gameIndex = 0, rotationSize = DEFAULT_ROTATION_SIZE
} = {}) {
  if (!roster || typeof roster !== 'object') throw new TypeError('postseason roster가 필요합니다.');
  if (!Number.isInteger(gameIndex) || gameIndex < 0) throw new RangeError('gameIndex가 잘못되었습니다.');
  if (![3,4].includes(rotationSize)) throw new RangeError('postseason rotationSize는 3 또는 4여야 합니다.');
  const gameDay = isoDay(gameDate, 'gameDate');
  const starters = [...new Set((roster.starters ?? []).map(String))].filter(id => roster.pitchers?.includes(id));
  const bullpen = [...new Set((roster.bullpen ?? []).map(String))].filter(id => roster.pitchers?.includes(id) && !starters.includes(id));
  if (!starters.length && !bullpen.length) throw new RangeError('postseason 투수 명단이 비었습니다.');
  const rotation = starters.slice(0, rotationSize);
  const slot = gameIndex % rotationSize;
  const scheduled = rotation[slot] ?? null;

  function view(id) {
    const state = pitcherStates?.[id] ?? null;
    const availability = pitcherAvailability(state);
    const gap = appearanceGap(gameDay, state);
    const pitchCount = Math.max(0, Number(state?.lastPitchCount ?? 0) || 0);
    const fatigue = Number(state?.fatigue ?? 0);
    const minGap = requiredRestDays(pitchCount);
    return { id, availability, gap, pitchCount, fatigue, minGap,
      rested: availability !== 'INJURED' && availability !== 'UNAVAILABLE' && fatigue < 58 && (gap == null || gap >= minGap) };
  }
  function result(id, reason) {
    const v = view(id);
    return Object.freeze({starterId: id, reason, rotationSize, rotationSlot: slot,
      daysSinceLastAppearance: v.gap, lastPitchCount: v.pitchCount, pregameFatigue: v.fatigue});
  }
  const orderedRotation = [...rotation.slice(slot), ...rotation.slice(0, slot)].filter(Boolean);
  const preferred = orderedRotation.map(view);
  const ready = preferred.find(v => v.rested && v.availability === 'READY');
  if (ready) return result(ready.id, ready.id === scheduled ? 'ROTATION' : 'ROTATION_BACKUP');
  const limited = preferred.find(v => v.rested);
  if (limited) return result(limited.id, limited.id === scheduled ? 'ROTATION_LIMITED' : 'ROTATION_BACKUP_LIMITED');

  const fifth = starters.slice(rotationSize).map(view);
  const availableFifth = fifth.find(v => v.rested && v.availability === 'READY') ?? fifth.find(v => v.rested);
  if (availableFifth) return result(availableFifth.id, 'FIFTH_STARTER');

  const bullpenChoices = bullpen.map(view).filter(v => {
    if (!v.rested) return false;
    return assessBullpenRecovery({gameDate, lastAppearanceDate:pitcherStates?.[v.id]?.lastAppearanceDate ?? null,
      lastPitchCount:v.pitchCount}).status !== 'REST';
  });
  const bullpenPick = bullpenChoices.find(v => v.availability === 'READY') ?? bullpenChoices[0];
  if (bullpenPick) return result(bullpenPick.id, 'BULLPEN_DAY');

  // Only when there is no rested starter or bullpen-day option. Never use an
  // injured pitcher; prefer a longer gap and lower fatigue before roster order.
  const emergency = [...starters, ...bullpen].map(view).filter(v => v.availability !== 'INJURED')
    .sort((a,b) => ((b.gap ?? 1000) - (a.gap ?? 1000)) || a.fatigue-b.fatigue || a.id.localeCompare(b.id))[0];
  if (!emergency) throw new RangeError('postseason에서 등판 가능한 건강한 투수가 없습니다.');
  return result(emergency.id, 'EMERGENCY_SHORT_REST');
}

export { DEFAULT_ROTATION_SIZE, requiredRestDays, selectPostseasonStarter };
