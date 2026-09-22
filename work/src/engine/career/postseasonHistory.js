const POSTSEASON_STATE_VERSION = 1;
const HISTORY_STATE_VERSION = 1;
const POSTSEASON_ROUND_ORDER = Object.freeze(["WILD_CARD","DIVISION_SERIES","LCS","WORLD_SERIES"]);
const POSTSEASON_RULESET_2026 = Object.freeze({
  id: "ruleset_2026_postseason",
  teamsPerLeague: 6,
  divisionWinnersPerLeague: 3,
  wildCardsPerLeague: 3,
  firstRoundByesPerLeague: 2,
  rosterSize: 26,
  maxPitchers: 13,
  secondHalfStartMonthDay: "07-16",
  rounds: Object.freeze({
    WILD_CARD: Object.freeze({ bestOf: 3, homePattern: Object.freeze([1,1,1]) }),
    DIVISION_SERIES: Object.freeze({ bestOf: 5, homePattern: Object.freeze([1,1,0,0,1]) }),
    LCS: Object.freeze({ bestOf: 7, homePattern: Object.freeze([1,1,0,0,0,1,1]) }),
    WORLD_SERIES: Object.freeze({ bestOf: 7, homePattern: Object.freeze([1,1,0,0,0,1,1]) })
  }),
  scheduleMonthDays: Object.freeze({
    WILD_CARD: Object.freeze(["09-29","09-30","10-01"]),
    NL_DIVISION_SERIES: Object.freeze(["10-03","10-04","10-06","10-07","10-09"]),
    AL_DIVISION_SERIES: Object.freeze(["10-03","10-05","10-07","10-08","10-10"]),
    NL_LCS: Object.freeze(["10-11","10-12","10-14","10-15","10-16","10-18","10-19"]),
    AL_LCS: Object.freeze(["10-12","10-13","10-15","10-16","10-17","10-19","10-20"]),
    WORLD_SERIES: Object.freeze(["10-23","10-24","10-26","10-27","10-28","10-30","10-31"])
  }),
  tiebreakOrder: Object.freeze(["HEAD_TO_HEAD","INTRADIVISION","INTRALEAGUE","SECOND_HALF_INTRALEAGUE","SECOND_HALF_PLUS_ONE"]),
  sourceVerifiedDate: "2026-09-22"
});

function clone(v){ return structuredClone(v); }
function assertObject(v,label){ if(!v||typeof v!=="object"||Array.isArray(v)) throw new TypeError(`${label}가 필요합니다.`); }

function emptyPostseasonStats(){
  return { batting:{}, pitching:{}, worldSeriesBatting:{}, worldSeriesPitching:{} };
}

function createPostseasonState({seasonYear, field, rosters, user} = {}){
  if(!Number.isInteger(seasonYear)) throw new TypeError("postseason seasonYear가 필요합니다.");
  assertObject(field,"postseason field");
  assertObject(rosters,"postseason rosters");
  assertObject(user,"postseason user");
  const state={
    schemaVersion:POSTSEASON_STATE_VERSION,
    rulesetId:POSTSEASON_RULESET_2026.id,
    seasonYear,
    status:"ACTIVE",
    currentRound:"WILD_CARD",
    field:clone(field),
    rosters:clone(rosters),
    user:clone(user),
    rounds:{WILD_CARD:[],DIVISION_SERIES:[],LCS:[],WORLD_SERIES:[]},
    stats:emptyPostseasonStats(),
    championTeamId:null,
    runnerUpTeamId:null,
    completedDate:null
  };
  validatePostseasonState(state);
  return state;
}

