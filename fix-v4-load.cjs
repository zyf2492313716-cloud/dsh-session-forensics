// 修复宿主拒载的 V4 会话日志，只修"宿主确实读不进"的，改完用宿主真实读盘链复验。
//
// 判据（与宿主 readStoredLog 同构，见 lib/v4check.cjs）：
//   readZstdPrefix → codec.createDecoder → 逐行 decodeRow（内含 decodeSeqRanges 展开）
//   → finish() → assertReleasedV4Relationships → validateStoredEvents
// 关键：decodeRow 会把存储形态的区间对 [[a,b]] 展开成 [a..b]，所以「区间对」本身
// 不是故障。本机 2026-10-22 曾用"跳过 decodeRow"的校验器把 8 个健康会话误判成坏、
// 多改了一遍——本脚本不再重复这个错误。
//
// 实际会修的只有两类（都是离线脚本写坏的）：
//   A. source.kind === "plugin"（V4 已退休的包装）
//   C. 追加尾段的 seq/turn 与重导后的头部撞号
//
// 用法：
//   node fix-v4-load.cjs dry     只看会改什么（默认）
//   node fix-v4-load.cjs apply   真正落盘（经 lib/safe-write.cjs 闸门，宿主存活时拒写）
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const V = require('./lib/v4check.cjs');
V.bootstrapElectron();
const { writeSessionLog, hostAlive, shapeEvents } = require('./lib/safe-write.cjs');

const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const BACKUP_ROOT =
  process.env.DSH_FIX_BACKUP_ROOT || path.join(os.homedir(), '.dsh', 'logs', 'offline-writes', 'backups');
const BACKUP = path.join(BACKUP_ROOT, 'v4load-' + STAMP);
const mode = process.argv[2] === 'apply' ? 'apply' : 'dry';

// 宿主 dsh-session-format-v3-to-v4 的 producerKind() 表
const RENAMED = {
  compact: 'compact-checkpoint',
  'tools-code-mode': 'ptc-mode',
  'tools-ptc': 'ptc-mode',
  'dsh-compaction-basic': 'compact-basic',
  '@deepseek-ai/dsh-system-prompt': 'runtime-context',
};
const SAME_NAME = new Set([
  'agent-instructions', 'session-reference', 'team-message', 'goal', 'skill-invocation',
  'skill-catalog', 'coordinator', 'subagent-report', 'subagent-settled', 'webhook',
  'agent-message', 'model-selection', 'plan-mode', 'time-context', 'tmux-context',
  'user-approval', 'repeat-tool-reminder', 'tool-cordis', 'cordis-host-runner', 'tool-goal',
  'tool-jobs', 'hooks-codex', 'hooks-claude-code', 'schedule', 'dsh-session-title-llm',
]);

function producerKind(plugin, role) {
  if (plugin === '@deepseek-ai/dsh-system-prompt' && role === 'system') return 'system-prompt';
  if (Object.hasOwn(RENAMED, plugin)) return RENAMED[plugin];
  if (SAME_NAME.has(plugin)) return plugin;
  return 'plugin:' + plugin;
}

function messageOf(ev) {
  if (ev.type === 'user/message') return ev.data;
  if (['system/message', 'developer/message', 'assistant/message', 'tool/result'].includes(ev.type)) {
    return ev.data && ev.data.message;
  }
  return undefined;
}
function messagesOf(ev) {
  if (ev.type === 'agent/inbox/spliced') return Array.isArray(ev.data && ev.data.inserted) ? ev.data.inserted : [];
  if (ev.type === 'session/title-llm-request') return Array.isArray(ev.data && ev.data.messages) ? ev.data.messages : [];
  return [];
}

// ---- A：plugin 包装的 source ----
function fixPluginSources(evs) {
  let n = 0;
  const fix = (m) => {
    if (!m || typeof m !== 'object' || !m.source || m.source.kind !== 'plugin') return;
    const plugin = m.source.plugin;
    if (typeof plugin !== 'string') throw new Error('plugin source without plugin name');
    const rest = Object.fromEntries(Object.entries(m.source).filter(([k]) => k !== 'plugin'));
    m.source = { ...rest, kind: producerKind(plugin, m.role) };
    n++;
  };
  for (const ev of evs) {
    const m = messageOf(ev);
    if (m) fix(m);
    for (const x of messagesOf(ev)) fix(x);
  }
  return n;
}

