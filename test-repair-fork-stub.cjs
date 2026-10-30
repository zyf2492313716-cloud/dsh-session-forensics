// repair-fork-stub.cjs 的合成回归测试——不含任何真实会话数据，可公开运行。
//
// 为什么要有它：2026-10-29 上线版曾因为 build() 在调用方数组上原地改 seq，
// 让无损证明算出"58 条假违规"，工具从此永远拒绝落盘——干跑看不出来，只有拿
// 一份真会触发故障的夹具跑一遍才知道。这条测试就是那个"一遍"。
//
// 用法（普通 node 即可，内部会 bootstrap 到应用自带 Electron 去 require 宿主模块）：
//   node test-repair-fork-stub.cjs
// 退出码：0 = 全部通过；1 = 有断言失败。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const V = require(path.join(__dirname, 'lib', 'v4check.cjs'));
V.bootstrapElectron();

const TOOL = path.join(__dirname, 'repair-fork-stub.cjs');
const CHILD = 'session-fixture-branch-child';
const PARENT = 'session-fixture-branch-parent';
const T0 = 1700000000000;

const fails = [];
const ok = (label, cond, detail) => {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (detail ? '  ' + detail : ''));
  if (!cond) fails.push(label + (detail ? ' :: ' + detail : ''));
};

// ---- 夹具：一条"继承段结尾是未闭合轮、其后又开了新轮"的分支子会话 ----
function fixtureEvents() {
  const e = [];
  const push = (type, data, extra) => { e.push(Object.assign({ type, seq: e.length, time: T0 + e.length }, data, extra || {})); };
  const userMsg = (text, tag) => ({
    data: {
      content: [{ type: 'text', text }],
      source: { kind: 'user', rpcId: 'rpc-' + tag },
      role: 'user',
      id: 'msg-' + tag,
    },
    surfaceOp: 'append',
  });
  push('permission/preset', { data: { preset: 'workspace-write' } });
  push('sandbox/mode', { data: { mode: 'workspace-write' } });
  push('approval/policy', { data: { policy: 'never' } });
  push('agent/inbox/spliced', { data: { target: 'next-turn', start: 0, inserted: [Object.assign({ source: { kind: 'user', rpcId: 'rpc-q1' }, role: 'user', id: 'msg-q1' }, { content: [{ type: 'text', text: '第一条提问' }] })] } });
  // 第 1 轮：开→步→用户消息→收口
  push('turn/start', { data: { turn: 1 } });
  push('step/start', { data: { turn: 1, step: 1 } });
  push('user/message', userMsg('第一条提问', 'q1'));
  push('step/end', { data: { turn: 1, step: 1 } });
  push('turn/end', { data: { turn: 1, reason: { kind: 'completed' } } });
  // 第 2 轮：开了没收口，正好是继承段结尾（故障点）
  push('turn/start', { data: { turn: 2 } });
  push('session/end-seed', { data: { inherited: true } });      // ← 切点
  // 分支自己续写：又开第 3 轮
  push('agent/inbox/spliced', { data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: '[Auto-review — 复盘提示]' }], source: { kind: 'system' }, role: 'system', id: 'msg-r1' }] } });
  push('turn/start', { data: { turn: 3 } });
  push('step/start', { data: { turn: 3, step: 1 } });
  push('user/message', userMsg('复盘内容', 'r1'));
  push('step/end', { data: { turn: 3, step: 1 } });
  push('turn/end', { data: { turn: 3, reason: { kind: 'completed' } } });
  return e;
}

function fixtureHeaderLine() {
  return JSON.stringify({
    type: 'session', version: 4, id: CHILD, createdAt: T0,
    parentSession: PARENT, isSeeded: true, delegationDepth: 0, agentPreset: 'standard',
  });
}

