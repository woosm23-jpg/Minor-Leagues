import { seasonApi } from "../api/seasonApi.js";
import { seasonSaveRepository } from "../db/seasonSaveRepository.js";
import { migrateSeasonSavePayload, seasonSaveFormat, validateSeasonSavePayload } from "./seasonSerialization.js";
import { buildSeasonSaveMetadata } from "./seasonSaveMetadata.js";

const TCU_EXPORT_FORMAT = "THE_CALL_UP_CAREER_EXPORT";
const TCU_EXPORT_FORMAT_VERSION = 1;
const CHECKSUM_ALGORITHM = "SHA-256";
const CANONICALIZATION = "TCU_CANONICAL_JSON_V1";
const MIME_TYPE = "application/vnd.the-call-up+json";

function clone(value) {
  return structuredClone(value);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}가 필요합니다.`);
}

function jsonSafeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("export payload에는 유한한 number만 사용할 수 있습니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`export payload에 지원하지 않는 값이 있습니다: ${typeof value}`);
}

function rightRotate(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

// Dependency-free SHA-256 so a standalone file:// build does not depend on a
// secure-context Web Crypto implementation. Input is UTF-8 and output is hex.
function sha256Hex(text) {
  if (typeof text !== "string") throw new TypeError("SHA-256 입력은 문자열이어야 합니다.");
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const withOne = bytes.length + 1;
  const paddedLength = Math.ceil((withOne + 8) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  const hi = Math.floor(bitLength / 0x100000000);
  const lo = bitLength >>> 0;
  view.setUint32(paddedLength - 8, hi, false);
  view.setUint32(paddedLength - 4, lo, false);

  const k = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const v15 = w[i - 15], v2 = w[i - 2];
      const s0 = rightRotate(v15, 7) ^ rightRotate(v15, 18) ^ (v15 >>> 3);
      const s1 = rightRotate(v2, 17) ^ rightRotate(v2, 19) ^ (v2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + k[i] + w[i]) >>> 0;
      const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
    h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
  }
  return [h0,h1,h2,h3,h4,h5,h6,h7].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function checksumTarget(document) {
  const { checksum: _checksum, ...content } = document;
  return jsonSafeClone(content);
}

function computeTcuChecksum(document) {
  return sha256Hex(canonicalJson(checksumTarget(document)));
}

function validateEnvelopeShape(document) {
  assertObject(document, "TCU export document");
  if (document.format !== TCU_EXPORT_FORMAT) throw new RangeError(`지원하지 않는 TCU format입니다: ${document.format}`);
  if (document.formatVersion !== TCU_EXPORT_FORMAT_VERSION) throw new RangeError(`지원하지 않는 TCU formatVersion입니다: ${document.formatVersion}`);
  assertObject(document.metadata, "TCU metadata");
  assertObject(document.career, "TCU career payload");
  assertObject(document.checksum, "TCU checksum");
  if (document.checksum.algorithm !== CHECKSUM_ALGORITHM) throw new RangeError(`지원하지 않는 checksum algorithm입니다: ${document.checksum.algorithm}`);
  if (document.checksum.canonicalization !== CANONICALIZATION) throw new RangeError(`지원하지 않는 checksum canonicalization입니다: ${document.checksum.canonicalization}`);
  if (!/^[0-9a-f]{64}$/i.test(document.checksum.value ?? "")) throw new RangeError("TCU checksum 값이 잘못되었습니다.");
  if (document.metadata.saveFormat !== document.career.format) throw new RangeError("TCU metadata save format이 payload와 일치하지 않습니다.");
  if (document.metadata.saveSchemaVersion !== document.career.schemaVersion) throw new RangeError("TCU metadata save schema가 payload와 일치하지 않습니다.");
  if (document.metadata.gameVersion !== document.career.gameVersion) throw new RangeError("TCU metadata game version이 payload와 일치하지 않습니다.");
  if (document.metadata.sourceSeasonId !== document.career.seasonId) throw new RangeError("TCU metadata seasonId가 payload와 일치하지 않습니다.");
}

function validateTcuExportDocument(document, { validateCareer = true } = {}) {
  validateEnvelopeShape(document);
  const actual = computeTcuChecksum(document);
  if (actual !== String(document.checksum.value).toLowerCase()) {
    throw new RangeError("TCU checksum이 일치하지 않습니다. 파일이 손상되었거나 변경되었습니다.");
  }
  if (validateCareer) validateSeasonSavePayload(document.career, { mode: "FULL" });
  return true;
}

function sanitizeFilePart(value) {
  return String(value ?? "save").replace(/[^A-Za-z0-9가-힣_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "save";
}

function compactTimestamp(iso) {
  return String(iso).replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function uniqueImportSaveId(repository, sourceSaveId, checksum, nowIso) {
  const base = `import_${sanitizeFilePart(sourceSaveId)}_${compactTimestamp(nowIso)}_${checksum.slice(0, 8)}`;
  let candidate = base;
  for (let index = 1; index <= 100; index += 1) {
    if (!(await repository.get(candidate))) return candidate;
    candidate = `${base}_${index + 1}`;
  }
  throw new RangeError("가져오기용 새 saveId를 만들 수 없습니다.");
}

function createTcuExportDocument({ payload, sourceSaveId, label = "THE CALL-UP 시즌", exportedAt = new Date().toISOString() }) {
  const career = migrateSeasonSavePayload(payload);
  validateSeasonSavePayload(career, { mode: "FULL" });
  const document = jsonSafeClone({
    format: TCU_EXPORT_FORMAT,
    formatVersion: TCU_EXPORT_FORMAT_VERSION,
    exportedAt,
    metadata: {
      sourceSaveId,
      sourceSeasonId: career.seasonId,
      label,
      saveFormat: career.format,
      saveSchemaVersion: career.schemaVersion,
      gameVersion: career.gameVersion,
      currentDate: career.season.currentDate,
      hasActiveGame: Boolean(career.activeGameCheckpoint)
    },
    career
  });
  document.checksum = {
    algorithm: CHECKSUM_ALGORITHM,
    canonicalization: CANONICALIZATION,
    value: computeTcuChecksum(document)
  };
  return document;
}

function parseTcuExportText(text) {
  if (typeof text !== "string" || !text.trim()) throw new TypeError("가져올 .tcu 텍스트가 필요합니다.");
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`.tcu JSON을 읽을 수 없습니다: ${error?.message ?? error}`);
  }
  validateTcuExportDocument(document, { validateCareer: false });
  return document;
}

function createSeasonTransferService({
  repository = seasonSaveRepository,
  now = () => new Date().toISOString()
} = {}) {
  return Object.freeze({
    exportSeason(seasonId, { saveId = seasonId, label = "THE CALL-UP 시즌" } = {}) {
      const payload = seasonApi.serializeSeason(seasonId);
      const exportedAt = now();
      const document = createTcuExportDocument({ payload, sourceSaveId: saveId, label, exportedAt });
      const text = `${JSON.stringify(document, null, 2)}\n`;
      return {
        filename: `THE_CALL_UP_${sanitizeFilePart(saveId)}_${payload.season.currentDate}.tcu`,
        mimeType: MIME_TYPE,
        checksum: document.checksum.value,
        text,
        document: clone(document)
      };
    },

    async importSeasonText(text, { label = null } = {}) {
      const document = parseTcuExportText(text);
      // Full validation intentionally happens before any repository write.
      const migrated = migrateSeasonSavePayload(document.career);
      validateSeasonSavePayload(migrated, { mode: "FULL" });
      const importedAt = now();
      const saveId = await uniqueImportSaveId(repository, document.metadata.sourceSaveId ?? document.metadata.sourceSeasonId, document.checksum.value, importedAt);
      const importedFrom = {
        sourceSaveId: document.metadata.sourceSaveId ?? null,
        exportedAt: document.exportedAt,
        checksum: document.checksum.value,
        formatVersion: document.formatVersion
      };
      const record = {
        ...buildSeasonSaveMetadata(migrated, {
          saveId,
          label: label ?? `${document.metadata.label ?? "THE CALL-UP 시즌"} (가져옴)`,
          updatedAt: importedAt,
          extra: { importedFrom, createdAt: importedAt }
        }),
        payload: migrated
      };
      await repository.put(record);
      return { ...record, payload: undefined };
    },

    async importAndLoadSeason(text, options = {}) {
      const meta = await this.importSeasonText(text, options);
      const record = await repository.get(meta.saveId);
      if (!record) throw new Error("가져온 save를 다시 읽을 수 없습니다.");
      return { meta, snapshot: seasonApi.restoreSeason(record.payload) };
    }
  });
}

const seasonTransferService = createSeasonTransferService();
const tcuExportFormat = Object.freeze({
  format: TCU_EXPORT_FORMAT,
  formatVersion: TCU_EXPORT_FORMAT_VERSION,
  checksumAlgorithm: CHECKSUM_ALGORITHM,
  canonicalization: CANONICALIZATION,
  mimeType: MIME_TYPE,
  currentSaveSchemaVersion: seasonSaveFormat.schemaVersion
});

export { sha256Hex, computeTcuChecksum, validateTcuExportDocument, createTcuExportDocument, parseTcuExportText, createSeasonTransferService, seasonTransferService, tcuExportFormat };