// ---- C：尾段 seq/turn 与头部撞号 ----
function renumberStaleTail(evs) {
  let cut = -1;
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].seq !== i) { cut = i; break; }
  }
  if (cut === -1) return null;
  const oldBase = evs[cut].seq;
  const newBase = cut;
  const seqShift = newBase - oldBase;
  if (seqShift <= 0) throw new Error(`tail seq ${oldBase} >= index ${cut}, unexpected`);

  const remap = (v) => (Number.isSafeInteger(v) ? v + seqShift : v);
  const head = evs.slice(0, cut);
  const tail = evs.slice(cut);

  const headTurns = head.filter((e) => e.type === 'turn/start').map((e) => e.data.turn);
  const headMaxTurn = headTurns.length ? headTurns[headTurns.length - 1] : 0;
  const tailFirstTurn = tail.filter((e) => e.type === 'turn/start').map((e) => e.data.turn)[0];
  const turnShift = tailFirstTurn === undefined ? 0 : headMaxTurn + 1 - tailFirstTurn;

  for (const ev of tail) {
    if (Number.isSafeInteger(ev.seq)) ev.seq = remap(ev.seq);
    if (Number.isSafeInteger(ev.headerSeq)) ev.headerSeq = remap(ev.headerSeq);
    if (Array.isArray(ev.sourceEventSeqs)) {
      // 存储形态可能是区间对；这里只平移平坦整数，区间对展开交给宿主解码
      ev.sourceEventSeqs = ev.sourceEventSeqs.map((v) => (Array.isArray(v) ? v.map(remap) : remap(v)));
    }
    if (ev.surfaceOp && typeof ev.surfaceOp === 'object') {
      if (Number.isSafeInteger(ev.surfaceOp.startSeq)) ev.surfaceOp.startSeq = remap(ev.surfaceOp.startSeq);
      if (Number.isSafeInteger(ev.surfaceOp.endSeq)) ev.surfaceOp.endSeq = remap(ev.surfaceOp.endSeq);
    }
    if (ev.data && typeof ev.data === 'object') {
      for (const key of Object.keys(ev.data)) {
        if (key === 'sourceEventSeq' && Number.isSafeInteger(ev.data[key])) ev.data[key] = remap(ev.data[key]);
        if (key === 'turn' && Number.isSafeInteger(ev.data[key]) && turnShift !== 0) ev.data[key] += turnShift;
      }
    }
  }
  return { cut, oldBase, newBase, seqShift, turnShift, tailEvents: tail.length, headMaxTurn };
}

function logicalHeader(header) {
  const h = { ...header };
  delete h.type;
  return h;
}

