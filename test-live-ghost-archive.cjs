// 验证「宿主在线也能归档冷残骸」的三条闸。合成夹具，不碰真实库。
// 期望（宿主在跑）：
//   健康冷残骸(2h前)  → 被归档
//   E 类坏档(刚建)    → 不动（健康闸不过 + 重建类修复要离线）
//   顶层正常会话      → 一个字节不变
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const V = require(path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts', 'lib', 'v4check.cjs'));
V.bootstrapElectron();
const HERE = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const T0 = 1700000000000;
const fails = [];
const ok = (l, c, d) => { console.log((c ? '  [PASS] ' : '  [FAIL] ') + l + (d ? '  ' + d : '')); if (!c) fails.push(l); };

const mk = (e, t, data, rest) => e.push(Object.assign({ type: t, seq: e.length, time: T0 + e.length }, data, rest || {}));
const user = (e, text, tag) => mk(e, 'user/message', { data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-' + tag }, role: 'user', id: 'msg-' + tag }, surfaceOp: 'append' });
const turn = (e, n, text) => { mk(e, 'turn/start', { data: { turn: n } }); mk(e, 'step/start', { data: { turn: n, step: 1 } }); user(e, text, 't' + n); mk(e, 'step/end', { data: { turn: n, step: 1 } }); mk(e, 'turn/end', { data: { turn: n, reason: { kind: 'completed' } } }); };
const prologue = (e) => { mk(e, 'permission/preset', { data: { preset: 'workspace-write' } }); mk(e, 'sandbox/mode', { data: { mode: 'workspace-write' } }); mk(e, 'approval/policy', { data: { policy: 'never' } }); };

function write(root, proj, id, extra, events) {
  const d = path.join(root, 'sessions', proj, id);
  fs.mkdirSync(d, { recursive: true });
  const h = JSON.stringify(Object.assign({ type: 'session', version: 4, id, createdAt: T0, agentPreset: 'standard' }, extra));
  const f = path.join(d, 'session.v4.jsonl.zstd');
  fs.writeFileSync(f, V.encodeTwoFrames(h, events.map((x) => JSON.stringify(x))));
  return f;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-ghost-'));
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1',
  DSH_SESSIONS: path.join(root, 'sessions'), DSH_FIX_CASE: root,
  DSH_PROJCACHE_DIR: path.join(root, 'projcache'), DSH_FIX_AUDIT_DIR: path.join(root, 'audit'),
  DSH_GHOST_ARCHIVE_DIR: path.join(root, 'ghost-archive'),
};
fs.mkdirSync(env.DSH_PROJCACHE_DIR, { recursive: true });

// 1) 健康残骸（无 cwd 子会话，闭合）
const eGhost = []; prologue(eGhost); turn(eGhost, 1, '父会话第1轮');
mk(eGhost, 'session/end-seed', { data: { inherited: true } }); turn(eGhost, 2, '分支自己一轮');
const fGhost = write(root, '_no-cwd', 'session-live-ghost', { parentSession: 'session-parent-x', isSeeded: true, delegationDepth: 0 }, eGhost);
// 2) E 类坏档（继承段结尾未闭合）
const eBad = []; prologue(eBad); turn(eBad, 1, '父会话第1轮');
mk(eBad, 'turn/start', { data: { turn: 2 } });
mk(eBad, 'session/end-seed', { data: { inherited: true } });
mk(eBad, 'agent/inbox/spliced', { data: { target: 'next-turn', start: 0, inserted: [] } });
turn(eBad, 3, '复盘一轮');
const fBad = write(root, '_no-cwd', 'session-live-bad', { parentSession: 'session-parent-y', isSeeded: true, delegationDepth: 0 }, eBad);
// 3) 顶层正常
const eTop = []; prologue(eTop); turn(eTop, 1, '普通一问');
const fTop = write(root, 'proj', 'session-live-top', { cwd: path.join(root, 'ws'), isSeeded: false, delegationDepth: 0 }, eTop);
const topHash = fs.readFileSync(fTop).toString('base64');

// 把健康残骸的 mtime 拨回 2 小时；坏档保持"刚建"
const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
fs.utimesSync(fGhost, twoHoursAgo, twoHoursAgo);

console.log('夹具: ' + root);
console.log('前置: 健康残骸=' + V.verifyFile(fGhost).ok + '  E类坏档=' + V.verifyFile(fBad).ok + '  顶层=' + V.verifyFile(fTop).ok);

const r = spawnSync(process.execPath, [path.join(HERE, 'session-doctor.cjs'), '--json', '--fix-safe'], { encoding: 'utf8', env, windowsHide: true, maxBuffer: 32e6 });
const out = (r.stdout || '') + (r.stderr || '');
let j = null; try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch { console.log(out.slice(0, 800)); }
ok('输出是 JSON', Boolean(j));
if (j) {
  console.log('  ' + JSON.stringify({ hostAlive: j.hostAlive, broken: j.broken, eRepaired: j.eRepaired, ghostsArchived: j.ghostsArchived }));
  ok('宿主确实是"在跑"状态', j.hostAlive === true);
  ok('健康冷残骸被归档（1 条）', j.ghostsArchived === 1, 'ghostsArchived=' + j.ghostsArchived);
  ok('E 类坏档没被修（在线不做重写类修复）', j.eRepaired === 0, 'eRepaired=' + j.eRepaired);
}
ok('健康残骸已离开原位', !fs.existsSync(fGhost));
ok('E 类坏档仍在原位（等离线再修）', fs.existsSync(fBad));
ok('E 类坏档仍读不进（没被动过）', !V.verifyFile(fBad).ok);
ok('顶层会话字节未变', fs.readFileSync(fTop).toString('base64') === topHash);
console.log('\n结论: ' + (fails.length ? 'FAIL ' + fails.length + ' 项' : '全部通过'));
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails.length ? 1 : 0);
