// 端到端测 session-doctor 的受限自愈（--fix-safe）。全部用合成夹具，不含任何真实会话数据。
//
// 夹具三件：
//   1) 一条 E 类病型日志（分支继承段结尾是未闭合轮）→ 应当被补一行收口并修好
//   2) 一条「无 cwd 的子会话」但日志健康 → 应当被归档（不删，可回滚）
//   3) 一条正常的顶层会话 → 一条都不许碰
// 断言：坏档修好、残骸归零、顶层会话字节不变、A/C 类没被顺手改（--fix-safe 不含它）。
//
// 用法：node test-doctor-selfheal.cjs    退出码 0=通过
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const V = require(path.join(__dirname, 'lib', 'v4check.cjs'));
V.bootstrapElectron();

const HERE = __dirname;
const fails = [];
const ok = (label, cond, detail) => {
  console.log((cond ? '  [PASS] ' : '  [FAIL] ') + label + (detail ? '  ' + detail : ''));
  if (!cond) fails.push(label + (detail ? ' :: ' + detail : ''));
};

const T0 = 1700000000000;

// 造一条日志。三种形状都是宿主真实读盘链认可的形状（宿主的尺子很严：
// header 必须带 isSeeded，且 isSeeded:true 的会话必须有 session/end-seed{inherited:true}）：
//   top   —— 顶层会话（有 cwd），1 轮闭合
//   ghost —— 分支子会话（无 cwd），切点后自己又跑了一轮，全部闭合（读得进，只是点不开）
//   e     —— E 类病型：切点前的继承段结尾是"开了没收口的轮"，切点后又开一轮
const mk = (e, type, data, rest) => e.push(Object.assign({ type, seq: e.length, time: T0 + e.length }, data, rest || {}));
const userMsg = (e, text, tag) => mk(e, 'user/message', {
  data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-' + tag }, role: 'user', id: 'msg-' + tag },
  surfaceOp: 'append',
});
const closedTurn = (e, n, text) => {
  mk(e, 'turn/start', { data: { turn: n } });
  mk(e, 'step/start', { data: { turn: n, step: 1 } });
  userMsg(e, text, 't' + n);
  mk(e, 'step/end', { data: { turn: n, step: 1 } });
  mk(e, 'turn/end', { data: { turn: n, reason: { kind: 'completed' } } });
};
const prologue = (e) => {
  mk(e, 'permission/preset', { data: { preset: 'workspace-write' } });
  mk(e, 'sandbox/mode', { data: { mode: 'workspace-write' } });
  mk(e, 'approval/policy', { data: { policy: 'never' } });
};

function fixture(shape) {
  const e = [];
  prologue(e);
  if (shape === 'top') {
    closedTurn(e, 1, '第 1 条提问');
    return { events: e, header: { isSeeded: false, delegationDepth: 0 } };
  }
  if (shape === 'ghost') {
    closedTurn(e, 1, '父会话里的第 1 轮');            // 继承段（闭合）
    mk(e, 'session/end-seed', { data: { inherited: true } });
    closedTurn(e, 2, '分支自己的一轮');                // 切点后正常跑完
    return { events: e, header: { parentSession: 'session-fixture-parent', isSeeded: true, delegationDepth: 0 } };
  }
  // E 类：第 2 轮开了没收口，正是继承段结尾；切点后又开第 3 轮
  closedTurn(e, 1, '父会话里的第 1 轮');
  mk(e, 'turn/start', { data: { turn: 2 } });
  mk(e, 'session/end-seed', { data: { inherited: true } });
  mk(e, 'agent/inbox/spliced', { data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: '[复盘提示]' }], source: { kind: 'system' }, role: 'system', id: 'msg-r' }] } });
  closedTurn(e, 3, '复盘内容');
  return { events: e, header: { parentSession: 'session-fixture-parent', isSeeded: true, delegationDepth: 0 } };
}

