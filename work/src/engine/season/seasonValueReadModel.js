// Season value is a transparent, read-only estimate from recorded events.
// It is NOT official fWAR/bWAR: granular fielding, park and defensive support
// are not available consistently across all five levels. Never feed these
// estimates into manager, promotion, award or trade decisions.
const POSITION_RUNS_PER_600_PA = Object.freeze({ C: 11, SS: 7, '2B': 2, '3B': 1, CF: 2, RF: -5, LF: -5, '1B': -10, DH: -15 });
const WOB_COEFFICIENTS = Object.freeze({ BB: 0.69, HBP: 0.72, single: 0.89, double: 1.27, triple: 1.62, HR: 2.10 });
const RUNS_PER_WIN = 10;
const REPLACEMENT_RUNS_PER_600_PA = 20;
function finiteNonnegative(line, key) {
  const value = Number(line?.[key] ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`기록 ${key}가 0 이상의 유한수여야 합니다.`);
  return value;
}
function battingEvents(line) {
  const H = finiteNonnegative(line, 'H');
  const doubles = finiteNonnegative(line, 'doubles');
  const triples = finiteNonnegative(line, 'triples');
  const HR = finiteNonnegative(line, 'HR');
  const singles = H - doubles - triples - HR;
  if (singles < 0) throw new RangeError('안타 세부 기록이 총 안타보다 많습니다.');
  const AB = finiteNonnegative(line, 'AB');
  const BB = finiteNonnegative(line, 'BB');
  const HBP = finiteNonnegative(line, 'HBP');
  const SF = finiteNonnegative(line, 'SF');
  const PA = finiteNonnegative(line, 'PA');
  if (H > AB || AB + BB + HBP + SF > PA + 1) throw new RangeError('타격 기록 합계가 타석과 일치하지 않습니다.');
  const denom = AB + BB + HBP + SF;
  return { PA, denom, weighted: WOB_COEFFICIENTS.BB * BB + WOB_COEFFICIENTS.HBP * HBP + WOB_COEFFICIENTS.single * singles + WOB_COEFFICIENTS.double * doubles + WOB_COEFFICIENTS.triple * triples + WOB_COEFFICIENTS.HR * HR,
    SB: finiteNonnegative(line, 'SB'), CS: finiteNonnegative(line, 'CS') };
}
function round(value, decimals = 2) { return Number(value.toFixed(decimals)); }
function leagueBattingEnvironment(leagueLines) {
  let PA = 0, denom = 0, weighted = 0;
  for (const line of Object.values(leagueLines ?? {})) {
    const row = battingEvents(line);
    PA += row.PA; denom += row.denom; weighted += row.weighted;
  }
  return { PA, woba: denom > 0 ? weighted / denom : null };
}
function estimateHitterSeasonValue({ line, leagueLines, position = 'DH', level = 'AAA' } = {}) {
  const batter = battingEvents(line ?? {});
  const league = leagueBattingEnvironment(leagueLines);
  const basis = { schemaVersion: 1, model: 'PARTIAL_WAR_LIKE_V1', level, position,
    status: 'INSUFFICIENT_SAMPLE', officialWar: false, fieldingIncluded: false,
    parkAdjusted: false, defenseIndependent: false, input: 'OFFICIAL_REGULAR_SEASON_LINES',
    PA: batter.PA, leaguePA: league.PA };
  if (batter.PA < 15 || batter.denom === 0 || league.PA < 250 || league.woba === null) return Object.freeze(basis);
  const woba = batter.weighted / batter.denom;
  const battingRuns = (woba - league.woba) * batter.denom / 1.25;
  const runningRuns = 0.18 * batter.SB - 0.40 * batter.CS;
  const positionalRuns = (POSITION_RUNS_PER_600_PA[position] ?? 0) * batter.PA / 600;
  const replacementRuns = REPLACEMENT_RUNS_PER_600_PA * batter.PA / 600;
  const partialRuns = battingRuns + runningRuns + positionalRuns + replacementRuns;
  return Object.freeze({ ...basis, status: 'READY', woba: round(woba, 3), leagueWoba: round(league.woba, 3),
    battingRuns: round(battingRuns), runningRuns: round(runningRuns), positionalRuns: round(positionalRuns),
    replacementRuns: round(replacementRuns), partialRuns: round(partialRuns), partialWins: round(partialRuns / RUNS_PER_WIN),
    sampleBand: batter.PA >= 400 ? 'LARGE' : batter.PA >= 120 ? 'MEDIUM' : 'SMALL' });
}
function estimatePitcherSeasonValue({ line, leagueLines, level = 'MLB' } = {}) {
  let leagueR = 0, leagueOuts = 0;
  for (const row of Object.values(leagueLines ?? {})) {
    leagueR += finiteNonnegative(row, 'R');
    leagueOuts += finiteNonnegative(row, 'outsRecorded');
  }
  const outs = finiteNonnegative(line, 'outsRecorded');
  const R = finiteNonnegative(line, 'R');
  const basis = { schemaVersion: 1, model: 'PARTIAL_RA9_VALUE_V1', level, status: 'INSUFFICIENT_SAMPLE',
    officialWar: false, parkAdjusted: false, fieldingAdjusted: false, defenseIndependent: false,
    outsRecorded: outs, leagueOutsRecorded: leagueOuts };
  if (outs < 9 || leagueOuts < 750) return Object.freeze(basis);
  const leagueRA9 = 27 * leagueR / leagueOuts;
  const pitcherRA9 = 27 * R / outs;
  const runsPrevented = (leagueRA9 - pitcherRA9) * outs / 27;
  return Object.freeze({ ...basis, status: 'READY', leagueRA9: round(leagueRA9, 3), pitcherRA9: round(pitcherRA9, 3),
    runsPrevented: round(runsPrevented), partialWins: round(runsPrevented / RUNS_PER_WIN),
    sampleBand: outs >= 450 ? 'LARGE' : outs >= 150 ? 'MEDIUM' : 'SMALL' });
}
export { leagueBattingEnvironment, estimateHitterSeasonValue, estimatePitcherSeasonValue };
