// E 类修复：fork/branch 种下来、继承段结尾是未闭合轮的会话日志。
//
// 病型与判据见 references/fork-seed-open-turn-tail.md。要点：
//   切点是 data.inherited===true 的那条 session/end-seed（另一类 data:{} 是崩溃恢复的段尾标记）；
//   收口行不自己编，直接调宿主 repair.js#openTurnClosers(prefix, {kind:'forked'})；
//   按 buildForkSeed 的顺序插在 end-seed 之后，其后事件 seq 顺延，正文一个字节不改。
//
// 用法（要 require 得到宿主模块，必须用应用自带 Electron 当 node；普通 node 会自动 bootstrap 过去）：
//   node repair-fork-stub.cjs dry   [id前缀]     只出候选 + 自证，不碰原文件
//   node repair-fork-stub.cjs apply [id前缀]     离线落盘（经 lib/safe-write.cjs 闸门）
//   DSH_FIX_ALLOW_LIVE_HOST=1 … apply            宿主在线强写（三条前置证据见 SKILL.md「在线强写」）
// 默认扫全部会话；给 id 前缀就只处理命中的那条。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const V = require(path.join(__dirname, 'lib', 'v4check.cjs'));
V.bootstrapElectron();
const SW = require(path.join(__dirname, 'lib', 'safe-write.cjs'));

// staging / 备份落在审计根下面（技能树之外），可用 DSH_FIX_CASE 改
const CASE = process.env.DSH_FIX_CASE ||
  path.join(os.homedir(), '.dsh', 'logs', 'offline-writes', 'repair-fork-stub');
const STAGING = path.join(CASE, 'staging');
const BACKUP = path.join(CASE, 'backups');
const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const PROJCACHE = process.env.DSH_PROJCACHE_DIR ||
  path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const mode = process.argv[2] === 'apply' ? 'apply' : 'dry';
const wantPrefix = process.argv[3];

