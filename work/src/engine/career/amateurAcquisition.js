import { SeededRng } from "../rng.js";
import { generateAmateurClass } from "./generatedTalent.js";
import { currentOvr } from "./generatedCareerPathway.js";

const AMATEUR_ACQUISITION_VERSION = 1;
const DRAFT_RULESET_2026 = Object.freeze({
  id: "ruleset_2026_rule4_draft",
  rounds: 20,
  regularPicksPerRound: 30,
  lotterySelections: 6,
  lotteryClubs: 18,
  draftMonthDay: "07-11",
  draftEndMonthDay: "07-12",
  signingDeadlineMonthDay: "07-27",
  classSize: 660,
  officialFormatVerified: "2026-09-22",
  futureRulePolicy: "CARRY_FORWARD_2026_UNTIL_VERSIONED_REPLACEMENT",
  supplementalPicks: "ABSTRACTED_V57",
  revenueSharingLotteryRestrictions: "DEFERRED_NO_FINANCE_DATA"
});

const INTERNATIONAL_RULESET_2026 = Object.freeze({
  id: "ruleset_2026_international_amateur",
  signingWindowStartMonthDay: "01-15",
  signingWindowEndMonthDay: "12-15",
  classSize: 240,
  reserveRetentionPerOrganization: 14,
  officialFormatVerified: "2026-09-22",
  futureRulePolicy: "CARRY_FORWARD_2026_UNTIL_VERSIONED_REPLACEMENT",
  poolTrading: "DEFERRED_V57",
  lowBonusExemption: "ABSTRACTED_V57"
});