function main() {
  if (!fs.existsSync(TOOL)) { console.log('  [FAIL] 找不到被测脚本 ' + TOOL); process.exit(1); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-fork-test-'));
  const sessRoot = path.join(root, 'sessions');
  const dir = path.join(sessRoot, '_no-cwd', CHILD);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, V.encodeTwoFrames(fixtureHeaderLine(), fixtureEvents().map((e) => JSON.stringify(e))));

  const envFor = (extra) => Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    DSH_SESSIONS: sessRoot,
    DSH_FIX_CASE: root,
    DSH_PROJCACHE_DIR: path.join(root, 'projcache'),
    DSH_FIX_AUDIT_DIR: path.join(root, 'audit'),
  }, extra);

  console.log('夹具目录: ' + root);
  console.log('\n=== 0) 负控制：夹具必须先"坏得起来" ===');
  const pre = V.verifyFile(file);
  ok('夹具被宿主读盘链拒绝', !pre.ok, pre.ok ? '（夹具没复现故障，测试无意义）' : pre.err);
  ok('故障签名正是 turn/start 未开预期轮',
    !pre.ok && /turn\/start does not open the expected turn/.test(pre.err), pre.ok ? '' : pre.err);

  const run = (mode, extraEnv) => {
    const r = spawnSync(process.execPath, [TOOL, mode, 'fixture-branch'], {
      encoding: 'utf8', env: envFor(extraEnv), windowsHide: true,
    });
    return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
  };

  console.log('\n=== 1) dry：必须自证 0 违规，且不碰原文件 ===');
  const beforeHash = V.loadSessionFile(file).events.length;
  const d = run('dry');
  console.log(d.out.split('\n').filter((l) => l.trim()).map((l) => '      ' + l).join('\n'));
  ok('dry 报"违规 0"', /违规\s*0/.test(d.out), (d.out.match(/无损证明.*/) || [''])[0].trim());
  ok('dry 的 seq 平移条数 > 0（这条正是防原地改 seq 的哨兵）',
    /仅 seq 平移\s*([1-9]\d*)/.test(d.out), (d.out.match(/仅 seq 平移\s*\d+/) || ['没命中'])[0]);
  ok('dry 不落盘（RESULT=DRY）', /RESULT=DRY/.test(d.out));
  ok('dry 之后原文件仍读不进', !V.verifyFile(file).ok);

  console.log('\n=== 2) apply（声明离线）：必须真修好且过完整读盘链 ===');
  const a = run('apply', { DSH_FIX_ASSUME_HOST_OFFLINE: '1' });
  console.log(a.out.split('\n').filter((l) => l.trim()).map((l) => '      ' + l).join('\n'));
  ok('apply 报 RESULT=APPLIED', /RESULT=APPLIED/.test(a.out));
  const post = V.verifyFile(file);
  ok('落盘后过宿主真实读盘链', post.ok, post.ok ? 'events=' + post.events : post.err);

  const ev = V.loadSessionFile(file).events;
  const opens = ev.filter((x) => x.type === 'turn/start').map((x) => x.data.turn);
  const closes = ev.filter((x) => x.type === 'turn/end').map((x) => x.data.turn);
  ok('每一轮都收了口', opens.every((t) => closes.includes(t)), '开=' + opens.join(',') + ' 闭=' + closes.join(','));
  const closer = ev.find((x) => x.type === 'turn/end' && x.data.reason && x.data.reason.kind === 'forked');
  ok('补进去的是宿主自己的 forked 收口行', Boolean(closer), closer ? 'seq=' + closer.seq + ' turn=' + closer.data.turn : '没有');
  ok('收口行紧跟在 session/end-seed 之后（buildForkSeed 顺序）',
    (() => {
      const i = ev.findIndex((x) => x.type === 'session/end-seed');
      return i >= 0 && ev[i + 1] && ev[i + 1].type === 'turn/end' && ev[i + 1].data.reason.kind === 'forked';
    })());
  ok('事件数 = 夹具 + 1', ev.length === fixtureEvents().length + 1, ev.length + ' vs ' + (fixtureEvents().length + 1));

  console.log('\n=== 3) 幂等：再跑一次不该再改 ===');
  const len1 = ev.length;
  const a2 = run('apply', { DSH_FIX_ASSUME_HOST_OFFLINE: '1' });
  ok('第二次报"已健康，跳过"', /已健康/.test(a2.out), (a2.out.match(/已健康.*/) || [''])[0].trim());
  ok('第二次没改事件数', V.loadSessionFile(file).events.length === len1);

  console.log('\n=== 4) 审计留痕 ===');
  const auditDir = path.join(root, 'audit');
  const hasAudit = fs.existsSync(auditDir) && fs.readdirSync(auditDir).some((f) => f.endsWith('.jsonl'));
  ok('写了离线写入审计', hasAudit);
  const backups = fs.existsSync(path.join(root, 'backups'));
  ok('留了原件备份目录', backups);

  console.log('\n结论：' + (fails.length ? 'FAIL ' + fails.length + ' 项\n  - ' + fails.join('\n  - ') : '全部通过'));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录留着也无害 */ }
  process.exit(fails.length ? 1 : 0);
}

main();