function validatePostseasonState(state,label="postseasonState"){
  if(state===null||state===undefined) return true;
  assertObject(state,label);
  if(state.schemaVersion!==POSTSEASON_STATE_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  if(state.rulesetId!==POSTSEASON_RULESET_2026.id) throw new RangeError(`${label}.rulesetId가 호환되지 않습니다.`);
  if(!Number.isInteger(state.seasonYear)) throw new TypeError(`${label}.seasonYear가 필요합니다.`);
  if(!["ACTIVE","COMPLETE"].includes(state.status)) throw new RangeError(`${label}.status가 잘못되었습니다.`);
  if(state.status==="ACTIVE" && !POSTSEASON_ROUND_ORDER.includes(state.currentRound)) throw new RangeError(`${label}.currentRound가 잘못되었습니다.`);
  if(state.status==="COMPLETE" && state.currentRound!==null) throw new RangeError(`${label}.COMPLETE인데 currentRound가 남았습니다.`);
  assertObject(state.field,`${label}.field`);
  assertObject(state.rosters,`${label}.rosters`);
  for(const [teamId,ids] of Object.entries(state.rosters)){
    if(!Array.isArray(ids) || ids.length<20 || ids.length>POSTSEASON_RULESET_2026.rosterSize) throw new RangeError(`${label}.rosters.${teamId} 크기가 잘못되었습니다.`);
    if(new Set(ids).size!==ids.length) throw new RangeError(`${label}.rosters.${teamId}가 중복됩니다.`);
  }
  assertObject(state.user,`${label}.user`);
  assertObject(state.rounds,`${label}.rounds`);
  for(const round of POSTSEASON_ROUND_ORDER){
    if(!Array.isArray(state.rounds[round])) throw new TypeError(`${label}.rounds.${round}는 배열이어야 합니다.`);
  }
  assertObject(state.stats,`${label}.stats`);
  for(const key of ["batting","pitching","worldSeriesBatting","worldSeriesPitching"]) assertObject(state.stats[key],`${label}.stats.${key}`);
  if(state.status==="COMPLETE"){
    if(typeof state.championTeamId!=="string"||!state.championTeamId) throw new TypeError(`${label}.championTeamId가 필요합니다.`);
    if(typeof state.runnerUpTeamId!=="string"||!state.runnerUpTeamId) throw new TypeError(`${label}.runnerUpTeamId가 필요합니다.`);
    if(typeof state.completedDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(state.completedDate)) throw new TypeError(`${label}.completedDate가 필요합니다.`);
  }
  return true;
}

function normalizePostseasonState(existing){
  if(existing===undefined||existing===null) return null;
  validatePostseasonState(existing);
  return clone(existing);
}

function getPostseasonPublicView(state){
  if(!state) return null;
  validatePostseasonState(state);
  return Object.freeze({
    seasonYear:state.seasonYear,
    status:state.status,
    currentRound:state.currentRound,
    field:clone(state.field),
    user:clone(state.user),
    rounds:clone(state.rounds),
    championTeamId:state.championTeamId,
    runnerUpTeamId:state.runnerUpTeamId,
    completedDate:state.completedDate
  });
}

function createHistoryState(){ return {schemaVersion:HISTORY_STATE_VERSION,seasons:[]}; }

function validateHistoryState(state,label="historyState"){
  if(state===null||state===undefined) return true;
  assertObject(state,label);
  if(state.schemaVersion!==HISTORY_STATE_VERSION) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);
  if(!Array.isArray(state.seasons)) throw new TypeError(`${label}.seasons는 배열이어야 합니다.`);
  const years=new Set();
  for(const row of state.seasons){
    assertObject(row,`${label}.season`);
    if(!Number.isInteger(row.seasonYear)) throw new TypeError(`${label}.seasonYear가 필요합니다.`);
    if(years.has(row.seasonYear)) throw new RangeError(`${label}.seasonYear가 중복됩니다.`);
    years.add(row.seasonYear);
    if(typeof row.championTeamId!=="string"||!row.championTeamId) throw new TypeError(`${label}.championTeamId가 필요합니다.`);
    assertObject(row.awards,`${label}.awards`);
    assertObject(row.user,`${label}.user`);
  }
  return true;
}

function normalizeHistoryState(existing){
  if(existing===undefined||existing===null) return createHistoryState();
  validateHistoryState(existing);
  return clone(existing);
}

function appendSeasonHistory(state,entry){
  const next=normalizeHistoryState(state);
  if(next.seasons.some((row)=>row.seasonYear===entry.seasonYear)) return next;
  next.seasons.push(clone(entry));
  next.seasons.sort((a,b)=>a.seasonYear-b.seasonYear);
  validateHistoryState(next);
  return next;
}

function getHistoryPublicView(state){
  const normalized=normalizeHistoryState(state);
  return Object.freeze({
    totalSeasons:normalized.seasons.length,
    seasons:Object.freeze([...normalized.seasons].sort((a,b)=>b.seasonYear-a.seasonYear).map((row)=>Object.freeze(clone(row))))
  });
}

export {
  POSTSEASON_STATE_VERSION,HISTORY_STATE_VERSION,POSTSEASON_ROUND_ORDER,POSTSEASON_RULESET_2026,
  createPostseasonState,validatePostseasonState,normalizePostseasonState,getPostseasonPublicView,
  createHistoryState,validateHistoryState,normalizeHistoryState,appendSeasonHistory,getHistoryPublicView
};