function writeSession(root, project, id, headerExtra, events) {
  const dir = path.join(root, 'sessions', project, id);
  fs.mkdirSync(dir, { recursive: true });
  const header = JSON.stringify(Object.assign({ type: 'session', version: 4, id, createdAt: T0, agentPreset: 'standard' }, headerExtra));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), V.encodeTwoFrames(header, events.map((x) => JSON.stringify(x))));
  return path.join(dir, 'session.v4.jsonl.zstd');
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-selfheal-'));
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_SESSIONS: path.join(root, 'sessions'),
    DSH_FIX_CASE: root,
    DSH_PROJCACHE_DIR: path.join(root, 'projcache'),
    DSH_FIX_AUDIT_DIR: path.join(root, 'audit'),
    DSH_GHOST_ARCHIVE_DIR: path.join(root, 'ghost-archive'),
    DSH_GHOST_MIN_AGE_MIN: '0',
    DSH_FIX_ASSUME_HOST_OFFLINE: '1',
  };
  fs.mkdirSync(env.DSH_PROJCACHE_DIR, { recursive: true });

  // 三种夹具（形状都由 fixture() 保证是宿主认得的形状）
  const fx = { e: fixture('e'), ghost: fixture('ghost'), top: fixture('top') };

  // 1) E 类：切点 data.inherited=true，其前的继承段结尾是没闭合的轮
  const fileE = writeSession(root, '_no-cwd', 'session-fixture-e', fx.e.header, fx.e.events);
  // 2) 健康的无 cwd 子会话（残骸）：读得进，但宿主按 not-found 拒绝打开
  const fileG = writeSession(root, '_no-cwd', 'session-fixture-ghost', fx.ghost.header, fx.ghost.events);
  // 3) 正常顶层会话（有 cwd）：一个字节都不许动
  const fileT = writeSession(root, 'fixture-project', 'session-fixture-top',
    Object.assign({ cwd: path.join(root, 'workspace') }, fx.top.header), fx.top.events);
  const topHash = fs.readFileSync(fileT).toString('base64');

  // 残骸也留一份 projcache 行，验证会被一起收走
  fs.writeFileSync(path.join(env.DSH_PROJCACHE_DIR, 'session-fixture-ghost.json'), '{"record":{"identity":{},"rows":{}}}', 'utf8');

  console.log('夹具根: ' + root);
  console.log('\n=== 前置状态 ===');
  const preE = V.verifyFile(fileE), preG = V.verifyFile(fileG), preT = V.verifyFile(fileT);
  ok('E 类夹具确实读不进', !preE.ok && /turn\/start does not open the expected turn/.test(preE.err), preE.err);
  ok('残骸夹具读得进（问题只在没 cwd）', preG.ok);
  ok('顶层夹具读得进', preT.ok);

  // 年龄闸（本机踩过：13:38 刚建的复盘子会话被 13:40 归档，宿主句柄继续往归档那份写）
  console.log('\n=== 0b) 年龄闸：刚被写过的残骸不许归档 ===');
  const guard = spawnSync(process.execPath, [path.join(HERE, 'cleanup-ghost.cjs'), 'dry'], {
    encoding: 'utf8', env: Object.assign({}, env, { DSH_GHOST_MIN_AGE_MIN: '9999' }), windowsHide: true,
  });
  const gout = (guard.stdout || '') + (guard.stderr || '');
  ok('年龄闸把新鲜残骸全部挡下（可归档 0、SKIPPED-FRESH:2）',
    /残骸 0 条可归档/.test(gout) && /SKIPPED-FRESH:2/.test(gout),
    (gout.split('\n').find((l) => l.indexOf('RESULT=') === 0) || '没有 RESULT 行'));
  ok('被闸住时残骸仍在原位', fs.existsSync(fileG));

  console.log('\n=== 跑 session-doctor --json --fix-safe ===');
  const r = spawnSync(process.execPath, [path.join(HERE, 'session-doctor.cjs'), '--json', '--fix-safe'], {
    encoding: 'utf8', env, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  let j = null;
  try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* 下面断言会报 */ }
  if (!j) { console.log(out.split('\n').slice(0, 40).map((l) => '      ' + l).join('\n')); }
  ok('输出是合法 JSON', Boolean(j));
  if (!j) { finish(root); return; }
  console.log('      ' + JSON.stringify({ total: j.total, healthy: j.healthy, broken: j.broken, fixed: j.fixed, eRepaired: j.eRepaired, ghostsArchived: j.ghostsArchived, hostAlive: j.hostAlive }));

  ok('总数=3', j.total === 3);
  ok('体检前坏档=1', j.broken === 1);
  ok('E 类修好 1 条', j.eRepaired === 1, 'eRepaired=' + j.eRepaired);
  ok('A/C 没被顺手跑（--fix-safe 不该动正文）', j.fixed === 0, 'fixed=' + j.fixed);
  ok('残骸归档 2 条（E 修好后也算残骸）', j.ghostsArchived === 2, 'ghostsArchived=' + j.ghostsArchived);

  console.log('\n=== 落盘效果 ===');
  ok('E 类日志已从 sessions 归档走', !fs.existsSync(fileE));
  ok('残骸日志已归档走', !fs.existsSync(fileG));
  const postT = V.verifyFile(fileT);
  ok('顶层会话仍在且可读', postT.ok, postT.ok ? 'events=' + postT.events : postT.err);
  ok('顶层会话字节未变', fs.readFileSync(fileT).toString('base64') === topHash);

  const archRoot = path.join(root, 'ghost-archive');
  const stamps = fs.existsSync(archRoot) ? fs.readdirSync(archRoot) : [];
  ok('归档目录生成了批次', stamps.length === 1, stamps.join(','));
  if (stamps.length) {
    const b = path.join(archRoot, stamps[0]);
    ok('归档里有 manifest', fs.existsSync(path.join(b, 'manifest.json')));
    ok('归档里有 rollback.ps1', fs.existsSync(path.join(b, 'rollback.ps1')));
    const man = JSON.parse(fs.readFileSync(path.join(b, 'manifest.json'), 'utf8'));
    ok('manifest 记了 2 条 + 三条证明', man.items.length === 2 && man.proofs && man.proofs.length === 2 &&
      man.proofs.every((p) => p.原位消失 && p.归档在位 && p.字节一致));
    const arc = path.join(b, 'session-fixture-e', 'session.v4.jsonl.zstd');
    const av = V.verifyFile(arc);
    ok('E 类归档件已修好（补了收口）', av.ok, av.ok ? 'events=' + av.events : av.err);
    ok('归档件仍带 forked 收口行', (() => {
      if (!fs.existsSync(arc)) return false;
      return V.loadSessionFile(arc).events.some((e) => e.type === 'turn/end' && e.data.reason && e.data.reason.kind === 'forked');
    })());
    ok('projcache 行一起收进了归档', fs.existsSync(path.join(b, '_projcache', 'session-fixture-ghost.json')));
  }

  console.log('\n=== 幂等：再跑一次不该有动作 ===');
  const r2 = spawnSync(process.execPath, [path.join(HERE, 'session-doctor.cjs'), '--json', '--fix-safe'], {
    encoding: 'utf8', env, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  let j2 = null; try { j2 = JSON.parse((r2.stdout || '').slice((r2.stdout || '').indexOf('{'))); } catch { /* 断言会报 */ }
  ok('第二次没有再修/再归档', j2 && j2.eRepaired === 0 && j2.ghostsArchived === 0, j2 ? 'e=' + j2.eRepaired + ' g=' + j2.ghostsArchived : '输出不可解析');
  ok('第二次坏档=0', j2 && j2.broken === 0);

  finish(root);
}

function finish(root) {
  console.log('\n结论：' + (fails.length ? 'FAIL ' + fails.length + ' 项\n  - ' + fails.join('\n  - ') : '全部通过'));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 留着看 */ }
  process.exit(fails.length ? 1 : 0);
}

main();
