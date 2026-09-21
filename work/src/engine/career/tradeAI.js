const TRADE_RUMOR_CONFIDENCE = Object.freeze(["SPECULATION", "CREDIBLE", "STRONG"]);
const TRADE_TEAM_DIRECTIONS = Object.freeze(["BUYER", "NEUTRAL", "SELLER"]);
function clamp(v, lo=0, hi=1) { return Math.min(hi, Math.max(lo, Number(v))); }
function teamDirection({ winningPct=0.5, seasonProgress=0.5, payrollFlex=0.5, prospectDepth=0.5 } = {}) {
  const pct=clamp(winningPct), progress=clamp(seasonProgress), flex=clamp(payrollFlex), prospects=clamp(prospectDepth);
  const urgency=(pct-0.5)*1.8*progress + (flex-0.5)*0.25;
  if (urgency >= 0.11) return "BUYER";
  if (urgency <= -0.11 || (pct < 0.46 && progress > 0.55 && prospects < 0.55)) return "SELLER";
  return "NEUTRAL";
}
function tradeValue(asset, { teamNeed=0.5, direction="NEUTRAL" } = {}) {
  const current=clamp(asset.currentContribution), future=clamp(asset.futureValue), control=clamp(Number(asset.controlYears ?? 0)/6);
  const surplus=clamp((Number(asset.contractSurplus ?? 0)+1)/2), scarcity=clamp(asset.scarcity), need=clamp(teamNeed), injury=clamp(asset.injuryRisk);
  const age=Number(asset.age ?? 27), agePenalty=clamp((age-28)/12,0,1), recent=clamp((Number(asset.recentPerformance ?? 0)+1)/2), confidence=clamp(asset.scoutingConfidence ?? 0.65);
  const rentalPenalty=Number(asset.controlYears ?? 0) < 1 ? 0.16 : 0;
  const weights=direction==="BUYER" ? {current:.31,future:.20,control:.12,surplus:.12,fit:.15,recent:.10}
    : direction==="SELLER" ? {current:.16,future:.34,control:.20,surplus:.13,fit:.10,recent:.07}
    : {current:.24,future:.27,control:.16,surplus:.13,fit:.12,recent:.08};
  const raw=current*weights.current + future*weights.future + control*weights.control + surplus*weights.surplus + ((scarcity+need)/2)*weights.fit + recent*weights.recent;
  return Number((Math.max(0, raw*confidence - injury*0.14 - agePenalty*0.08 - rentalPenalty)).toFixed(4));
}
function packageValue(assets, context) {
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 2) throw new RangeError("v54 player package는 한쪽 1~2명이어야 합니다.");
  return Number(assets.reduce((sum,a)=>sum+tradeValue(a,context),0).toFixed(4));
}
function rumorConfidence({ valueGap, seasonProgress=0.5, userInvolved=false, tradeRequest=false } = {}) {
  let score=(1-clamp(Math.abs(Number(valueGap ?? 1))/0.45))*0.62 + clamp(seasonProgress)*0.23 + (userInvolved?0.08:0) + (tradeRequest?0.05:0);
  score=clamp(score); if (score>=.72) return "STRONG"; if(score>=.46) return "CREDIBLE"; return "SPECULATION";
}
function buildTradeProposal({date,buyer,seller,buyerAssets,sellerAssets,userPlayerId=null,tradeRequest=false}) {
  if (!date || !buyer?.organizationId || !seller?.organizationId) throw new TypeError("trade proposal context가 필요합니다.");
  if (String(buyer.organizationId)===String(seller.organizationId)) throw new RangeError("같은 조직끼리 trade할 수 없습니다.");
  if (buyerAssets.length!==sellerAssets.length || buyerAssets.length<1 || buyerAssets.length>2) throw new RangeError("v54 package는 1-for-1 또는 2-for-2를 지원합니다.");
  for(let i=0;i<buyerAssets.length;i+=1){ if(buyerAssets[i].level!==sellerAssets[i].level||buyerAssets[i].roleClass!==sellerAssets[i].roleClass) throw new RangeError("paired trade asset mismatch"); }
  const buyerDirection=buyer.direction??teamDirection(buyer), sellerDirection=seller.direction??teamDirection(seller);
  const buyerReceives=packageValue(sellerAssets,{teamNeed:buyer.needScore,direction:buyerDirection}), sellerReceives=packageValue(buyerAssets,{teamNeed:seller.needScore,direction:sellerDirection});
  const gap=buyerReceives-sellerReceives, userInvolved=[...buyerAssets,...sellerAssets].some(a=>String(a.playerId)===String(userPlayerId));
  return Object.freeze({schemaVersion:1,tradeId:`trade_${date}_${buyer.organizationId}_${seller.organizationId}_${buyerAssets.map(a=>a.playerId).join("-")}_${sellerAssets.map(a=>a.playerId).join("-")}`,date,
    buyerOrganizationId:String(buyer.organizationId),sellerOrganizationId:String(seller.organizationId),buyerDirection,sellerDirection,
    buyerAssets:buyerAssets.map(a=>Object.freeze({...a,playerId:String(a.playerId)})),sellerAssets:sellerAssets.map(a=>Object.freeze({...a,playerId:String(a.playerId)})),
    value:Object.freeze({buyerReceives,sellerReceives,gap:Number(gap.toFixed(4))}),rumorConfidence:rumorConfidence({valueGap:gap,seasonProgress:Math.max(buyer.seasonProgress??0,seller.seasonProgress??0),userInvolved,tradeRequest}),
    userInvolved,tradeRequestInfluence:Boolean(tradeRequest),status:"PROPOSED"});
}
export { TRADE_RUMOR_CONFIDENCE, TRADE_TEAM_DIRECTIONS, teamDirection, tradeValue, packageValue, rumorConfidence, buildTradeProposal };
