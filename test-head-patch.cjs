// test-head-patch.cjs —— 证明「bundle 还原/DSH 重导」这条生成链到底有没有写 protected head
//
// 跑法（用应用自带 Electron 当 node，宿主真实读盘链才可用）：
//   $env:ELECTRON_RUN_AS_NODE=1; & '<DeepSeek Harness.exe>' test-head-patch.cjs [--expect-head]
//
// --expect-head：断言产物里有合法 head（打完补丁后用这个跑，必须全绿）
// 不带该参数＝负控制：断言产物**没有** head（补丁前跑，必须"确实没有"，
// 否则说明这个测试根本没测到病灶）。
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const V = require(path.join(SKILL, 'lib', 'v4check.cjs'));
V.bootstrapElectron();

const PLUGIN = process.env.DSH_IMPORT_PLUGIN_LIB
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-chat-import', 'lib');

const T0 = 1_760_000_000_000;
// 一份「DSH 原生会话日志」的最小夹具：有 turn/step/用户提问/回复，**没有** system/message
// （这正是 .dshbundle.json 里 doc.log 的形状——导出侧同样不带 head）
function fixtureJsonl() {
  const lines = [
    { type: 'session', id: 'sess-fixture', createdAt: T0, cwd: 'C:\\fixture' },
    { type: 'turn/start', seq: 0, time: T0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: T0, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: T0, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user', rpcId: 'r1' } } },
    { type: 'assistant/message', seq: 3, time: T0 + 1000, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '在的' }], source: { kind: 'model', provider: 'fixture', model: 'm1' } } } },
    { type: 'step/end', seq: 4, time: T0 + 1000, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: T0 + 1000, data: { turn: 1 } },
  ];
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

const fails = [];
const checks = [];
/** 用宿主真实读盘链校验一份内存日志字节（与 verifyFile 同三层，只是不落盘） */
function verifyBuf(buf, label) {
  let loaded;
  try { loaded = V.loadSessionBuffer(buf); } catch (e) { return { ok: false, stage: 'decode', err: e.message }; }
  const err = V.verifyDecoded(loaded.header, loaded.events, loaded.inheritedEventCount, label);
  if (err) return { ok: false, stage: 'validate', err };
  return { ok: true, events: loaded.events.length };
}
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  if (!ok) fails.push(name + (detail === undefined ? '' : ' → ' + detail));
}

