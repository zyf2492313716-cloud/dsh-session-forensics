// 修「中途 system/message 没有受保护头」这一类：摘掉那条多余的，并完整重映射跨事件引用。
//
// 报错原文（宿主 dsh-session-format-v3-to-v4/lib/index.js:599）：
//   if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0)
//     throw new SessionFormatError("system/message requires a protected first surface head")
// 也就是：这条会话的 surface 开头不是 system/message（导入路径或压缩重建写丢了受保护头），
// 中途再出现 system/message 就无处安放，整份日志被拒读。
//
// 为什么是"摘"不是"补头"：本机实测两种改法都跑了宿主真实读盘链——
//   补头（在 seq 2 插一条匹配当时开轮/步的 system/message，原条保留）
//     → FAIL relationships: compaction/summary shadowedSeqs do not name an exact current surface span
//       （摘要的 shadowedSeqs 必须精确对上当前 surface 跨度，加一个节点就对不上）
//   摘除 + 完整重映射 → PASS（六层全过）
// 代价：丢掉那条 system/message 本体（实测 7,107 字节的系统提示副本，source.kind:"system-prompt"）。
// 它不是用户内容，宿主恢复时会按当前模型与指令重新生成，所以是可接受的取舍；改前整份备份。
//
// 关键坑（本脚本自己踩过两次，别再踩）：跨事件引用 **挂在事件根上的数字数组**
// （sourceEventSeqs）里，改写时必须逐元素处理；只走"对象属性是数字"会整批漏掉、
// 报错停在 stored 层的 "sourceEventSeqs must reference earlier events"。
//
// 用法（宿主模块在 app.asar 里，用应用自带 Electron 当 node；普通 node 会自动 bootstrap）：
//   node fix-mid-system-message.cjs dry   [id前缀]
//   node fix-mid-system-message.cjs apply [id前缀]      经 lib/safe-write.cjs 闸门（宿主活着拒写）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const V = require(path.join(__dirname, 'lib', 'v4check.cjs'));
V.bootstrapElectron();
const SW = require(path.join(__dirname, 'lib', 'safe-write.cjs'));

const CASE = process.env.DSH_FIX_CASE || path.join(os.homedir(), '.dsh', 'logs', 'offline-writes');
const STAGING = path.join(CASE, 'staging');
const BACKUP = path.join(CASE, 'backups');
const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const PROJCACHE = process.env.DSH_PROJCACHE_DIR ||
  path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const mode = process.argv[2] === 'apply' ? 'apply' : 'dry';
const wantPrefix = process.argv[3];
const ERR_SIG = 'system/message requires a protected first surface head';

// 需要跟着平移的引用键（含复数与数组元素）
const REF = /(^|[.\[])(seq|headerSeq|sourceEventSeqs?|asOfSeq|startSeq|endSeq|throughSeq|boundarySeq)/i;

const clone = (x) => JSON.parse(JSON.stringify(x));

/** 把 fromSeq 及其后的所有 seq 与引用整体加 delta（含根上的数字数组）。 */
function shiftSeqs(list, fromSeq, delta) {
  const bump = (n) => (typeof n === 'number' && n >= fromSeq ? n + delta : n);
  const walk = (v, keyName) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (typeof v[i] === 'number') { if (REF.test(keyName)) v[i] = bump(v[i]); }
        else walk(v[i], keyName);
      }
      return;
    }
    if (v && typeof v === 'object') {
      Object.keys(v).forEach((k) => {
        const val = v[k];
        if (typeof val === 'number') { if (REF.test(k)) v[k] = bump(val); }
        else walk(val, k);
      });
    }
  };
  list.forEach((e) => {
    Object.keys(e).forEach((k) => { if (k !== 'seq') walk(e[k], k); });
    if (typeof e.seq === 'number' && e.seq >= fromSeq) e.seq += delta;
  });
  return list;
}

/** 候选：日志里所有 system/message，从后往前试（后面那条最可能是"中途"的那条）。 */
function candidates(events) {
  const idxs = [];
  events.forEach((e, i) => { if (e.type === 'system/message') idxs.push(i); });
  return idxs.reverse();
}

/** 试每一种"只摘一条"的改法，返回第一个过完整读盘链的。 */
function solve(header, events, inh, fileLabel) {
  for (const idx of candidates(events)) {
    const list = clone(events);
    const removed = list.splice(idx, 1)[0];
    shiftSeqs(list, removed.seq + 1, -1);
    list.forEach((e, i) => { e.seq = i; });
    let err = null;
    try { err = V.verifyDecoded(header, list, inh, fileLabel + ' (去 seq=' + removed.seq + ')'); }
    catch (e) { err = '抛出 ' + e.message; }
    if (!err) return { ok: true, events: list, removed, idx };
    // 继续试下一个候选，同时把这一轮的报错留着
    solve.tried = (solve.tried || []).concat(['  seq=' + removed.seq + ' → FAIL ' + err]);
  }
  return { ok: false };
}