function openTurnClosers() {
  // 不从包入口 re-export，只能走深路径（见 reference）
  const mods = path.join(V.resolveResources(), 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  return require(path.join(mods, 'dsh-session', 'lib', 'types', 'repair.js')).openTurnClosers;
}

// 取最后一个「扫到它为止轮还开着、且其后确实又开了新轮」的 fork 切点。
// findIndex 取第一条会命中父会话带进来的旧标记，据此误判成"别的病型"。
function findSeedCut(events) {
  const seedIdxs = [];
  events.forEach((e, i) => { if (e.type === 'session/end-seed') seedIdxs.push(i); });
  for (let k = seedIdxs.length - 1; k >= 0; k--) {
    const seedIdx = seedIdxs[k];
    const d = events[seedIdx].data;
    if (!(d && d.inherited === true)) continue;
    let openTurn = null;
    for (let i = 0; i <= seedIdx; i++) {
      const e = events[i];
      if (e.type === 'turn/start') openTurn = e.data.turn;
      else if (e.type === 'turn/end') openTurn = null;
    }
    if (openTurn === null) continue;
    if (!events.slice(seedIdx + 1).some((e) => e.type === 'turn/start')) continue;
    return { seedIdx, openTurn, markers: seedIdxs.length };
  }
  return null;
}

function build(events) {
  // 全程在深拷贝上做：下面要按新下标重排 seq，一旦落到调用方的对象上，
  // 自证（proveLossless）拿到的 orig 就已经被平移过，会算出"期望 531 实际 530"
  // 这类双平移假阳性、从而永远拒绝落盘（本机 2026-10-29 冒烟测实测）。
  const src = JSON.parse(JSON.stringify(events));
  const cut = findSeedCut(src);
  if (!cut) return null;
  const prefix = src.slice(0, cut.seedIdx + 1); // 含 end-seed，与 buildForkSeed 一致
  const closers = openTurnClosers()(JSON.parse(JSON.stringify(prefix)), { kind: 'forked' });
  if (!closers.length) return null;
  const out = prefix.concat(closers, src.slice(cut.seedIdx + 1));
  out.forEach((e, i) => { e.seq = i; }); // 重排密排（只动副本）
  return { events: out, closers, seedIdx: cut.seedIdx, openTurn: cut.openTurn, markers: cut.markers };
}

// 无损证明：摘掉新增收口行、把 seq 归一后，必须与原件逐条全等。
// 注意别原地改 orig（map 里改 e.seq 会把原件一起改掉，得出"59 条违规"的假阳性）。
function proveLossless(orig, repaired, added) {
  const problems = [];
  const withoutNew = repaired.filter((e, i) => i <= added.seedIdx || i > added.seedIdx + added.closers.length);
  if (withoutNew.length !== orig.length) problems.push('摘除收口行后条数不等: ' + withoutNew.length + ' vs ' + orig.length);
  let shifted = 0, identical = 0;
  for (let i = 0; i < orig.length; i++) {
    const a = JSON.parse(JSON.stringify(orig[i]));
    const b = JSON.parse(JSON.stringify(withoutNew[i]));
    const expSeq = a.seq + (a.seq > added.seedIdx ? added.closers.length : 0);
    if (b.seq !== expSeq) problems.push('idx ' + i + ' seq 非预期（期望 ' + expSeq + ' 实际 ' + b.seq + '）');
    const a2 = JSON.parse(JSON.stringify(orig[i])); a2.seq = b.seq;
    if (JSON.stringify(a2) === JSON.stringify(b)) { if (a.seq !== b.seq) shifted++; else identical++; }
    else problems.push('idx ' + i + '（seq=' + orig[i].seq + ' ' + orig[i].type + '）除 seq 外还有差异');
  }
  // 跨事件 seq 引用有没有落在被平移的区间里（有就必须跟着平移）
  const dangling = [];
  const shiftedFrom = added.seedIdx + 1;
  const walk = (v, keyPath, owner) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, keyPath + '[]', owner)); return; }
    if (v && typeof v === 'object') { Object.keys(v).forEach((k) => walk(v[k], keyPath ? keyPath + '.' + k : k, owner)); return; }
    if (typeof v === 'number' && /(^|\.)(seq|.*Seq|.*Seqs|asOfSeq|startSeq|endSeq|headerSeq|sourceEventSeq)$/.test(keyPath) && v >= shiftedFrom) {
      dangling.push(owner + ' ' + keyPath + '=' + v);
    }
  };
  orig.forEach((e) => Object.keys(e).forEach((k) => { if (k !== 'seq') walk(e[k], k, 'seq=' + e.seq); }));
  return { problems, shifted, identical, addedRows: added.closers.length, dangling };
}

const log = (m) => console.log(m);

