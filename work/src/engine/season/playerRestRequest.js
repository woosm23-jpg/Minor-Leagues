const REST_STATUSES = new Set(["PENDING", "APPROVED", "DECLINED", "CANCELLED"]);
const REST_REASONS = new Set([
  "COVER_AVAILABLE", "NO_AVAILABLE_COVER", "NOT_STARTER",
  "NOT_ON_ROSTER", "INJURED_OR_REPLACED", "USER_CANCELLED"
]);

function createPlayerRestRequest({ gameId, level, date, requestedDate }) {
  for (const [key, value] of Object.entries({ gameId, level, date, requestedDate })) {
    if (typeof value !== "string" || !value) throw new TypeError(`휴식 요청 ${key}가 필요합니다.`);
  }
  return Object.freeze({ version: 1, gameId, level, date, requestedDate,
    status: "PENDING", reasonCode: null, resolvedDate: null });
}

function validatePlayerRestRequest(value, label = "restRequest") {
  if (value == null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw new RangeError(`${label} 버전이 호환되지 않습니다.`);
  }
  if (!REST_STATUSES.has(value.status)) throw new RangeError(`${label} 상태가 잘못되었습니다.`);
  for (const key of ["gameId", "level", "date", "requestedDate"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new TypeError(`${label}.${key}가 필요합니다.`);
  }
  for (const key of ["date", "requestedDate"]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value[key])) throw new RangeError(`${label}.${key}가 날짜가 아닙니다.`);
  }
  if (value.status === "PENDING") {
    if (value.reasonCode !== null || value.resolvedDate !== null) throw new RangeError(`${label} 미처리 상태가 잘못되었습니다.`);
  } else {
    if (!REST_REASONS.has(value.reasonCode) ||
      typeof value.resolvedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.resolvedDate)) {
      throw new RangeError(`${label} 결과가 잘못되었습니다.`);
    }
  }
  return true;
}

function settlePlayerRestRequest(request, { approved = false, reasonCode, date }) {
  validatePlayerRestRequest(request);
  if (request.status !== "PENDING") return request;
  if (!REST_REASONS.has(reasonCode) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError("휴식 요청 결과가 잘못되었습니다.");
  return Object.freeze({ ...request,
    status: reasonCode === "USER_CANCELLED" ? "CANCELLED" : approved ? "APPROVED" : "DECLINED",
    reasonCode, resolvedDate: date });
}

function getPlayerRestRequestPublicView(request) {
  if (!request) return Object.freeze({ status: "NONE", gameId: null, level: null, date: null, reasonCode: null });
  validatePlayerRestRequest(request);
  return Object.freeze({ status: request.status, gameId: request.gameId, level: request.level,
    date: request.date, reasonCode: request.reasonCode });
}

export { createPlayerRestRequest, validatePlayerRestRequest, settlePlayerRestRequest, getPlayerRestRequestPublicView };
