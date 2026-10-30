// 用真实日志喂打过补丁的转换器，证明 head 在真数据上也成立（不是只过夹具）。
// 判据：产物 head 恰在 seq=2、只有一条、整形后走宿主真实读盘链 PASS。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const V = require(path.join(SKILL, 'lib', 'v4check.cjs'));
V.bootstrapElectron();
const PLUGIN = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-chat-import', 'lib');

// 会话 id 一律从命令行给。别把本机的真实会话 id 写死进仓库——这是仓库自带 qa-check 的硬规则
// （本文件 2026-10-30 曾因此被判违规并已推送，随即改成参数传入）。
const TARGETS = process.argv.slice(2);
if (!TARGETS.length) {
  console.error('用法: node test-head-reallogs.cjs <sessionId> [sessionId…]');
  console.error('       id 用你本机真实的那些，但别写进仓库。');
  process.exit(2);
}
const ROOT = path.join(os.homedir(), '.dsh', 'sessions');

function findLog(sid) {
  for (const proj of fs.readdirSync(ROOT)) {
    const f = path.join(ROOT, proj, sid, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

(async () => {
  const conv = await import(pathToFileURL(path.join(PLUGIN, 'convert', 'dsh.mjs')).href);
  const hs = await import(pathToFileURL(path.join(PLUGIN, 'host-session.mjs')).href);
  const { validateSessionEvents } = await import(pathToFileURL(path.join(PLUGIN, 'convert', 'index.mjs')).href);
  let bad = 0;
  for (const sid of TARGETS) {
    const file = findLog(sid);
    if (!file) { console.log('  跳过 ' + sid + '（找不到日志）'); continue; }
    // 现盘日志 → 明文 JSONL（转换器吃的就是这份，等价于 bundle 里的 doc.log）
    const frames = V.decodeFrames(fs.readFileSync(file));
    const lines = frames.join('').split('\n').filter(Boolean);
    const out = conv.convertDshJsonl(lines.join('\n') + '\n', { sourcePath: sid + '.dshbundle.json' });
    const sys = out.events.filter((e) => e.type === 'system/message');
    const dense = out.events.every((e, i) => e.seq === i);
    const val = validateSessionEvents(out.events)
    // 插件自己的 source-event-seqs-not-call 比宿主严（源日志里 tool/result 的
    // sourceEventSeqs 本来就指向非 tool/call，出厂 0.26.3 同样报，宿主真实链不拦）：
    // 记为观察项，不算失败；其余 kinds 一律算失败。
    const soft = (val.problems || []).filter((p) => p.kind === 'source-event-seqs-not-call')
    const hard = (val.problems || []).filter((p) => p.kind !== 'source-event-seqs-not-call');
    const shaped = hs.prepareHostEvents(JSON.parse(JSON.stringify(out.events)), 'import-' + sid.replace(/^import-/, ''), 4, 4);
    const phys = JSON.parse(lines[0]);
    const buf = V.encodeTwoFrames(JSON.stringify(phys), shaped.map((e) => JSON.stringify(e)));
    let chain;
    try { const l = V.loadSessionBuffer(buf); const err = V.verifyDecoded(l.header, l.events, l.inheritedEventCount, sid); chain = err ? 'FAIL ' + err : 'PASS events=' + l.events.length; }
    catch (e) { chain = 'FAIL decode: ' + e.message; }
    const okHead = sys.length === 1 && sys[0].seq === 2;
    const okChain = chain.startsWith('PASS');
    const allOk = okHead && dense && hard.length === 0 && okChain;
    if (!allOk) bad++;
    console.log('  ' + (allOk ? '✓' : '✗') + ' ' + sid.slice(0, 18) +
      '  源事件=' + (lines.length - 1) + ' 产物=' + out.events.length +
      ' head=' + (sys[0] ? 'seq' + sys[0].seq : '无') + '×' + sys.length +
      ' seq密集=' + dense + ' 插件校验=' + (hard.length ? JSON.stringify(hard.slice(0, 2)) : 'ok' + (soft.length ? '（观察项 ' + soft.length + ' 条 source-event-seqs-not-call）' : '')) +
      ' 真实链=' + chain.slice(0, 90));
  }
  console.log(bad ? '\nFAILED ' + bad + ' 条' : '\nALL PASS（真实日志经补丁转换器产出合法 head 且宿主读盘链通过）');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
