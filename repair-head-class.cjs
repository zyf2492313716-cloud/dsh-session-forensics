// repair-head-class.cjs —— 全库修「protected head」类（补 seq=2 空头，不只摘中途那条）
//
// 为什么必须有这个：只把中途那条 system/message 摘掉（fix-mid-system-message.cjs 的做法）
// 会让日志**当场可读**，但头仍然缺失——用户下次在这条会话里发消息，宿主再补写一条中途
// system/message，同一行红字又回来了。本机 2026-10-30 就是这么复发第二次的。
//
// 判据来自 lib/head-class.cjs；修法逐条交给 fix-head.cjs apply（自带真实读盘链自证、
// 新鲜度守卫、备份、失败回滚），所以这里不做任何写盘动作。
//
// 用法：
//   node repair-head-class.cjs dry            只列清单
//   node repair-head-class.cjs apply          逐条修（宿主活着时 fix-head 会拒，除非
//                                             已确认该会话宿主读不进并设 DSH_FIX_ALLOW_LIVE=1）
// 输出契约（给 session-doctor 解析）：末行 RESULT=HEADFIXED:<n>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const V = require(path.join(SKILL, 'lib', 'v4check.cjs'));
V.bootstrapElectron();
const { classifyHead, needsHead } = require('./lib/head-class.cjs');

const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const mode = process.argv[2] || 'dry';
if (!['dry', 'apply'].includes(mode)) { console.error('用法: node repair-head-class.cjs dry|apply'); process.exit(2); }

const hits = [];
let scanned = 0, unreadable = 0;
for (const { project, id, file } of V.listSessionLogs(SESSIONS)) {
  scanned++;
  let loaded;
  try { loaded = V.loadSessionFile(file); } catch { unreadable++; continue; } // 读不进的由别的类别处理
  const c = classifyHead(loaded.events);
  if (needsHead(c.cls)) hits.push({ project, id, file, cls: c.cls, events: loaded.events.length, mid: c.mid.slice(0, 4), mtime: fs.statSync(file).mtime.toISOString().slice(0, 19) });
}

console.log(`扫描 ${scanned} 条（读不进 ${unreadable} 条，另计）；需要补头 ${hits.length} 条：`);
for (const h of hits) console.log(`  ${h.cls === 'BROKEN_NOW' ? '✗ 现在就读不进' : '⚠ 能读但下次续聊必炸'} ${h.project}\\${h.id}  events=${h.events} mid=${JSON.stringify(h.mid)} mtime=${h.mtime}`);

let done = 0, refused = 0;
if (mode === 'apply') {
  for (const h of hits) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'fix-head.cjs'), 'apply', h.id], {
      encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = /落盘: PASS/.test(out);
    if (ok) done++; else refused++;
    console.log(`  ${ok ? '✓' : '✗'} ${h.id.slice(0, 24)} ${out.split('\n').filter((l) => /落盘|新鲜度|拒绝|放弃|拒写|FAIL/.test(l)).join(' | ').slice(0, 220)}`);
  }
  console.log(`模式=apply 修好=${done} 未修=${refused}`);
}
console.log('RESULT=HEADFIXED:' + done);
process.exit(mode === 'apply' && refused ? 1 : 0);
