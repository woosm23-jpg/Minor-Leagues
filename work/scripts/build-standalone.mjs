import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const entry = "src/main.js";
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const snapshotArg = process.argv.find((arg) => arg.startsWith("--master-snapshot="));
const output = outputArg
  ? path.resolve(root, outputArg.slice("--output=".length))
  : path.resolve(root, "dist/THE_CALL_UP_SEASON_STANDALONE_v48_1.html");
const masterSnapshotPath = snapshotArg ? path.resolve(root, snapshotArg.slice("--master-snapshot=".length)) : null;

const IMPORT_RE = /^import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];\s*$/gm;
const EXPORT_DECL_RE = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_LIST_RE = /^export\s*\{([\s\S]*?)\};\s*$/gm;

function moduleId(absPath) { return path.relative(root, absPath).split(path.sep).join("/"); }
function resolveImport(fromAbs, specifier) {
  if (!specifier.startsWith(".")) throw new Error(`외부 모듈은 standalone bundle에서 지원하지 않습니다: ${specifier}`);
  return path.resolve(path.dirname(fromAbs), specifier);
}
const modules = new Map();
function collect(absPath) {
  const id = moduleId(absPath); if (modules.has(id)) return;
  const source = fs.readFileSync(absPath, "utf8");
  const imports = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const depAbs = resolveImport(absPath, match[2]);
    imports.push({ depAbs });
  }
  modules.set(id, { id, absPath, source, imports });
  for (const item of imports) collect(item.depAbs);
}
function parseExportItem(raw) {
  const item = raw.trim();
  if (!item) return null;
  const m = item.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
  if (!m) throw new Error(`지원하지 않는 export item: ${item}`);
  return { local: m[1], publicName: m[2] ?? m[1] };
}
function transform(mod) {
  let code = mod.source;
  const exports = [...code.matchAll(EXPORT_DECL_RE)].map((match) => ({ local: match[1], publicName: match[1] }));
  for (const match of code.matchAll(EXPORT_LIST_RE)) {
    for (const raw of match[1].split(",")) { const item = parseExportItem(raw); if (item) exports.push(item); }
  }
  code = code.replace(IMPORT_RE, (_raw, names, specifier) => {
    const depAbs = resolveImport(mod.absPath, specifier);
    return `const { ${names.trim()} } = __require('${moduleId(depAbs)}');`;
  });
  code = code.replace(/^export\s+(?=(?:const|let|var|function|class)\s+)/gm, "");
  code = code.replace(EXPORT_LIST_RE, "");
  if (/^export\s+/m.test(code)) throw new Error(`지원하지 않는 export 구문이 있습니다: ${mod.id}`);
  const seen = new Set();
  const exportLines = exports.filter(({publicName}) => !seen.has(publicName) && seen.add(publicName))
    .map(({local,publicName}) => `exports.${publicName} = ${local};`).join("\n");
  return `${code.trim()}\n\n${exportLines}\n`;
}

collect(path.resolve(root, entry));
const css = fs.readFileSync(path.resolve(root, "styles/app.css"), "utf8");
const moduleBlocks = [...modules.values()].sort((a,b)=>a.id.localeCompare(b.id))
  .map((mod)=>`__modules[${JSON.stringify(mod.id)}] = function(module, exports, __require) {\n${transform(mod)}\n};`).join("\n");

function readMasterSnapshot(snapshotPath) {
  const bytes = fs.readFileSync(snapshotPath);
  const text = snapshotPath.endsWith(".gz")
    ? zlib.gunzipSync(bytes).toString("utf8")
    : bytes.toString("utf8");
  return JSON.parse(text);
}

let snapshotBootstrap = "";
if (masterSnapshotPath) {
  const parsed = readMasterSnapshot(masterSnapshotPath);
  snapshotBootstrap = `globalThis.__THE_CALL_UP_MASTER_SNAPSHOT__ = ${JSON.stringify(parsed)};\n`;
}

const bundle = `${snapshotBootstrap}const __modules = Object.create(null);\nconst __cache = Object.create(null);\n${moduleBlocks}\nfunction __require(id) {\n  if (__cache[id]) return __cache[id].exports;\n  const factory = __modules[id];\n  if (!factory) throw new Error('Bundled module not found: ' + id);\n  const module = { exports: {} };\n  __cache[id] = module;\n  factory(module, module.exports, __require);\n  return module.exports;\n}\ntry { __require(${JSON.stringify(entry)}); }\ncatch (error) {\n  console.error(error);\n  const app = document.querySelector('#app');\n  if (app) {\n    app.innerHTML = '<div class="boot-error"><strong>실행 오류</strong><br><pre></pre></div>';\n    app.querySelector('pre').textContent = String(error?.stack || error);\n  }\n}\n(() => {\n  const badge = document.createElement?.('div');\n  if (badge) {\n    badge.className = 'standalone-badge';\n    badge.textContent = ${JSON.stringify(masterSnapshotPath ? '단일 HTML · Complete Edition · Production 2026' : '단일 HTML · Complete Edition')};\n    document.body?.appendChild(badge);\n  }\n})();`;
const extraCss = `\n.standalone-badge { position: fixed; right: 8px; bottom: 8px; z-index: 99; padding: 4px 7px; border-radius: 999px; background: rgba(20,28,38,.88); border: 1px solid #303c49; color: #8492a2; font-size: 8px; pointer-events: none; }\n.boot-error { margin: 24px; padding: 16px; border: 1px solid #57333a; border-radius: 12px; background: #241418; color: #f6d4d8; white-space: pre-wrap; }\n.boot-error pre { overflow-wrap: anywhere; white-space: pre-wrap; }\n`;
const html = `<!doctype html>\n<html lang="ko">\n<head>\n<meta charset="UTF-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n<meta name="theme-color" content="#111318" />\n<title>THE CALL-UP — Complete Edition</title>\n<style>${css}${extraCss}</style>\n</head>\n<body>\n<div id="app" class="app-shell" aria-live="polite"></div>\n<script>${bundle.replaceAll("</script", "<\\/script")}</script>\n</body>\n</html>\n`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, html);
console.log(output);
console.log(`bundled modules: ${modules.size}`);
console.log(`master snapshot: ${masterSnapshotPath ?? 'none'}`);
