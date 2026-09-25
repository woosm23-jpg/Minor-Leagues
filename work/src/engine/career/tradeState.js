const TRADE_STATE_VERSION=1; const CONFIDENCE=new Set(["SPECULATION","CREDIBLE","STRONG"]);
function clone(v){return structuredClone(v);} function assertDate(v,l){if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new TypeError(`${l}는 YYYY-MM-DD 문자열이어야 합니다.`);}
function createTradeState({startDate,userPlayerId}={}){assertDate(startDate,"trade startDate");if(typeof userPlayerId!=="string"||!userPlayerId) throw new TypeError("trade userPlayerId가 필요합니다.");return {schemaVersion:1,userPlayerId,lastReviewDate:startDate,reviews:0,rumors:[],trades:[],agentRequest:{status:"NONE",requestedDate:null,preferences:null}};}
function validateTradeState(state,label="tradeState"){if(!state||typeof state!=="object"||Array.isArray(state)) throw new TypeError(`${label}가 필요합니다.`);if(state.schemaVersion!==1) throw new RangeError(`${label}.schemaVersion이 호환되지 않습니다.`);assertDate(state.lastReviewDate,`${label}.lastReviewDate`);if(!Array.isArray(state.rumors)||!Array.isArray(state.trades)) throw new TypeError(`${label} arrays가 필요합니다.`);for(const r of state.rumors){assertDate(r.date,"trade rumor date");if(!CONFIDENCE.has(r.confidence)) throw new RangeError("trade rumor confidence가 잘못되었습니다.");}if(!state.agentRequest||!["NONE","REQUESTED","SATISFIED","CANCELLED","EXPIRED"].includes(state.agentRequest.status)) throw new RangeError("trade request status가 잘못되었습니다.");
if(state.agentRequest.status==="EXPIRED") {
  assertDate(state.agentRequest.requestedDate, `${label}.agentRequest.requestedDate`);
  assertDate(state.agentRequest.resolvedDate, `${label}.agentRequest.resolvedDate`);
  if(state.agentRequest.resolvedDate < state.agentRequest.requestedDate) throw new RangeError("트레이드 요청 검토 종료일이 요청일 이전입니다.");
  if(state.agentRequest.resolutionReason !== "NO_TRADE_AT_OFFSEASON_REVIEW") throw new RangeError("트레이드 요청 결과가 잘못되었습니다.");
}
return true;}
function normalizeTradeState(existing,opts){if(!existing)return createTradeState(opts);validateTradeState(existing);if(existing.userPlayerId!==opts.userPlayerId)throw new RangeError("tradeState userPlayerId 불일치");return clone(existing);}
function requestTradeState(state, { date, preferences = {} } = {}) {
  validateTradeState(state);
  assertDate(date, "trade request date");
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences) ||
      Object.keys(preferences).some(key => !["preferContender", "preferPlayingTime"].includes(key)) ||
      Object.values(preferences).some(value => typeof value !== "boolean")) {
    throw new RangeError("트레이드 선호는 경쟁력·출전 기회 두 항목만 선택할 수 있습니다.");
  }
  if (state.agentRequest.status === "REQUESTED") {
    if (JSON.stringify(state.agentRequest.preferences ?? {}) === JSON.stringify(preferences)) return state;
    throw new RangeError("트레이드 요청이 이미 진행 중입니다. 변경하려면 먼저 철회하세요.");
  }
  const next = clone(state);
  next.agentRequest = { status: "REQUESTED", requestedDate: date,
    preferences: { ...preferences }, cancelledDate: null };
  return next;
}

function cancelTradeRequestState(state, { date } = {}) {
  validateTradeState(state);
  assertDate(date, "trade cancellation date");
  if (state.agentRequest.status !== "REQUESTED") throw new RangeError("철회할 트레이드 요청이 없습니다.");
  if (date < state.agentRequest.requestedDate) throw new RangeError("요청일 이전에 철회할 수 없습니다.");
  const next = clone(state);
  next.agentRequest = { ...next.agentRequest, status: "CANCELLED", cancelledDate: date };
  return next;
}
// One explicit offseason market review settles a still-pending player request.
// This is a status update, never a fabricated transaction or GM decision.
function expireTradeRequestState(state, { date } = {}) {
  validateTradeState(state);
  if (state.agentRequest.status !== "REQUESTED") return state;
  assertDate(date, "trade review date");
  if (date < state.agentRequest.requestedDate) throw new RangeError("트레이드 요청일 이전에 검토를 종료할 수 없습니다.");
  const next = clone(state);
  next.agentRequest = { ...next.agentRequest, status: "EXPIRED",
    resolvedDate: date, resolutionReason: "NO_TRADE_AT_OFFSEASON_REVIEW" };
  next.reviews += 1;
  next.lastReviewDate = date;
  return next;
}
function addTradeRumor(state,{proposal}={}){validateTradeState(state);const n=clone(state),d=proposal.date;assertDate(d,"trade rumor date");n.rumors=[...n.rumors.filter(r=>r.tradeId!==proposal.tradeId).map(r=>({...r,status:"STALE"})),{rumorId:`rumor_${proposal.tradeId}`,tradeId:proposal.tradeId,date:d,confidence:proposal.rumorConfidence,userInvolved:Boolean(proposal.userInvolved),buyerOrganizationId:String(proposal.buyerOrganizationId),sellerOrganizationId:String(proposal.sellerOrganizationId),status:"ACTIVE"}].slice(-12);n.reviews+=1;n.lastReviewDate=d;return n;}
function recordTrade(state,{proposal}={}){validateTradeState(state);const n=clone(state),d=proposal.date;n.rumors=n.rumors.map(r=>({...r,status:r.tradeId===proposal.tradeId?"COMPLETED":r.status}));n.trades=[...n.trades,{tradeId:proposal.tradeId,date:d,buyerOrganizationId:String(proposal.buyerOrganizationId),sellerOrganizationId:String(proposal.sellerOrganizationId),buyerPlayerIds:proposal.buyerAssets.map(a=>String(a.playerId)),sellerPlayerIds:proposal.sellerAssets.map(a=>String(a.playerId)),userInvolved:Boolean(proposal.userInvolved)}].slice(-40);if(proposal.userInvolved&&n.agentRequest.status==="REQUESTED")n.agentRequest={...n.agentRequest,status:"SATISFIED"};n.lastReviewDate=d;return n;}
function getTradePublicView(state){if(!state)return null;validateTradeState(state);const rumor=[...state.rumors].reverse().find(r=>r.status==="ACTIVE"&&r.userInvolved)??null,last=[...state.trades].reverse().find(t=>t.userInvolved)??null;return Object.freeze({agentRequest:Object.freeze({...state.agentRequest}),rumor:rumor?Object.freeze({...rumor}):null,lastTrade:last?Object.freeze({...last}):null,reviewCount:state.reviews});}
export { TRADE_STATE_VERSION, createTradeState, validateTradeState, normalizeTradeState, requestTradeState, cancelTradeRequestState, expireTradeRequestState, addTradeRumor, recordTrade, getTradePublicView };
