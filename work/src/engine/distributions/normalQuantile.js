// Peter J. Acklam-style rational approximation for the inverse standard-normal
// CDF. Accuracy is far beyond what the 20–99 rating transform needs and avoids
// adding a runtime dependency just for Phase 0 calibration.

const A = Object.freeze([
  -3.969683028665376e1,
  2.209460984245205e2,
  -2.759285104469687e2,
  1.38357751867269e2,
  -3.066479806614716e1,
  2.506628277459239
]);

const B = Object.freeze([
  -5.447609879822406e1,
  1.615858368580409e2,
  -1.556989798598866e2,
  6.680131188771972e1,
  -1.328068155288572e1
]);

const C = Object.freeze([
  -7.784894002430293e-3,
  -3.223964580411365e-1,
  -2.400758277161838,
  -2.549732539343734,
  4.374664141464968,
  2.938163982698783
]);

const D = Object.freeze([
  7.784695709041462e-3,
  3.224671290700398e-1,
  2.445134137142996,
  3.754408661907416
]);

const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

function inverseStandardNormalCdf(probability) {
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new TypeError("확률은 유한한 number여야 합니다.");
  }
  if (probability <= 0 || probability >= 1) {
    throw new RangeError("표준정규 역CDF 확률은 0과 1 사이여야 합니다.");
  }
  if (probability === 0.5) return 0;

  if (probability < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }

  if (probability > P_HIGH) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1)
    );
  }

  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
}

export { inverseStandardNormalCdf };
