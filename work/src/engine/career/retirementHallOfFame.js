import { SeededRng } from "../rng.js";

const RETIREMENT_HOF_VERSION = 1;
const HOF_RULESET_2026 = Object.freeze({
  id: "ruleset_2026_hall_of_fame",
  bbwAA: Object.freeze({
    minMlbSeasons: 10,
    firstBallotYearsAfterFinalSeason: 6,
    electionThreshold: 0.75,
    retentionThreshold: 0.05,
    maxBallotYears: 10,
    maxSelectionsPerVoter: 10,
    screeningLimit: 40,
    virtualVoters: 120
  }),
  contemporaryEraPlayers: Object.freeze({
    retiredSeasonsRequired: 16,
    cycleYears: 3,
    classYears: Object.freeze([2026, 2029, 2032]),
    ballotSize: 8,
    committeeSize: 16,
    maxSelectionsPerVoter: 3,
    electionThreshold: 0.75,
    minimumVotesForNextCycle: 5
  }),
  officialFormatVerified: "2026-09-22",
  futureRulePolicy: "CARRY_FORWARD_2026_UNTIL_VERSIONED_REPLACEMENT"
});

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function finite(v,fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function clone(v){ return structuredClone(v); }
function freeze(v){
  if(v && typeof v === "object" && Object.isFrozen(v)) return v;
  if(Array.isArray(v)) return Object.freeze(v.map(freeze));
  if(v && typeof v === "object") return Object.freeze(Object.fromEntries(Object.entries(v).map(([k,x])=>[k,freeze(x)])));
  return v;
}
function sumInto(target, source, keys){ for(const k of keys) target[k]=finite(target[k])+finite(source?.[k]); }
function positionOf(row){ return String(row?.position ?? (row?.isPitcher?"P":"DH")); }
function isPitcherRow(row){ return row?.isPitcher === true || positionOf(row)==="P" || ["SP","RP","CL"].includes(positionOf(row)); }
function battingPa(b){ return finite(b?.PA, finite(b?.AB)+finite(b?.BB)+finite(b?.HBP)+finite(b?.SF)); }
function battingTb(b){ return finite(b?.TB, finite(b?.H)+finite(b?.doubles ?? b?.['2B'])+2*finite(b?.triples ?? b?.['3B'])+3*finite(b?.HR)); }
function seasonPerformanceValue(row){
  if(isPitcherRow(row)){
    const p=row.pitching ?? {}, bf=finite(p.BF), outs=finite(p.outsRecorded ?? p.OUTS), ip=finite(p.IP, outs?outs/3:bf/4.35), er=finite(p.ER);
    const era=ip>0?9*er/ip:4.5;
    return Number(Math.max(0, (4.70-era)*ip/32 + finite(p.SO)*0.025 - finite(p.BB)*0.012 - finite(p.HR)*0.02 + finite(p.G)*0.012).toFixed(3));
  }
  const b=row.batting ?? {}, pa=battingPa(b), ab=finite(b.AB), tb=battingTb(b);
  const obp=(ab+finite(b.BB)+finite(b.HBP)+finite(b.SF))>0 ? (finite(b.H)+finite(b.BB)+finite(b.HBP))/(ab+finite(b.BB)+finite(b.HBP)+finite(b.SF)) : 0;
  const slg=ab>0?tb/ab:0, ops=obp+slg;
  return Number(Math.max(0, (ops-0.600)*pa/34 + finite(b.HR)*0.07 + finite(b.SB)*0.018 + finite(b.G)*0.008).toFixed(3));
}
function emptyTotals(){ return {batting:{G:0,PA:0,AB:0,H:0,doubles:0,triples:0,HR:0,RBI:0,BB:0,HBP:0,SO:0,SB:0,SF:0,TB:0},pitching:{G:0,BF:0,outsRecorded:0,IP:0,ER:0,SO:0,BB:0,H:0,HR:0}}; }
function createLedgerEntry(row){
  return {
    playerId:String(row.playerId),name:String(row.name ?? row.playerId),position:positionOf(row),isPitcher:isPitcherRow(row),
    mlbSeasons:0,firstMlbYear:null,lastMlbYear:null,teams:[],seasonValues:[],totals:emptyTotals(),awards:{MVP:0,CY_YOUNG:0,SILVER_SLUGGER:0,WORLD_SERIES_MVP:0},championships:0
  };
}
function createRetirementHallState({seed,userPlayerId,startYear}={}){
  if(typeof seed!=="string"||!seed) throw new TypeError("retirement/HOF seed가 필요합니다.");
  if(typeof userPlayerId!=="string"||!userPlayerId) throw new TypeError("retirement/HOF userPlayerId가 필요합니다.");
  if(!Number.isInteger(startYear)) throw new TypeError("retirement/HOF startYear가 필요합니다.");
  return freeze({version:RETIREMENT_HOF_VERSION,seed,userPlayerId,startYear,recordedSeasons:[],careerLedger:{},retiredPlayers:{},hall:{ballots:[],eraBallots:[],inductees:[]},user:{finalSeasonAnnounced:false,finalSeasonYear:null,retired:false,retiredYear:null,retirementDate:null,report:null}});
}
function validateRetirementHallState(state,label="retirementHallState"){
  if(!state||typeof state!=="object"||Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if(state.version!==RETIREMENT_HOF_VERSION) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if(typeof state.seed!=="string"||!state.seed||typeof state.userPlayerId!=="string"||!state.userPlayerId) throw new TypeError(`${label} identity가 필요합니다.`);
  for(const key of ["recordedSeasons"]){ if(!Array.isArray(state[key])) throw new TypeError(`${label}.${key}가 배열이어야 합니다.`); }
  for(const key of ["careerLedger","retiredPlayers","hall","user"]){ if(!state[key]||typeof state[key]!=="object"||Array.isArray(state[key])) throw new TypeError(`${label}.${key}가 object여야 합니다.`); }
  if(!Array.isArray(state.hall.ballots)||!Array.isArray(state.hall.eraBallots)||!Array.isArray(state.hall.inductees)) throw new TypeError(`${label}.hall 배열이 필요합니다.`);
  return true;
}
function normalizeRetirementHallState(state,{seed,userPlayerId,startYear}={}){
  if(state==null) return createRetirementHallState({seed,userPlayerId,startYear});
  validateRetirementHallState(state); return freeze(clone(state));
}
function recordMlbSeason(state,{year,players=[],awardsByPlayer={},championTeamId=null}={}){
  validateRetirementHallState(state); if(!Number.isInteger(year)) throw new TypeError("career ledger year가 필요합니다.");
  if(state.recordedSeasons.includes(year)) return state;
  const next=clone(state); next.recordedSeasons.push(year); next.recordedSeasons.sort((a,b)=>a-b);
  for(const row of players){
    const b=row.batting ?? {},p=row.pitching ?? {}; const appeared=finite(b.G)>0||finite(p.G)>0||finite(p.BF)>0; if(!appeared) continue;
    const id=String(row.playerId); const e=next.careerLedger[id] ?? createLedgerEntry(row); e.name=String(row.name ?? e.name); e.position=positionOf(row); e.isPitcher=isPitcherRow(row);
    e.mlbSeasons+=1; e.firstMlbYear=e.firstMlbYear ?? year; e.lastMlbYear=year; if(row.teamId && !e.teams.includes(String(row.teamId))) e.teams.push(String(row.teamId));
    const bv={...b,PA:battingPa(b),TB:battingTb(b)}; sumInto(e.totals.batting,bv,["G","PA","AB","H","doubles","triples","HR","RBI","BB","HBP","SO","SB","SF","TB"]);
    const pv={...p,IP:finite(p.IP, finite(p.outsRecorded ?? p.OUTS)/3),outsRecorded:finite(p.outsRecorded ?? p.OUTS)}; sumInto(e.totals.pitching,pv,["G","BF","outsRecorded","IP","ER","SO","BB","H","HR"]);
    const awards=awardsByPlayer[id] ?? []; for(const a of awards) if(Object.prototype.hasOwnProperty.call(e.awards,a)) e.awards[a]+=1;
    if(championTeamId && String(row.teamId)===String(championTeamId)) e.championships+=1;
    e.seasonValues.push({year,value:seasonPerformanceValue(row),teamId:row.teamId?String(row.teamId):null,age:row.age==null?null:Number(row.age)});
    next.careerLedger[id]=e;
  }
  return freeze(next);
}
function archiveRetiredPlayers(state,{year,retiredRecords=[],decisions=[]}={}){
  validateRetirementHallState(state); const next=clone(state); const decisionMap=new Map((decisions??[]).map(d=>[String(d.playerId),d]));
  for(const row of retiredRecords??[]){ const id=String(row.id ?? row.playerId); if(!id||id===next.userPlayerId) continue; const ledger=next.careerLedger[id] ?? createLedgerEntry({playerId:id,name:row.name,position:row.role==="P"?(row.player?.pitching?.role ?? "P"):(row.player?.positioning?.primaryPosition ?? "DH"),isPitcher:row.role==="P"});
    next.careerLedger[id]=ledger; const d=decisionMap.get(id); next.retiredPlayers[id]={playerId:id,name:String(row.name ?? ledger.name),retiredYear:year,age:Number(row.developed?.physical?.age ?? row.player?.physical?.age ?? d?.age ?? 0),finalOvr:Number(row.ovr ?? d?.overall ?? 0),lastLevel:row.level ?? null,lastOrganizationId:row.organizationId ?? null,reasonCodes:[...(d?.reasonCodes ?? [])],career:clone(ledger)};
  }
  return freeze(next);
}
function announceUserFinalSeason(state,{year}={}){ validateRetirementHallState(state); if(state.user.retired) return state; const next=clone(state); next.user.finalSeasonAnnounced=true; next.user.finalSeasonYear=Number(year); return freeze(next); }
function buildRetirementReport(state,{year,date,timeline=[],history=[]}={}){
  const e=state.careerLedger[state.userPlayerId] ?? createLedgerEntry({playerId:state.userPlayerId,name:"User",position:"-"});
  return {playerId:state.userPlayerId,name:e.name,retiredYear:year,retirementDate:date,mlbSeasons:e.mlbSeasons,firstMlbYear:e.firstMlbYear,lastMlbYear:e.lastMlbYear,teams:[...e.teams],totals:clone(e.totals),awards:clone(e.awards),championships:e.championships,seasonValues:clone(e.seasonValues),careerMoments:(timeline??[]).map(x=>({type:x.type,date:x.date,importance:x.importance})),seasonHistory:(history??[]).map(x=>({seasonYear:x.seasonYear,championTeamId:x.championTeamId,user:clone(x.user)})),grade:null};
}
function retireUserPlayer(state,{year,date,timeline=[],history=[]}={}){ validateRetirementHallState(state); if(state.user.retired) return state; const next=clone(state); next.user.retired=true; next.user.retiredYear=Number(year); next.user.retirementDate=String(date); next.user.report=buildRetirementReport(state,{year,date,timeline,history}); next.retiredPlayers[next.userPlayerId]={playerId:next.userPlayerId,name:next.user.report.name,retiredYear:Number(year),age:null,finalOvr:null,lastLevel:null,lastOrganizationId:null,reasonCodes:["USER_DECISION"],career:clone(next.careerLedger[next.userPlayerId] ?? createLedgerEntry({playerId:next.userPlayerId,name:next.user.report.name,position:"-"}))}; return freeze(next); }
function milestoneScore(e){
  if(e.isPitcher){ const p=e.totals.pitching; return clamp(finite(p.SO)/3000*0.55 + finite(p.IP)/3500*0.30 + e.awards.CY_YOUNG*0.08,0,1.25); }
  const b=e.totals.batting; return clamp(finite(b.H)/3000*0.38 + finite(b.HR)/500*0.34 + finite(b.RBI)/1600*0.12 + finite(b.SB)/500*0.08 + e.awards.MVP*0.08,0,1.25);
}
function hallMetrics(e){ const vals=[...(e.seasonValues??[])].map(x=>finite(x.value)).sort((a,b)=>b-a); const career=vals.reduce((a,b)=>a+b,0),peak=vals.slice(0,7).reduce((a,b)=>a+b,0),longevity=clamp(e.mlbSeasons/18,0,1.15),awards=clamp(e.awards.MVP*0.13+e.awards.CY_YOUNG*0.13+e.awards.SILVER_SLUGGER*0.025+e.awards.WORLD_SERIES_MVP*0.04,0,1.15),postseason=clamp(e.championships*0.08+e.awards.WORLD_SERIES_MVP*0.06,0,0.35),milestones=milestoneScore(e); const quality=clamp(0.36*clamp(career/125,0,1.3)+0.28*clamp(peak/72,0,1.3)+0.12*longevity+0.12*milestones+0.08*awards+0.04*postseason,0,1.25); return {careerValue:Number(career.toFixed(2)),peakSevenValue:Number(peak.toFixed(2)),longevity:Number(longevity.toFixed(3)),milestones:Number(milestones.toFixed(3)),awards:Number(awards.toFixed(3)),postseason:Number(postseason.toFixed(3)),quality:Number(quality.toFixed(4))}; }
function candidateRows(state,electionYear){ const priorById=new Map(); for(const ballot of state.hall.ballots) for(const row of ballot.results??[]) priorById.set(String(row.playerId),row); return Object.values(state.retiredPlayers).filter(r=>r.playerId!==state.userPlayerId || state.user.retired).map(r=>{ const e=state.careerLedger[r.playerId] ?? r.career; if(!e) return null; const prior=priorById.get(String(r.playerId)); return {playerId:String(r.playerId),name:r.name,retiredYear:r.retiredYear,firstEligibleYear:r.retiredYear+HOF_RULESET_2026.bbwAA.firstBallotYearsAfterFinalSeason,yearsOnBallot:prior?.yearsOnBallot ?? 0,status:prior?.status ?? "NEW",ledger:e,metrics:hallMetrics(e)}; }).filter(Boolean).filter(c=>c.ledger.mlbSeasons>=HOF_RULESET_2026.bbwAA.minMlbSeasons && electionYear>=c.firstEligibleYear && c.status!=="INDUCTED" && c.status!=="EXHAUSTED" && c.status!=="DROPPED"); }
function virtualVote(candidate,voterSeed,kind="BBWAA"){ const m=candidate.metrics,rng=new SeededRng(`${kind}-hof-v58:${voterSeed}:${candidate.playerId}`); const peakBias=(rng.next()-0.5)*0.12,careerBias=(rng.next()-0.5)*0.10,awardBias=(rng.next()-0.5)*0.07; const noise=(rng.next()-0.5)*0.055; return m.quality + peakBias*m.peakSevenValue/72 + careerBias*m.careerValue/125 + awardBias*m.awards + noise; }
function processBbwAA(state,electionYear){ const candidates=candidateRows(state,electionYear).sort((a,b)=>b.metrics.quality-a.metrics.quality||a.playerId.localeCompare(b.playerId)).slice(0,HOF_RULESET_2026.bbwAA.screeningLimit); if(!candidates.length) return state; const votes=Object.fromEntries(candidates.map(c=>[c.playerId,0])); for(let v=0;v<HOF_RULESET_2026.bbwAA.virtualVoters;v++){ const threshold=0.605+((v%11)-5)*0.003; const ranked=candidates.map(c=>({c,u:virtualVote(c,`${state.seed}:${electionYear}:${v}`)})).filter(x=>x.u>=threshold).sort((a,b)=>b.u-a.u||a.c.playerId.localeCompare(b.c.playerId)).slice(0,HOF_RULESET_2026.bbwAA.maxSelectionsPerVoter); for(const x of ranked) votes[x.c.playerId]+=1; }
  const next=clone(state),results=[]; for(const c of candidates){ const pct=votes[c.playerId]/HOF_RULESET_2026.bbwAA.virtualVoters,years=c.yearsOnBallot+1; let status="RETURNING"; if(pct>=HOF_RULESET_2026.bbwAA.electionThreshold) status="INDUCTED"; else if(pct<HOF_RULESET_2026.bbwAA.retentionThreshold) status="DROPPED"; else if(years>=HOF_RULESET_2026.bbwAA.maxBallotYears) status="EXHAUSTED"; results.push({playerId:c.playerId,name:c.name,votes:votes[c.playerId],votePct:Number(pct.toFixed(4)),yearsOnBallot:years,status,metrics:c.metrics}); if(status==="INDUCTED"&&!next.hall.inductees.some(x=>x.playerId===c.playerId)) next.hall.inductees.push({playerId:c.playerId,name:c.name,electionYear,route:"BBWAA",votePct:Number(pct.toFixed(4))}); }
  next.hall.ballots.push({electionYear,route:"BBWAA",voters:HOF_RULESET_2026.bbwAA.virtualVoters,results}); return freeze(next);
}
function isContemporaryPlayerCycle(year){ return year>=2026 && (year-2026)%HOF_RULESET_2026.contemporaryEraPlayers.cycleYears===0; }
function processEra(state,electionYear){ if(!isContemporaryPlayerCycle(electionYear)) return state; const inducted=new Set(state.hall.inductees.map(x=>x.playerId)); const pool=Object.values(state.retiredPlayers).map(r=>({r,e:state.careerLedger[r.playerId] ?? r.career})).filter(x=>x.e && x.e.mlbSeasons>=10 && electionYear-x.r.retiredYear>=HOF_RULESET_2026.contemporaryEraPlayers.retiredSeasonsRequired && !inducted.has(x.r.playerId)).map(x=>({playerId:x.r.playerId,name:x.r.name,metrics:hallMetrics(x.e)})).sort((a,b)=>b.metrics.quality-a.metrics.quality||a.playerId.localeCompare(b.playerId)).slice(0,HOF_RULESET_2026.contemporaryEraPlayers.ballotSize); if(!pool.length) return state; const votes=Object.fromEntries(pool.map(c=>[c.playerId,0])); for(let v=0;v<16;v++){ const ranked=pool.map(c=>({c,u:virtualVote(c,`${state.seed}:ERA:${electionYear}:${v}`,"ERA")})).filter(x=>x.u>=0.62).sort((a,b)=>b.u-a.u).slice(0,3); for(const x of ranked) votes[x.c.playerId]+=1; } const next=clone(state),results=[]; for(const c of pool){ const pct=votes[c.playerId]/16,status=pct>=0.75?"INDUCTED":"NOT_ELECTED"; results.push({playerId:c.playerId,name:c.name,votes:votes[c.playerId],votePct:Number(pct.toFixed(4)),status,metrics:c.metrics}); if(status==="INDUCTED"&&!next.hall.inductees.some(x=>x.playerId===c.playerId)) next.hall.inductees.push({playerId:c.playerId,name:c.name,electionYear,route:"CONTEMPORARY_ERA_PLAYERS",votePct:Number(pct.toFixed(4))}); } next.hall.eraBallots.push({electionYear,route:"CONTEMPORARY_ERA_PLAYERS",voters:16,results}); return freeze(next); }
function processHallOfFameYear(state,{electionYear}={}){ validateRetirementHallState(state); if(!Number.isInteger(electionYear)) throw new TypeError("HOF electionYear가 필요합니다."); if(state.hall.ballots.some(x=>x.electionYear===electionYear)||state.hall.eraBallots.some(x=>x.electionYear===electionYear)) return state; return processEra(processBbwAA(state,electionYear),electionYear); }
function getRetirementHallPublicView(state){ if(!state) return null; validateRetirementHallState(state); const latest=state.hall.ballots.at(-1)??null,era=state.hall.eraBallots.at(-1)??null; return freeze({ruleset:HOF_RULESET_2026,user:clone(state.user),retiredCount:Object.keys(state.retiredPlayers).length,ledgerPlayers:Object.keys(state.careerLedger).length,inductees:clone(state.hall.inductees.slice(-24).reverse()),latestBallot:latest?clone(latest):null,latestEraBallot:era?clone(era):null}); }

export { RETIREMENT_HOF_VERSION,HOF_RULESET_2026,createRetirementHallState,validateRetirementHallState,normalizeRetirementHallState,recordMlbSeason,archiveRetiredPlayers,announceUserFinalSeason,retireUserPlayer,processHallOfFameYear,getRetirementHallPublicView,hallMetrics };