const LOTTERY_ODDS_2026_CBA = Object.freeze([16.5,16.5,16.5,13.2,10.0,7.5,5.5,3.9,2.7,1.8,1.4,1.1,0.9,0.76,0.62,0.48,0.36,0.23]);
const OFFICIAL_2026_ROUND_ONE = Object.freeze(["CWS","TB","MIN","SF","PIT","KC","BAL","ATH","ATL","COL","WSH","LAA","STL","MIA","AZ","TEX","HOU","CIN","CLE","BOS","SD","DET","CHC","SEA","MIL","NYM","NYY","PHI","TOR","LAD"]);
const OFFICIAL_2026_LATER_ROUNDS = Object.freeze(["COL","MIN","BAL","TB","AZ","KC","CIN","SD","NYY","MIL","CWS","PIT","ATH","STL","TEX","NYM","CLE","DET","PHI","TOR","WSH","LAA","ATL","MIA","SF","HOU","BOS","CHC","SEA","LAD"]);
const INTERNATIONAL_POOL_2026 = Object.freeze({
  AZ:8034900,BAL:8034900,CLE:8034900,COL:8034900,KC:8034900,PIT:8034900,STL:8034900,
  ATH:7357100,CIN:7357100,DET:7357100,MIA:7357100,MIL:7357100,MIN:7357100,SEA:7357100,TB:7357100,
  ATL:6679200,CHC:6679200,CWS:6679200,LAA:6679200,LAD:6679200,PHI:6679200,TEX:6679200,WSH:6679200,
  BOS:5940000,SD:5940000,TOR:5940000,
  HOU:5440000,NYY:5440000,NYM:5440000,SF:5440000
});
const INTERNATIONAL_ORIGINS = Object.freeze([
  ["Dominican Republic",0.34],["Venezuela",0.24],["Cuba",0.08],["Mexico",0.07],["Panama",0.05],
  ["Colombia",0.05],["Curacao",0.035],["Nicaragua",0.025],["Bahamas",0.02],["South Korea",0.015],
  ["Taiwan",0.015],["Japan",0.01],["Other",0.05]
]);
const POSITION_VALUE = Object.freeze({C:4.2,SS:4.5,CF:4.0,SP:4.1,RP:1.6,"2B":2.7,"3B":2.8,RF:2.2,LF:1.9,"1B":1.4,DH:0.8});

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function finite(v,fallback=0){ const n=Number(v); return Number.isFinite(n)?n:fallback; }
function clone(v){ return structuredClone(v); }
function freeze(v){
  if(v && typeof v === "object" && Object.isFrozen(v)) return v;
  if(Array.isArray(v)) return Object.freeze(v.map(freeze));
  if(v && typeof v === "object") return Object.freeze(Object.fromEntries(Object.entries(v).map(([k,x])=>[k,freeze(x)])));
  return v;
}
function dateForYear(year,monthDay){ return `${year}-${monthDay}`; }
function isPitcher(player){ return player?.positioning == null; }
function playerRole(player){ return isPitcher(player)?"P":"H"; }
function playerPosition(player){ return isPitcher(player)?String(player?.pitching?.role ?? "RP"):String(player?.positioning?.primaryPosition ?? "DH"); }
function teamAbbr(row){ return String(row?.abbreviation ?? row?.shortName ?? row?.name ?? "").toUpperCase(); }
function canonicalAbbr(value){ const a=String(value ?? "").toUpperCase(); return a==="OAK"?"ATH":a==="ARI"?"AZ":a==="WSN"?"WSH":a; }
function teamIdMap(teamRows){
  const map=new Map();
  for(const row of teamRows ?? []) map.set(canonicalAbbr(teamAbbr(row)),String(row.id));
  return map;
}
function resolveOrder(abbrs,teamRows){
  const map=teamIdMap(teamRows); const out=[];
  for(const abbr of abbrs){ const id=map.get(canonicalAbbr(abbr)); if(id && !out.includes(id)) out.push(id); }
  return out.length===30?out:null;
}
function pct(row){ const w=finite(row?.W,0),l=finite(row?.L,0),g=w+l; return g? w/g:0; }
function standingsRow(standings,id){ return standings?.[String(id)] ?? {W:0,L:0,RS:0,RA:0}; }
function weightedPickIndex(weights,rng){
  const total=weights.reduce((a,b)=>a+Math.max(0,b),0); if(total<=0) return rng.int(0,weights.length-1);
  let x=rng.next()*total;
  for(let i=0;i<weights.length;i+=1){ x-=Math.max(0,weights[i]); if(x<=0) return i; }
  return weights.length-1;
}
function postseasonLoserGroups(postseasonState){
  const groups=[];
  for(const key of ["WILD_CARD","DIVISION_SERIES","LCS"]){
    const rows=postseasonState?.rounds?.[key] ?? [];
    groups.push(rows.map((s)=>String(s.loserTeamId ?? "")).filter(Boolean));
  }
  const ws=postseasonState?.rounds?.WORLD_SERIES?.[0] ?? null;
  groups.push(ws?.loserTeamId?[String(ws.loserTeamId)]:postseasonState?.runnerUpTeamId?[String(postseasonState.runnerUpTeamId)]:[]);
  groups.push(postseasonState?.championTeamId?[String(postseasonState.championTeamId)]:[]);
  return groups;
}
function futureDraftOrders({teamRows,standings,postseasonState,seed,year}){
  const ids=(teamRows ?? []).map((r)=>String(r.id));
  if(ids.length!==30) throw new RangeError(`draft order에는 MLB 30팀이 필요합니다: ${ids.length}`);
  const playoff=new Set(Object.values(postseasonState?.field?.leagues ?? {}).flatMap((x)=>x?.seeds ?? []).map((x)=>String(x.teamId)));
  const non=ids.filter((id)=>!playoff.has(id)).sort((a,b)=>pct(standingsRow(standings,a))-pct(standingsRow(standings,b)) || a.localeCompare(b));
  const post=ids.filter((id)=>playoff.has(id));
  const rng=new SeededRng(`draft-lottery-v57:${seed}:${year}`);
  const pool=[...non]; const lottery=[];
  while(lottery.length<Math.min(DRAFT_RULESET_2026.lotterySelections,pool.length)){
    const weights=pool.map((id)=>{
      const rank=non.indexOf(id);
      return LOTTERY_ODDS_2026_CBA[Math.min(rank,LOTTERY_ODDS_2026_CBA.length-1)] ?? 0.23;
    });
    const index=weightedPickIndex(weights,rng); lottery.push(pool.splice(index,1)[0]);
  }
  const remainingNon=[...pool].sort((a,b)=>pct(standingsRow(standings,a))-pct(standingsRow(standings,b)) || a.localeCompare(b));
  const loserGroups=postseasonLoserGroups(postseasonState);
  const grouped=[]; const used=new Set();
  for(const group of loserGroups){
    const rows=group.filter((id)=>post.includes(id)).sort((a,b)=>pct(standingsRow(standings,a))-pct(standingsRow(standings,b)) || a.localeCompare(b));
    for(const id of rows){ if(!used.has(id)){used.add(id);grouped.push(id);} }
  }
  for(const id of post.sort((a,b)=>pct(standingsRow(standings,a))-pct(standingsRow(standings,b)) || a.localeCompare(b))) if(!used.has(id)) grouped.push(id);
  const first=[...lottery,...remainingNon,...grouped];
  const later=[...ids].sort((a,b)=>pct(standingsRow(standings,a))-pct(standingsRow(standings,b)) || a.localeCompare(b));
  return {firstRound:first,laterRounds:later,method:"SIMULATED_2026_CBA_SHAPE",lotteryWinners:lottery};
}
function draftOrders({year,teamRows,standings,postseasonState,seed}){
  if(year===2026){
    const first=resolveOrder(OFFICIAL_2026_ROUND_ONE,teamRows),later=resolveOrder(OFFICIAL_2026_LATER_ROUNDS,teamRows);
    if(first && later) return {firstRound:first,laterRounds:later,method:"OFFICIAL_2026_BASE_ORDER",lotteryWinners:first.slice(0,6)};
  }
  return futureDraftOrders({teamRows,standings,postseasonState,seed,year});
}
function projectionOvr(player){
  const p=player?.generatedProfile?.reachableProjection ?? {};
  if(isPitcher(player)){
    const vals=[p.stuff,p.movement,p.control,p.command,p.pitchability,p.stamina].map((x)=>finite(x,50));
    return vals.reduce((a,b)=>a+b,0)/vals.length;
  }
  const vals=[p.contact,p.power,p.vision,p.discipline,p.defense,p.speed].map((x)=>finite(x,50));
  return vals.reduce((a,b)=>a+b,0)/vals.length;
}
function riskBand(uncertainty){ return uncertainty>=0.78?"EXTREME":uncertainty>=0.68?"HIGH":uncertainty>=0.56?"MEDIUM":"LOW"; }
function scoutCandidate(player,{seed,year,organizationId="PUBLIC"}={}){
  const rng=new SeededRng(`amateur-scout-v57:${seed}:${year}:${organizationId}:${player.id}`);
  const uncertainty=finite(player?.generatedProfile?.uncertainty,0.6);
  const noise=(rng.next()+rng.next()+rng.next()-1.5)*uncertainty*9.5;
  const current=currentOvr(player),future=clamp(projectionOvr(player)+noise,20,99);
  const age=finite(player?.physical?.age,20),pos=playerPosition(player);
  const signability=clamp(0.50+rng.next()*0.46-(player?.generatedProfile?.background==="HIGH_SCHOOL"?0.08:0),0.32,0.98);
  const askScale=clamp((future-36)/48,0.05,1);
  const askDollars=Math.round((100000+askScale*5200000+(1-signability)*900000)/10000)*10000;
  return freeze({
    playerId:String(player.id),name:String(player.fullName ?? player.id),position:pos,age,
    background:String(player?.generatedProfile?.background ?? "UNKNOWN"),currentGrade:Math.round(current),futureValue:Math.round(future),
    risk:riskBand(uncertainty),uncertainty:Number(uncertainty.toFixed(3)),signability:Number(signability.toFixed(3)),askDollars
  });
}
function publicBoard(players,{seed,year,limit=40}={}){
  return [...players].map((player)=>scoutCandidate(player,{seed,year,organizationId:"PUBLIC"}))
    .sort((a,b)=>b.futureValue-a.futureValue || b.currentGrade-a.currentGrade || a.playerId.localeCompare(b.playerId))
    .slice(0,limit).map((row,index)=>({...row,rank:index+1}));
}
function classDescriptor({seed,year,entryPath,size,idOffset,previousClassStrength}){
  const generated=generateAmateurClass({seed,year,size,previousClassStrength,entryPath,idOffset});
  return freeze({
    seed,year,entryPath,size,idOffset,classType:generated.classType,classStrength:generated.classStrength,
    board:publicBoard(generated.players,{seed,year,limit:entryPath==="DRAFT"?50:35})
  });
}
function regenerate(desc){
  return generateAmateurClass({seed:desc.seed,year:desc.year,size:desc.size,classType:desc.classType,previousClassStrength:0,entryPath:desc.entryPath,idOffset:desc.idOffset}).players;
}
function initialState(seed,startYear){
  return {
    version:AMATEUR_ACQUISITION_VERSION,seed:String(seed),currentYear:startYear,snapshotCoveredThroughYear:startYear,current:null,reserve:[],history:[],
    totalDrafted:0,totalInternationalSigned:0,totalActivated:0,totalUndraftedFallback:0,fallbackSerial:0
  };
}
function createAmateurAcquisitionState({seed,startYear}={}){
  if(typeof seed!=="string"||!seed) throw new TypeError("amateur acquisition seed가 필요합니다.");
  if(!Number.isInteger(startYear)) throw new TypeError("amateur acquisition startYear가 필요합니다.");
  return freeze(initialState(seed,startYear));
}
function validateAmateurAcquisitionState(state,label="amateurAcquisitionState"){
  if(!state||typeof state!=="object"||Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);
  if(state.version!==AMATEUR_ACQUISITION_VERSION) throw new RangeError(`${label}.version이 호환되지 않습니다.`);
  if(typeof state.seed!=="string"||!state.seed) throw new TypeError(`${label}.seed가 필요합니다.`);
  if(!Number.isInteger(state.currentYear)) throw new TypeError(`${label}.currentYear가 필요합니다.`);
  if(!Array.isArray(state.reserve)||!Array.isArray(state.history)) throw new TypeError(`${label} reserve/history가 필요합니다.`);
  const ids=new Set();
  for(const row of state.reserve){
    if(!row?.player?.id||!row.organizationId) throw new TypeError(`${label}.reserve entry가 잘못되었습니다.`);
    const id=String(row.player.id); if(ids.has(id)) throw new RangeError(`${label}.reserve player id 중복: ${id}`); ids.add(id);
  }
  if(state.current){
    if(state.current.year!==state.currentYear) throw new RangeError(`${label}.current year 불일치`);
    if(!state.current.draft?.descriptor||!state.current.international?.descriptor) throw new TypeError(`${label}.current class descriptor가 필요합니다.`);
  }
  return true;
}
function normalizeAmateurAcquisitionState(state,{seed,startYear}={}){
  if(state==null) return createAmateurAcquisitionState({seed,startYear});
  validateAmateurAcquisitionState(state); return freeze(clone(state));
}
function archiveCurrent(state){
  if(!state.current) return state.history;
  const c=state.current;
  const summary={
    year:c.year,
    draft:{processed:c.draft.processed,picks:c.draft.picks?.length ?? 0,signed:c.draft.signed ?? 0,topPicks:(c.draft.picks ?? []).slice(0,12)},
    international:{processed:c.international.processed,signings:c.international.signings?.length ?? 0,spentByOrganization:c.international.spentByOrganization ?? {}},
    classStrength:{draft:c.draft.descriptor.classStrength,international:c.international.descriptor.classStrength}
  };
  return [...state.history,summary].slice(-25);
}
function prepareAmateurYear(state,{year,teamRows,standings={},postseasonState=null}={}){
  validateAmateurAcquisitionState(state);
  if(!Number.isInteger(year)) throw new TypeError("amateur year가 필요합니다.");
  if(state.current?.year===year) return state;
  const history=archiveCurrent(state);
  const previous=state.current?.draft?.descriptor?.classStrength ?? state.history.at(-1)?.classStrength?.draft ?? 0;
  const draft=classDescriptor({seed:`${state.seed}:draft`,year,entryPath:"DRAFT",size:DRAFT_RULESET_2026.classSize,idOffset:0,previousClassStrength:previous});
  const intl=classDescriptor({seed:`${state.seed}:intl`,year,entryPath:"INTERNATIONAL",size:INTERNATIONAL_RULESET_2026.classSize,idOffset:1000,previousClassStrength:draft.classStrength});
  const orders=draftOrders({year,teamRows,standings,postseasonState,seed:state.seed});
  return freeze({...clone(state),currentYear:year,history,current:{
    year,
    draft:{descriptor:draft,draftDate:dateForYear(year,DRAFT_RULESET_2026.draftMonthDay),signingDeadline:dateForYear(year,DRAFT_RULESET_2026.signingDeadlineMonthDay),processed:false,orderMethod:orders.method,firstRoundOrder:orders.firstRound,laterRoundOrder:orders.laterRounds,lotteryWinners:orders.lotteryWinners,picks:[],signed:0},
    international:{descriptor:intl,windowStart:dateForYear(year,INTERNATIONAL_RULESET_2026.signingWindowStartMonthDay),windowEnd:dateForYear(year,INTERNATIONAL_RULESET_2026.signingWindowEndMonthDay),processed:false,signings:[],spentByOrganization:{}},
    activation:null
  }});
}
function needScore(reserve,organizationId,player){
  const pos=playerPosition(player);
  const same=reserve.filter((r)=>r.organizationId===organizationId && playerPosition(r.player)===pos).length;
  const role=reserve.filter((r)=>r.organizationId===organizationId && playerRole(r.player)===playerRole(player)).length;
  return clamp(5.5-same*1.0-role*0.08,-2,5.5);
}
function draftPickScore(player,report,{round,pickInRound,reserve,organizationId}){
  const top=round===1 && pickInRound<=10;
  const age=finite(player?.physical?.age,20);
  const pos=playerPosition(player);
  const riskPenalty=({LOW:0,MEDIUM:1.2,HIGH:2.6,EXTREME:4.0})[report.risk] ?? 2;
  const talentWeight=top?0.63:round<=5?0.54:0.45;
  const currentWeight=top?0.18:round<=5?0.21:0.25;
  const needWeight=top?0.04:round<=5?0.10:0.16;
  return report.futureValue*talentWeight+report.currentGrade*currentWeight+(23-age)*0.35+(POSITION_VALUE[pos]??1.5)-riskPenalty+needScore(reserve,organizationId,player)*needWeight*5+report.signability*2;
}
function capReserve(entries,limit=INTERNATIONAL_RULESET_2026.reserveRetentionPerOrganization){
  const byOrg=new Map();
  for(const e of entries){ const arr=byOrg.get(e.organizationId)??[]; arr.push(e); byOrg.set(e.organizationId,arr); }
  const kept=[];
  for(const [org,rows] of byOrg){
    rows.sort((a,b)=>finite(b.acquisitionScore)-finite(a.acquisitionScore) || Number(a.signedYear)-Number(b.signedYear) || String(a.player.id).localeCompare(String(b.player.id)));
    kept.push(...rows.slice(0,limit));
  }
  return kept;
}
function processDraftIfDue(state,{date,teamRows}={}){
  validateAmateurAcquisitionState(state);
  const c=state.current; if(!c||c.draft.processed||String(date)<c.draft.draftDate) return state;
  const players=regenerate(c.draft.descriptor),remaining=new Map(players.map((p)=>[String(p.id),p]));
  let reserve=[...state.reserve],overall=0,signed=0; const picks=[];
  for(let round=1;round<=DRAFT_RULESET_2026.rounds;round+=1){
    const order=round===1?c.draft.firstRoundOrder:c.draft.laterRoundOrder;
    if(!Array.isArray(order)||order.length!==30) throw new RangeError(`draft round ${round} order가 30팀이 아닙니다.`);
    for(let pickInRound=1;pickInRound<=order.length;pickInRound+=1){
      const organizationId=String(order[pickInRound-1]); overall+=1;
      let best=null;
      for(const player of remaining.values()){
        const report=scoutCandidate(player,{seed:state.seed,year:c.year,organizationId});
        const score=draftPickScore(player,report,{round,pickInRound,reserve,organizationId});
        if(!best||score>best.score||(score===best.score&&String(player.id)<String(best.player.id))) best={player,report,score};
      }
      if(!best) throw new RangeError(`draft candidate가 부족합니다: ${overall}`);
      remaining.delete(String(best.player.id));
      const signRng=new SeededRng(`draft-sign-v57:${state.seed}:${c.year}:${overall}:${best.player.id}`);
      const base=round<=5?0.97:round<=10?0.94:0.88;
      const didSign=signRng.next()<clamp(base+(best.report.signability-0.65)*0.18,0.72,0.995);
      const row={overallPick:overall,round,pickInRound,organizationId,playerId:String(best.player.id),name:best.report.name,position:best.report.position,age:best.report.age,background:best.report.background,currentGrade:best.report.currentGrade,futureValue:best.report.futureValue,risk:best.report.risk,signed:didSign};
      picks.push(row);
      if(didSign){
        signed+=1;
        reserve.push({player:best.player,organizationId,entryPath:"DRAFT",signedYear:c.year,draftRound:round,pickOverall:overall,acquisitionScore:best.report.futureValue*0.72+best.report.currentGrade*0.28,originCountry:null});
      }
    }
  }
  reserve=capReserve(reserve);
  const next=clone(state); next.reserve=reserve; next.totalDrafted+=picks.length; next.current.draft={...next.current.draft,processed:true,processedDate:String(date),picks,signed};
  return freeze(next);
}
function originFor(player,{seed,year}={}){
  const rng=new SeededRng(`intl-origin-v57:${seed}:${year}:${player.id}`); let x=rng.next();
  for(const [country,share] of INTERNATIONAL_ORIGINS){ x-=share; if(x<=0) return country; }
  return "Other";
}
function withOrigin(player,origin){
  return freeze({...player,generatedProfile:{...(player.generatedProfile ?? {}),originCountry:origin}});
}
function poolForTeam(teamRow){ return INTERNATIONAL_POOL_2026[canonicalAbbr(teamAbbr(teamRow))] ?? 6679200; }
function processInternationalSignings(state,{date,teamRows}={}){
  validateAmateurAcquisitionState(state);
  const c=state.current; if(!c||c.international.processed||String(date)<c.international.windowStart||String(date)>c.international.windowEnd) return state;
  const teams=(teamRows ?? []).map((row)=>({id:String(row.id),pool:poolForTeam(row),abbr:canonicalAbbr(teamAbbr(row))}));
  if(teams.length!==30) throw new RangeError(`international signing에는 MLB 30팀이 필요합니다: ${teams.length}`);
  const players=regenerate(c.international.descriptor).map((p)=>withOrigin(p,originFor(p,{seed:state.seed,year:c.year})));
  const remaining=new Map(players.map((p)=>[String(p.id),p])); const spent=Object.fromEntries(teams.map((t)=>[t.id,0])); const signings=[]; let reserve=[...state.reserve];
  for(let wave=0;wave<5;wave+=1){
    for(const team of teams){
      let best=null;
      for(const player of remaining.values()){
        const report=scoutCandidate(player,{seed:state.seed,year:c.year,organizationId:team.id});
        if(spent[team.id]+report.askDollars>team.pool) continue;
        const score=report.futureValue*0.64+report.currentGrade*0.20+needScore(reserve,team.id,player)*0.9-report.uncertainty*2.0;
        if(!best||score>best.score||(score===best.score&&String(player.id)<String(best.player.id))) best={player,report,score};
      }
      if(!best) continue;
      remaining.delete(String(best.player.id)); spent[team.id]+=best.report.askDollars;
      reserve.push({player:best.player,organizationId:team.id,entryPath:"INTERNATIONAL",signedYear:c.year,draftRound:null,pickOverall:null,acquisitionScore:best.report.futureValue*0.74+best.report.currentGrade*0.26,originCountry:best.player.generatedProfile?.originCountry ?? null,bonusDollars:best.report.askDollars});
      signings.push({organizationId:team.id,playerId:String(best.player.id),name:best.report.name,position:best.report.position,age:best.report.age,originCountry:best.player.generatedProfile?.originCountry ?? null,futureValue:best.report.futureValue,currentGrade:best.report.currentGrade,bonusDollars:best.report.askDollars});
    }
  }
  reserve=capReserve(reserve);
  const next=clone(state); next.reserve=reserve; next.totalInternationalSigned+=signings.length; next.current.international={...next.current.international,processed:true,processedDate:String(date),signings,spentByOrganization:spent};
  return freeze(next);
}
function advanceAmateurCalendar(state,{date,teamRows}={}){
  let next=processInternationalSignings(state,{date,teamRows});
  next=processDraftIfDue(next,{date,teamRows});
  return next;
}
function matureReservePlayer(entry,year){
  const years=Math.max(0,year-Number(entry.signedYear));
  const age=Math.round(finite(entry.player?.physical?.age,20)+years);
  return freeze({...entry.player,physical:{...(entry.player.physical ?? {}),age},generatedCareer:{...(entry.player.generatedCareer ?? {}),firstEntryYear:entry.signedYear,currentOrganizationId:entry.organizationId,currentLevel:"A",lastRosterYear:year,entryPath:entry.entryPath,draftRound:entry.draftRound ?? null,pickOverall:entry.pickOverall ?? null,originCountry:entry.originCountry ?? null}});
}
function reserveEligible(entry,year){
  const age=finite(entry.player?.physical?.age,20)+Math.max(0,year-Number(entry.signedYear));
  if(entry.entryPath==="INTERNATIONAL" && age<18) return false;
  return true;
}
function consumeAmateurReserveForDeficits(state,{deficits,year,seed}={}){
  validateAmateurAcquisitionState(state);
  if(!(deficits instanceof Map)) throw new TypeError("deficits Map이 필요합니다.");
  let reserve=[...state.reserve],fallbackSerial=state.fallbackSerial ?? 0; const assignments=[]; let fromReserve=0,fallback=0;
  for(const [key,neededRaw] of [...deficits.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
    let needed=Number(neededRaw)||0; if(needed<=0) continue;
    const [organizationId,role]=key.split("|");
    const candidates=reserve.filter((e)=>e.organizationId===organizationId && playerRole(e.player)===role && reserveEligible(e,year))
      .sort((a,b)=>finite(b.acquisitionScore)-finite(a.acquisitionScore) || String(a.player.id).localeCompare(String(b.player.id)));
    for(const entry of candidates.slice(0,needed)){
      assignments.push({player:matureReservePlayer(entry,year),organizationId,role,source:entry.entryPath});
      reserve=reserve.filter((x)=>String(x.player.id)!==String(entry.player.id)); needed-=1; fromReserve+=1;
    }
    if(needed>0){
      fallbackSerial+=1;
      const generated=generateAmateurClass({seed:`${seed}:undrafted-fill:${organizationId}:${role}`,year,size:Math.max(needed*5,20),entryPath:"UNDRAFTED",idOffset:4000+fallbackSerial*1000});
      const matching=generated.players.filter((p)=>playerRole(p)===role).slice(0,needed);
      if(matching.length!==needed) throw new RangeError(`undrafted fallback role mix 부족: ${organizationId}:${role}:${matching.length}/${needed}`);
      for(const player of matching) assignments.push({player,organizationId,role,source:"UNDRAFTED"});
      fallback+=needed; needed=0;
    }
  }
  const next=clone(state); next.reserve=reserve; next.totalActivated+=assignments.length; next.totalUndraftedFallback+=fallback; next.fallbackSerial=fallbackSerial;
  if(next.current) next.current.activation={year,fromReserve,fallback,total:assignments.length};
  return freeze({state:freeze(next),assignments:freeze(assignments),summary:freeze({year,fromReserve,fallback,total:assignments.length,reserveRemaining:reserve.length})});
}
function getAmateurAcquisitionPublicView(state){
  if(!state) return null; validateAmateurAcquisitionState(state); const c=state.current;
  return freeze({
    version:state.version,currentYear:state.currentYear,snapshotCoveredThroughYear:state.snapshotCoveredThroughYear ?? null,
    rules:{draft:DRAFT_RULESET_2026,international:INTERNATIONAL_RULESET_2026},
    draft:c?{year:c.year,status:c.draft.processed?"COMPLETE":"UPCOMING",draftDate:c.draft.draftDate,signingDeadline:c.draft.signingDeadline,classType:c.draft.descriptor.classType,classStrength:c.draft.descriptor.classStrength,orderMethod:c.draft.orderMethod,board:c.draft.descriptor.board.slice(0,20),topPicks:(c.draft.picks ?? []).slice(0,30),picks:c.draft.picks?.length ?? 0,signed:c.draft.signed ?? 0}:null,
    international:c?{year:c.year,status:c.international.processed?"ACTIVE_SIGNINGS_COMPLETE":"UPCOMING",windowStart:c.international.windowStart,windowEnd:c.international.windowEnd,classType:c.international.descriptor.classType,classStrength:c.international.descriptor.classStrength,board:c.international.descriptor.board.slice(0,16),signings:(c.international.signings ?? []).slice(0,24),signingCount:c.international.signings?.length ?? 0}:null,
    reserve:{count:state.reserve.length,byEntryPath:state.reserve.reduce((m,r)=>{m[r.entryPath]=(m[r.entryPath]??0)+1;return m;},{})},
    totals:{drafted:state.totalDrafted,internationalSigned:state.totalInternationalSigned,activated:state.totalActivated,undraftedFallback:state.totalUndraftedFallback},
    lastActivation:c?.activation ?? null,
    history:state.history.slice(-5)
  });
}

export {
  AMATEUR_ACQUISITION_VERSION,
  DRAFT_RULESET_2026,
  INTERNATIONAL_RULESET_2026,
  LOTTERY_ODDS_2026_CBA,
  createAmateurAcquisitionState,
  validateAmateurAcquisitionState,
  normalizeAmateurAcquisitionState,
  prepareAmateurYear,
  processDraftIfDue,
  processInternationalSignings,
  advanceAmateurCalendar,
  consumeAmateurReserveForDeficits,
  getAmateurAcquisitionPublicView
};
