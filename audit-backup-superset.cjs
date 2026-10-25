// 备份清理器（fail-closed）：只有能证明"现盘是备份的超集"才删，证明不了就保留。
//
// 三道判据（全部通过才删该批次）：
//   1. 批次内每条会话日志副本：对应现盘会话存在、可读、事件数 ≥ 副本；
//      副本里每条"真用户消息"（source.kind=user）在现盘同会话里逐字存在，
//      或在**任意其他现盘会话**里逐字存在（引用/续聊场景，需全库复核）。
//   2. 备份日志本身解不开 → 无法证明 → 保留。
//   3. 批次里混有非日志文件（注册表快照等）→ 不整批删，保留并标注。
// 现盘已不存在的会话 → 该副本是唯一留存，保留。
//
// 用法：node audit-backup-superset.cjs          只审计
//       node audit-backup-superset.cjs --apply  删除判过的批次
const fs = require("node:fs");
const path = require("node:path");
const V = require("./lib/v4check.cjs");
V.bootstrapElectron();

const SESSIONS = process.env.DSH_SESSIONS || path.join(require("node:os").homedir(), ".dsh", "sessions");
const BAK = process.env.DSH_BAK_DIR || path.join(__dirname, "backups");
const apply = process.argv.includes("--apply");

const live = new Map();
for (const { id, file } of V.listSessionLogs(SESSIONS)) live.set(id, file);
const liveText = new Map(); // id -> 解压全文（懒加载，全库复核时用）

function loadText(id) {
  if (liveText.has(id)) return liveText.get(id);
  let t = "";
  try {
    t = V.decodeFrames(fs.readFileSync(live.get(id))).join("");
  } catch {
    t = "";
  }
  liveText.set(id, t);
  return t;
}

function userMessages(file) {
  // 用原始帧解析而不是宿主链：备份里大量是"修复前的损坏原件"，宿主链必然抛错，
  // 但它们的逐行 JSON 仍然可解析——超集比对要的是内容，不是合法性。
  const lines = V.decodeFrames(fs.readFileSync(file)).join("").split("\n").filter(Boolean);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const m = e.type === "user/message" ? e.data : e.data && e.data.message;
    if (m && m.role === "user" && m.source && m.source.kind === "user") {
      const t = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
      if (t) out.push(t);
    }
  }
  return { count: lines.length - 1, users: out };
}

function batchSessionLogs(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/session\.v\d+\.jsonl(\.zstd)?(\.pre-fix\.bak|\.bak)?$/.test(e.name)) out.push(p);
    }
  })(dir);
  return out;
}
function batchOtherFiles(dir) {
  const logs = new Set(batchSessionLogs(dir).map((f) => path.resolve(f)));
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!logs.has(path.resolve(p))) out.push(p);
    }
  })(dir);
  return out;
}

/** 会话 id 以文件内部 header.id 为准（备份目录名可能是工作区名，而非会话 id）。 */
function sessionIdOf(file) {
  try {
    const head = V.decodeFrames(fs.readFileSync(file))[0].split("\n").filter(Boolean)[0];
    return JSON.parse(head).id || null;
  } catch {
    return null;
  }
}

function auditBatch(dir) {
  const logs = batchSessionLogs(dir);
  const others = batchOtherFiles(dir);
  if (!logs.length) return { verdict: "keep", reason: "无会话日志副本（非日志批）", bytes: 0, logs: [] };
  let bytes = 0;
  for (const f of logs) {
    bytes += fs.statSync(f).size;
    const id = sessionIdOf(f);
    if (!id) return { verdict: "keep", reason: `副本读不出 header.id，无法证明`, bytes };
    if (!live.has(id)) return { verdict: "keep", reason: `现盘无会话 ${id.slice(0, 24)}（孤本）`, bytes };
    let a;
    try {
      a = userMessages(f);
    } catch {
      return { verdict: "keep", reason: `副本不可读 ${id.slice(0, 24)}，无法证明`, bytes };
    }
    let bl;
    try {
      bl = userMessages(live.get(id));
    } catch {
      return { verdict: "keep", reason: `现盘 ${id.slice(0, 24)} 读不动`, bytes };
    }
    if (bl.count < a.count) return { verdict: "keep", reason: `现盘事件变少 ${id.slice(0, 24)}（${a.count}→${bl.count}）`, bytes };
    const missing = a.users.filter((t) => !bl.users.includes(t));
    const unaccounted = missing.filter((t) => {
      const probe = t.slice(0, 80);
      return ![...live.keys()].some((oid) => oid !== id && loadText(oid).includes(probe));
    });
    if (unaccounted.length)
      return { verdict: "keep", reason: `用户消息 ${id.slice(0, 24)} 全库都找不到 ${unaccounted.length} 条`, bytes };
  }
  // 全部日志副本可证：无杂项→整批删；有杂项→只删日志，非日志文件（如 imports.json.bak）原地保留
  return others.length
    ? { verdict: "del-logs-only", reason: `现盘为超集；另留 ${others.length} 个非日志文件`, bytes, logs, others }
    : { verdict: "del", reason: `现盘为超集（${logs.length} 条副本，用户消息均有落点）`, bytes, logs, others };
}

const batches = fs.readdirSync(BAK, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
let delBytes = 0;
const plan = []; // {batch, mode:'whole'|'logs-only', logs:[...]}
const keepRows = [];
for (const b of batches) {
  const dir = path.join(BAK, b);
  let r;
  try {
    r = auditBatch(dir);
  } catch (e) {
    r = { verdict: "keep", reason: "审计异常: " + e.message, bytes: 0 };
  }
  if (r.verdict === "del" || r.verdict === "del-logs-only") {
    plan.push({ batch: b, mode: r.verdict === "del" ? "whole" : "logs-only", logs: r.logs });
    delBytes += r.bytes;
    console.log(`${r.verdict === "del" ? "DEL " : "DEL*"} ${b.padEnd(38)} ${(r.bytes / 1048576).toFixed(1).padStart(6)}MB  ${r.reason}`);
  } else {
    keepRows.push({ b, ...r });
    console.log(`KEEP ${b.padEnd(38)} ${(r.bytes / 1048576).toFixed(1).padStart(6)}MB  ${r.reason}`);
  }
}
console.log(`\n判删 ${plan.length} 批 ≈ ${(delBytes / 1048576).toFixed(1)} MB（DEL*=只删日志、留非日志文件）；保留 ${keepRows.length} 批`);

if (apply) {
  const entries = [];
  for (const p of plan) {
    const dir = path.join(BAK, p.batch);
    for (const f of p.logs) entries.push({ batch: p.batch, file: path.relative(BAK, f), size: fs.statSync(f).size });
    if (p.mode === "whole") fs.rmSync(dir, { recursive: true, force: true });
    else for (const f of p.logs) fs.rmSync(f, { force: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifest = path.join(__dirname, `backups-deleted-${stamp}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), freedBytes: delBytes, batches: plan, files: entries }, null, 1));
  console.log(`已删 ${plan.length} 批 / ${entries.length} 个文件，清单留存于 ${path.basename(manifest)}`);
} else {
  console.log("dry 模式（加 --apply 才删）");
}