/** 无损证明：除了摘掉的那一条，其余每条只允许 .seq 变化，且变化量恒为 -1 或 0。 */
function proveLossless(orig, repaired, removedSeq) {
  const problems = [];
  if (repaired.length !== orig.length - 1) problems.push('条数不等：' + repaired.length + ' vs ' + (orig.length - 1));
  const keep = orig.filter((e) => e.seq !== removedSeq);
  let shifted = 0, identical = 0, refFixed = 0;
  for (let i = 0; i < keep.length; i++) {
    const a = clone(keep[i]), b = clone(repaired[i]);
    const expSeq = a.seq > removedSeq ? a.seq - 1 : a.seq;
    if (b.seq !== expSeq) { problems.push('idx ' + i + ' seq 非预期（期望 ' + expSeq + ' 实际 ' + b.seq + '）'); continue; }
    const a2 = clone(a);
    // 归一：先按同一规则把 a 的引用与 seq 也移一次，再比全等
    shiftSeqs([a2], removedSeq + 1, -1); a2.seq = expSeq;
    if (JSON.stringify(a2) === JSON.stringify(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) refFixed++;
      else if (a.seq !== b.seq) shifted++; else identical++;
    } else problems.push('idx ' + i + '（原 seq=' + a.seq + ' ' + a.type + '）除 seq/引用外还有差异');
  }
  return { problems, shifted, identical, refFixed };
}

const log = (m) => console.log(m);

async function main() {
  const logs = V.listSessionLogs(SESSIONS).filter((l) => !wantPrefix || l.id.includes(wantPrefix));
  let touched = 0, healthy = 0, otherClass = 0;
  for (const { project, id, file } of logs) {
    const now = V.verifyFile(file);
    if (now.ok) { healthy++; continue; }
    if (!new RegExp(ERR_SIG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(now.err)) { otherClass++; continue; }
    const L = V.loadSessionFile(file);
    const solved = solve(L.header, L.events, L.inheritedEventCount, id);
    log('\n=== ' + project + '\\' + id);
    log('    原件 ' + L.events.length + ' 事件 / ' + fs.statSync(file).size + ' 字节 / 读盘链 FAIL ' + now.err);
    if (!solved.ok) { log('    → 单条摘除都过不了，报「需人工」，不动'); continue; }
    const proof = proveLossless(L.events, solved.events, solved.removed.seq);
    log('    摘除 seq=' + solved.removed.seq + '（turn=' + solved.removed.data.turn +
      ' step=' + solved.removed.data.step + ' source=' + JSON.stringify(solved.removed.data.message && solved.removed.data.message.source) +
      '，' + JSON.stringify(solved.removed.data.message.content).length + ' 字节系统提示副本）');
    log('    候选 ' + solved.events.length + ' 事件 / 完整读盘链 PASS（内存）');
    log('    无损证明：仅 seq 平移 ' + proof.shifted + ' / 引用也改 ' + proof.refFixed +
      ' / 逐字节相同 ' + proof.identical + ' / 违规 ' + proof.problems.length);
    proof.problems.slice(0, 5).forEach((p) => log('      ! ' + p));
    if (solve.tried && solve.tried.length > 1) { log('    其它候选：'); solve.tried.slice(0, -1).forEach((t) => log('    ' + t)); }

    // 落盘前先编成文件过一遍完整链（判的是真要落下去的字节）
    fs.mkdirSync(STAGING, { recursive: true });
    const headerLine = V.decodeFrames(fs.readFileSync(file))[0].split('\n')[0];
    const buf = V.encodeTwoFrames(headerLine, solved.events.map((e) => JSON.stringify(e)));
    const cand = path.join(STAGING, id + '.candidate.jsonl.zstd');
    fs.writeFileSync(cand, buf);
    const candOk = V.verifyFile(cand);
    log('    候选文件 ' + buf.length + ' 字节 → 完整读盘链 ' + (candOk.ok ? 'PASS events=' + candOk.events : 'FAIL ' + candOk.err));

    if (!(candOk.ok && proof.problems.length === 0)) { log('    → 自证不过，不落盘'); continue; }
    if (mode === 'dry') { log('    → dry：候选存 ' + cand); continue; }

    const host = SW.hostAlive();
    const allowLive = process.env.DSH_FIX_ALLOW_LIVE_HOST === '1';
    if (host.alive && !allowLive) { log('    → 拒写：宿主仍在运行（' + host.detail + '）'); continue; }
    if (host.alive) log('    !! 显式强写（DSH_FIX_ALLOW_LIVE_HOST=1），宿主 ' + host.detail + '；本会话读不进⇒无 agent，写前后各复验一次');
    const res = SW.writeSessionLogSync(file, JSON.parse(headerLine), solved.events, {
      skipShape: true, allowLiveHost: allowLive,
      reason: 'mid-log system/message without protected head: remove it + remap all seq refs',
      backupRoot: BACKUP,
    });
    const after = V.verifyFile(file);
    log('    → apply ' + res.events + ' 事件 / ' + res.bytes + ' 字节 / 备份 ' + res.backup);
    log('    → 落盘后复验 ' + (after.ok ? 'PASS events=' + after.events : 'FAIL ' + after.err + '，立刻回滚'));
    if (after.ok) {
      touched++;
      const pc = path.join(PROJCACHE, id + '.json');
      if (!host.alive && fs.existsSync(pc)) {
        fs.mkdirSync(path.join(BACKUP, 'projcache'), { recursive: true });
        fs.copyFileSync(pc, path.join(BACKUP, 'projcache', id + '.json'));
        fs.renameSync(pc, pc + '.removed-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
        log('    → projcache 已摘除（宿主离线才做）');
      }
    } else {
      fs.copyFileSync(res.backup, file);
      log('    → 已逐字节回滚：' + V.verifyFile(file).err);
    }
  }
  log('\n模式=' + mode + ' 修好=' + touched + ' 已健康=' + healthy + ' 别的病型=' + otherClass);
  log('宿主状态 ' + JSON.stringify(SW.hostAlive()));
  log('RESULT=' + (mode === 'apply' ? 'APPLIED:' + touched : 'DRY:' + touched));
}

main().catch((e) => { console.error(e); process.exit(1); });