// 供 session-doctor.cjs 等调用方复用的单文件修复入口（不跑 CLI 主流程）。
// @returns {Promise<{ok:true, a:number, c:boolean}|{ok:false, reason:string}>}
async function repairOne(file, opts = {}) {
  const pre = V.verifyFile(file);
  if (pre.ok) return { ok: true, a: 0, c: false, alreadyHealthy: true };

  const raw = readRawEvents(file);
  if (!raw) return { ok: false, reason: `帧结构/JSON 坏，需 reframe：[${pre.stage}] ${pre.err}` };

  const events = raw.events;
  try {
    const a = fixPluginSources(events);
    const c = renumberStaleTail(events);
    if (!a && !c) return { ok: false, reason: `非 A/C 类：[${pre.stage}] ${pre.err}` };
    const physical = JSON.parse(raw.headerLine);
    const r = await writeSessionLog(file, physical, events, {
      reason: opts.reason || `doctor:${a ? 'A' : ''}${c ? 'C' : ''}`,
      backupRoot: opts.backupRoot || BACKUP,
    });
    return { ok: true, a, c: Boolean(c), events: r.events, backup: r.backup };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { repairOne, fixPluginSources, renumberStaleTail, producerKind, readRawEvents };

// 读出原始行（不经过 decodeRow）。
// 修复坏档必须先拿到未解码的行——decodeRow 恰恰在坏档上会抛错。
// 拿不到（帧结构坏/JSON 坏）返回 null，这类交给 reframe.mjs。
function readRawEvents(file) {
  try {
    const frames = V.decodeFrames(fs.readFileSync(file));
    const headLines = frames[0].split('\n').filter(Boolean);
    if (headLines.length !== 1) return null;
    const all = frames.join('').split('\n').filter(Boolean);
    if (all[0] !== headLines[0]) return null;
    const events = all.slice(1).map((l) => JSON.parse(l));
    return { headerLine: headLines[0], events };
  } catch {
    return null;
  }
}

// ---- 主流程（仅作为 CLI 运行时执行；被 require 时只导出函数）----
// 逐文件逻辑统一走 repairOne()，CLI 只负责打印与汇总——避免两条代码路径各写各的
// （上一版就是这么埋了个"CLI 修了、repairOne 没修"的分叉风险）。
async function main() {
  const logs = V.listSessionLogs(SESSIONS);
  let touched = 0;
  const fails = [];

  for (const { project, id, file } of logs) {
    const pre = V.verifyFile(file);
    if (pre.ok) continue;

    // dry 模式不能真写盘：用 repairOne 的判定逻辑 + 临时文件自证，不落盘
    if (mode === 'dry') {
      const raw = readRawEvents(file);
      if (!raw) {
        console.log(`\n[跳过] ${project}\\${id}\n    帧结构/JSON 坏，交给 reframe.mjs：[${pre.stage}] ${pre.err}`);
        fails.push({ id, reason: pre.err, kind: 'unframeable' });
        continue;
      }
      try {
        const a = fixPluginSources(raw.events);
        const c = renumberStaleTail(raw.events);
        if (!a && !c) {
          console.log(`\n[需人工] ${project}\\${id}\n    ${pre.stage}: ${pre.err}\n    （非 A/C 类，未改动）`);
          fails.push({ id, reason: pre.err, kind: 'unknown' });
          continue;
        }
        console.log(`\n[dry] ${project}\\${id}`);
        console.log(`   原错误: [${pre.stage}] ${pre.err}`);
        if (a) console.log(`   A 改写 plugin source: ${a} 条`);
        if (c) {
          console.log(
            `   C 尾段重编号: ${c.tailEvents} 事件，seq ${c.oldBase}→${c.newBase}（位移 ${c.seqShift}），` +
              `turn 位移 ${c.turnShift}（头部最大 turn ${c.headMaxTurn}）`,
          );
        }
        // 自证：整形 + 写临时文件 + 真实链读回，不碰原文件
        const shaped = await shapeEvents(raw.events, JSON.parse(raw.headerLine).id, 4);
        const probe = file + '.dryprobe';
        fs.writeFileSync(
          probe,
          V.encodeTwoFrames(raw.headerLine, shaped.events.map((e) => JSON.stringify(e))),
        );
        const r = V.verifyFile(probe);
        fs.rmSync(probe, { force: true });
        if (!r.ok) throw new Error(`dry 自证失败 [${r.stage}] ${r.err}`);
        console.log(`   ✓ dry 自证通过（整形 + 真实读盘链），未改动磁盘`);
        touched++;
      } catch (e) {
        fails.push({ id, reason: e.message });
        console.log(`\n[skip] ${project}\\${id}\n   放弃：${e.message}`);
      }
      continue;
    }

    // apply：直接复用 repairOne（内部走 safe-write 闸门）
    const r = await repairOne(file, { backupRoot: BACKUP, reason: 'fix-v4-load' });
    if (r.ok) {
      console.log(`\n[fix] ${project}\\${id}`);
      console.log(`   原错误: [${pre.stage}] ${pre.err}`);
      if (r.a) console.log(`   A 改写 plugin source: ${r.a} 条`);
      if (r.c) console.log(`   C 尾段已重编号`);
      console.log(`   ✓ 已写入 ${r.events} 事件，备份 ${r.backup}`);
      touched++;
    } else {
      fails.push({ id, reason: r.reason });
      console.log(`\n[skip] ${project}\\${id}\n   放弃：${r.reason}`);
    }
  }

  const host = hostAlive();
  console.log(
    `\n模式=${mode}  命中 ${touched} 个，失败/待人工 ${fails.length} 个。` +
      `宿主${host.alive ? '在运行（apply 会被闸门拒绝）' : '未运行'}。备份根: ${BACKUP}`,
  );
  if (fails.length) {
    fs.mkdirSync(BACKUP, { recursive: true });
    fs.writeFileSync(path.join(BACKUP, '_failed.json'), JSON.stringify(fails, null, 1));
  }
  return fails.length ? 1 : 0;
}

if (require.main === module) main().then((code) => process.exit(code));
