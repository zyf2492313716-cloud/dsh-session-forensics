// 用「宿主真实读盘链」体检全部会话，并证明 class B 那批改动无损。
//
// 用法：
//   node prove-v4check.cjs                 体检现盘
//   node prove-v4check.cjs --diff-bak <备份根>   对备份根下每个日志做 现盘 vs 备份 的
//                                          解码后逐字段比对（证明没丢内容）
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const V = require('./lib/v4check.cjs');

V.bootstrapElectron();

const SESSIONS = process.env.DSH_SESSIONS || path.join(require('node:os').homedir(), '.dsh', 'sessions');

// 忽略"允许变化"的字段：seq（重编号）、source kind（class A 修复）、surfaceOp/sourceEventSeqs（class B）
function normalize(ev) {
  const clone = JSON.parse(JSON.stringify(ev));
  delete clone.seq;
  if (clone.surfaceOp) {
    // 只保留 op 类型，丢弃端点（重编号会整体平移）
    clone.surfaceOp = typeof clone.surfaceOp === 'string' ? clone.surfaceOp : { op: clone.surfaceOp.op };
  }
  if (Array.isArray(clone.sourceEventSeqs)) clone.sourceEventSeqs = '<seqs>';
  const src = clone.type === 'user/message' ? clone.data && clone.data.source : clone.data && clone.data.message && clone.data.message.source;
  if (src && typeof src.kind === 'string') src.kind = src.kind === 'plugin' ? '<plugin>' : src.kind.startsWith('plugin:') ? '<plugin>' : src.kind;
  if (src && 'plugin' in src) delete src.plugin;
  // turn 号重编号：只比对结构不比对编号
  if (clone.data && typeof clone.data.turn === 'number') clone.data.turn = '<turn>';
  return clone;
}

function diffBackup(backupRoot) {
  console.log('== 现盘 vs 备份：解码后逐事件比对（忽略 seq/turn/source-kind 这三类修复面）==');
  let checked = 0;
  let mismatched = 0;
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
    }
    return out;
  };
  for (const bak of walk(backupRoot)) {
    const rel = path.relative(backupRoot, bak);
    const cur = path.join(SESSIONS, rel);
    if (!fs.existsSync(cur)) {
      console.log(`  跳过（现盘无对应）: ${rel}`);
      continue;
    }
    const id = path.basename(path.dirname(bak));
    let A;
    let B;
    try {
      A = V.loadSessionFile(bak);
      B = V.loadSessionFile(cur);
    } catch (e) {
      console.log(`  解码失败 ${id}: ${e.message}`);
      mismatched++;
      continue;
    }
    checked++;
    if (A.events.length !== B.events.length) {
      // 现盘更长 = 修复之后这条会话又被继续使用了（宿主正常追加），
      // 只要求备份的全部事件是现盘的逐条前缀，而不是内容被改写。
      if (B.events.length > A.events.length) {
        const bad = [];
        for (let i = 0; i < A.events.length; i++) {
          if (!isDeepStrictEqual(normalize(A.events[i]), normalize(B.events[i]))) bad.push(i);
        }
        if (bad.length) {
          console.log(`  ✗ ${id} 现盘更长（${A.events.length}→${B.events.length}）但前缀有 ${bad.length} 处不同（首个 ${bad[0]}）`);
          mismatched++;
        } else {
          console.log(`  ✓ ${id}  备份 ${A.events.length} 事件全部是现盘前缀；现盘新增 ${B.events.length - A.events.length} 条（修复后继续使用）`);
        }
        continue;
      }
      console.log(`  ✗ ${id} 事件数变少：备份 ${A.events.length} → 现盘 ${B.events.length}`);
      mismatched++;
      continue;
    }
    const bad = [];
    for (let i = 0; i < A.events.length; i++) {
      if (!isDeepStrictEqual(normalize(A.events[i]), normalize(B.events[i]))) bad.push(i);
    }
    if (bad.length) {
      console.log(`  ✗ ${id} 有 ${bad.length} 个事件内容不同（首个 index ${bad[0]}）`);
      mismatched++;
    } else {
      console.log(`  ✓ ${id}  ${A.events.length} 事件，内容等价`);
    }
  }
  console.log(`\n比对 ${checked} 个，不一致 ${mismatched} 个`);
  return mismatched;
}

function audit() {
  const logs = V.listSessionLogs(SESSIONS);
  let bad = 0;
  for (const { project, id, file } of logs) {
    const r = V.verifyFile(file);
    if (!r.ok) {
      bad++;
      console.log(`✗ ${project}\\${id}\n    [${r.stage}] ${r.err}`);
    }
  }
  console.log(`\n${logs.length - bad}/${logs.length} 通过（宿主真实读盘链）`);
  return bad;
}

const args = process.argv.slice(2);
const diffIdx = args.indexOf('--diff-bak');
if (diffIdx !== -1) {
  const root = args[diffIdx + 1];
  if (!root || !fs.existsSync(root)) {
    console.error('用法: prove-v4check.cjs --diff-bak <备份根目录>');
    process.exit(2);
  }
  process.exit(diffBackup(root) ? 1 : 0);
}
process.exit(audit() ? 1 : 0);