(async () => {
  const expectHead = process.argv.includes('--expect-head');
  const conv = await import(pathToFileURL(path.join(PLUGIN, 'convert', 'dsh.mjs')).href);
  const hostSession = await import(pathToFileURL(path.join(PLUGIN, 'host-session.mjs')).href);
  const { validateSessionEvents } = await import(pathToFileURL(path.join(PLUGIN, 'convert', 'index.mjs')).href);

  const out = conv.convertDshJsonl(fixtureJsonl(), { sourcePath: 'fixture.dshbundle.json' });
  const ids = out.events.map((e) => e.type);
  console.log('convertDshJsonl 产出 ' + out.events.length + ' 条：' + ids.join(' | '));

  // 1) seq 必须密集（插入 head 后最容易破的就是这条）
  const dense = out.events.every((e, i) => e.seq === i);
  check('seq 密集 0..N-1', dense, dense ? '' : '首个不连续处 index=' + out.events.findIndex((e, i) => e.seq !== i));

  // 2) head 存在性（本测试的主判据）
  const sys = out.events.filter((e) => e.type === 'system/message');
  if (expectHead) {
    check('产物含 protected head（system/message）', sys.length === 1, '实际 ' + sys.length + ' 条');
    const head = sys[0];
    check('head 位置＝第一个 step/start 之后（seq=2）', head && head.seq === 2, head && 'seq=' + head.seq);
    check('head 前面没有任何 surface 事件', head && out.events.slice(0, head.seq).every((e) => !['user/message', 'assistant/message', 'tool/result', 'developer/message'].includes(e.type)));
    check('head content 为空数组（不虚构提示词）', head && Array.isArray(head.data?.message?.content) && head.data.message.content.length === 0);
    check('head 带 surfaceOp=append', head && head.surfaceOp === 'append');
    check('head source 是 system-prompt 生产者（整形后）', (() => {
      const shaped = hostSession.prepareHostEvents(JSON.parse(JSON.stringify(out.events)), 'import-fixture', 4, 4);
      const h = shaped.find((e) => e.type === 'system/message');
      return h && h.data?.message?.source?.kind === 'system-prompt';
    })());
  } else {
    check('【负控制】未打补丁时产物确实没有 head（有 head 说明测试没测到病灶）',
      sys.length === 0, '却发现了 ' + sys.length + ' 条 system/message');
  }

  // 3) 插件自己的校验器（source-event-seqs-not-call 是比宿主严的观察项，见 reallogs 注释）
  const val = validateSessionEvents(out.events);
  const hard = (val.problems || []).filter((p) => p.kind !== 'source-event-seqs-not-call');
  check('validateSessionEvents 通过', val.ok || hard.length === 0, hard.length ? JSON.stringify(hard.slice(0, 4)) : '');

  // 4) 最硬的一把尺子：宿主真实读盘链（走 prepareHostEvents 整形 + 两帧编码）
  const shaped = hostSession.prepareHostEvents(JSON.parse(JSON.stringify(out.events)), 'import-fixture', 4, 4);
  const header = { type: 'session', version: 4, id: 'import-fixture', cwd: 'C:\\fixture', createdAt: T0, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  const buf = V.encodeTwoFrames(JSON.stringify(header), shaped.map((e) => JSON.stringify(e)));
  const vf = verifyBuf(buf, 'fixture-after-import');
  check('宿主真实读盘链（六层）通过', vf.ok, vf.ok ? 'events=' + vf.events : '[' + vf.stage + '] ' + vf.err);

  // 5) 复发模拟：在这条导入会话里续聊一轮。宿主在**开着的轮/步**里写 system/message，
  //    顺序与真实现场一致（step/start → system/message → user/message，见 0923 那条的 seq 33132-33134）。
  //    没 head → 冷读必须报 protected first surface head（界面上那行红字）；
  //    有 head → 同样这条中途 system/message 合法（本机 45 条原生会话就是这个形态），冷读必须通过。
  const tail = JSON.parse(JSON.stringify(shaped));
  const push = (o) => { o.seq = tail.length; tail.push(o); };
  const t2 = tail.reduce((m, e) => Math.max(m, (e.data && e.data.turn) || 0), 0) + 1;
  push({ type: 'turn/start', time: T0 + 5000, data: { turn: t2 } });
  push({ type: 'step/start', time: T0 + 5000, data: { turn: t2, step: 1 } });
  push({ type: 'system/message', time: T0 + 5000, surfaceOp: 'append', data: { turn: t2, step: 1, message: { id: 'host-sys-2', role: 'system', content: [{ type: 'text', text: '系统提示' }], source: { kind: 'system-prompt' } } } });
  push({ type: 'user/message', time: T0 + 5000, surfaceOp: 'append', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '再问一句' }], source: { kind: 'user' } } });
  const vf2 = verifyBuf(V.encodeTwoFrames(JSON.stringify(header), tail.map((e) => JSON.stringify(e))), 'fixture-after-resume');
  if (expectHead) {
    check('续聊后（宿主替换 head）冷读仍通过', vf2.ok, vf2.ok ? '' : '[' + vf2.stage + '] ' + vf2.err);
  } else {
    check('【负控制】无 head 时续聊必复现界面那行报错', !vf2.ok && /protected first surface head/.test(String(vf2.err)),
      vf2.ok ? '居然通过了（说明模拟不成立）' : '[' + vf2.stage + '] ' + vf2.err);
  }

  console.log('');
  for (const c of checks) console.log((c.ok ? '  ✓ ' : '  ✗ ') + c.name + (c.detail ? '  [' + c.detail + ']' : ''));
  console.log('');
  if (fails.length) { console.log('FAILED ' + fails.length + ' 项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
  console.log(expectHead ? 'ALL PASS（head 已生成，冷读+续聊都过）' : 'NEGATIVE CONTROL OK（未打补丁的产物确实没有 head，且续聊复现报错）');
  process.exit(0);
})().catch((e) => { console.error('测试自身异常：' + (e && e.stack || e)); process.exit(2); });