function main() {
  const logs = V.listSessionLogs(SESSIONS).filter((l) => !wantPrefix || l.id.includes(wantPrefix));
  let touched = 0, healthy = 0, otherClass = 0, refused = 0;
  for (const { project, id, file } of logs) {
    let loaded;
    try { loaded = V.loadSessionFile(file); }
    catch (e) { log('  跳过（连解都解不开，另判）' + id + ': ' + e.message); continue; }
    const now = V.verifyFile(file);
    const built = build(loaded.events);
    if (!built) { if (!now.ok) otherClass++; continue; }
    if (now.ok) { healthy++; log('  已健康，跳过: ' + project + '\\' + id); continue; }

    const proof = proveLossless(loaded.events, built.events, built);
    const memErr = V.verifyDecoded(loaded.header, JSON.parse(JSON.stringify(built.events)),
      built.seedIdx + 1 + built.closers.length, '(memory)');
    fs.mkdirSync(STAGING, { recursive: true });
    const headerLine = V.decodeFrames(fs.readFileSync(file))[0].split('\n')[0]; // 原 header 行逐字节沿用
    const buf = V.encodeTwoFrames(headerLine, built.events.map((e) => JSON.stringify(e)));
    const cand = path.join(STAGING, id + '.candidate.jsonl.zstd');
    fs.writeFileSync(cand, buf);
    const candCheck = V.verifyFile(cand);

    log('\n=== ' + project + '\\' + id);
    log('    原件 ' + loaded.events.length + ' 事件 / ' + fs.statSync(file).size + ' 字节 / 读盘链 ' + (now.ok ? 'PASS' : 'FAIL ' + now.err));
    log('    切点 seq=' + built.seedIdx + '（本文件 ' + built.markers + ' 条 end-seed，此条 data.inherited=true），未闭合轮=' + built.openTurn);
    log('    补入 ' + built.closers.map((c) => c.type + ' turn=' + c.data.turn + ' reason=' + c.data.reason.kind).join(', '));
    log('    候选 ' + built.events.length + ' 事件 / ' + buf.length + ' 字节 / 完整读盘链 ' + (candCheck.ok ? 'PASS' : 'FAIL ' + candCheck.err));
    log('    无损证明 仅 seq 平移 ' + proof.shifted + ' / 逐字节相同 ' + proof.identical + ' / 新增 ' + proof.addedRows + ' 行 / 违规 ' + proof.problems.length + ' / 悬空引用 ' + proof.dangling.length);
    proof.problems.slice(0, 5).forEach((p) => log('      ! ' + p));
    proof.dangling.slice(0, 5).forEach((p) => log('      ! 悬空 ' + p));
    if (memErr) log('    ! 内存层校验 FAIL ' + memErr);

    const gateOk = candCheck.ok && !memErr && proof.problems.length === 0 && proof.dangling.length === 0;
    if (!gateOk) { log('    → 自证不过，不落盘（悬空引用要先补平移映射）'); refused++; continue; }
    if (mode === 'dry') { log('    → dry：候选已存 ' + cand); continue; }

    const host = SW.hostAlive();
    const allowLive = process.env.DSH_FIX_ALLOW_LIVE_HOST === '1';
    if (host.alive && !allowLive) {
      log('    → 拒写：宿主仍在运行（' + host.detail + '）。要在线强写需显式 DSH_FIX_ALLOW_LIVE_HOST=1，并先核实三条前置证据');
      refused++;
      continue;
    }
    if (host.alive) {
      log('    !! 在线强写（宿主 pid ' + host.pids.join(',') + '）。前提：本会话读不进→宿主无 agent；mtime 长时未变；原子替换+写后复验+失败回滚');
    }
    // 事件本体是宿主写出的成品 + 一行宿主自己函数产的收口行 → 跳过插件整形，靠读回校验兜底
    const res = SW.writeSessionLogSync(file, JSON.parse(headerLine), built.events, {
      skipShape: true,
      allowLiveHost: allowLive,
      reason: 'E-class fork-seed unclosed turn: insert host openTurnClosers(forked) closer',
      backupRoot: BACKUP,
    });
    log('    → apply 完成 ' + res.events + ' 事件 / ' + res.bytes + ' 字节 / 备份 ' + res.backup);
    const after = V.verifyFile(file);
    log('    → 落盘后复验 ' + (after.ok ? 'PASS events=' + after.events : 'FAIL ' + after.err));
    if (!after.ok) {
      log('    !! 复验不过，从备份逐字节回滚');
      fs.copyFileSync(res.backup, file);
      log('    → 回滚后 ' + (V.verifyFile(file).ok ? 'PASS（异常：原件本该是 FAIL）' : '仍是原来的 FAIL = 已恢复原状'));
      refused++;
      continue;
    }
    const pc = path.join(PROJCACHE, id + '.json');
    if (host.alive) {
      log('    → projcache 不动（宿主退出时会把内存旧值整写回来，在线摘等于白摘）：' + pc);
    } else if (fs.existsSync(pc)) {
      const bk = path.join(BACKUP, 'projcache', id + '.json');
      fs.mkdirSync(path.dirname(bk), { recursive: true });
      fs.copyFileSync(pc, bk);
      fs.renameSync(pc, pc + '.removed-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));
      log('    → projcache 已摘除（备份 ' + bk + '）');
    }
    touched++;
  }
  log('\n模式=' + mode + ' 修好=' + touched + ' 已健康=' + healthy + ' 别的病型=' + otherClass + ' 未写=' + refused);
  log('宿主状态 ' + JSON.stringify(SW.hostAlive()));
  log('RESULT=' + (mode === 'dry' ? 'DRY' : touched > 0 ? 'APPLIED' : refused > 0 ? 'NOT_APPLIED' : 'NO_TARGET'));
  if (mode === 'apply' && touched === 0) process.exit(2);
}

main();
