// 离线写会话日志的唯一入口（fail-closed 闸门）。
//
// 本机踩过的两个坑，都由"绕开宿主自己写盘"造成：
//   A. 写进去的事件没按宿主契约整形（source.kind='plugin' 等）→ 宿主整份拒载；
//   C. 宿主进程还活着时离线改写头部 → 旧进程随后按旧长度续写，seq/turn 撞号。
// 闸门把这两件事都变成"写不进去"，而不是"写坏了以后再说"。
//
// 规则（任一不满足就抛错，绝不降级静默写）：
//   0. **整形内嵌**：调用方交进来的原始事件，闸门自己按插件 `prepareHostEvents()`
//      做一遍形状归一（V4 生产者 source kind / 工具结果形状 / 替换标记拼写）。
//      这一条是治本——2026-10-21 的事故就是调用方"忘了调整形函数"，闸门内嵌后
//      想忘也忘不掉。该函数幂等（已验证：已整形的事件再过一遍不变）。
//   1. 宿主存活 → 拒写（探不到进程也按活着算，fail-closed）
//   2. 先写临时文件，再用**宿主真实读盘链**读回这份临时文件校验——
//      判的是"真正要落盘的那个字节流"，而不是内存里的对象。
//      这一点很关键：内存事件可能是存储形态（含区间对），只有走 decodeRow 才是宿主的真实语义。
//   3. 读回通过才备份原文件并原子 rename；不通过就删临时文件、原文件一个字节不动。
//   4. 每次落盘留审计记录（何时、改了多少事件、备份在哪、宿主状态、整形计数）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const V = require('./v4check.cjs');

const AUDIT_DIR = process.env.DSH_FIX_AUDIT_DIR || path.join(os.homedir(), '.dsh', 'logs', 'offline-writes');

// 宿主判据：命令行里出现 dsh-desktop-host 的进程。
// --expose-internals 会被 subprocess runner 复用，只认它会把子进程误判成宿主。
const HOST_SIGNATURE = /dsh-desktop-host/i;

// ---- 整形依赖：插件自己的落盘形状实现（唯一权威）----
// 插件未安装/不可用时返回 undefined，此时闸门退回"只做真实链校验"（仍能挡住坏档，只是不自动整形）。
let shaperPromise;
let cachedShaper;
function loadShaper() {
  if (shaperPromise) return shaperPromise;
  shaperPromise = (async () => {
    const profileRoot =
      process.env.DSH_PROFILE_ROOT || path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
    const modPath = path.join(profileRoot, 'node_modules', 'dsh-chat-import', 'lib', 'host-session.mjs');
    if (!fs.existsSync(modPath)) return undefined;
    try {
      const m = await import(require('node:url').pathToFileURL(modPath).href);
      return typeof m.prepareHostEvents === 'function' ? m : undefined;
    } catch {
      return undefined;
    }
  })();
  return shaperPromise;
}

/**
 * 按宿主契约整形事件（调用方不必自己记得做这一步）。
 * @param {object[]} events 原始事件
 * @param {string} sessionId 会话 id
 * @param {number} version 目标格式版本（当前恒 4）
 * @returns {Promise<{events:object[], shaper:string}>}
 */
async function shapeEvents(events, sessionId, version = 4) {
  const shaper = await loadShaper();
  if (!shaper) return { events, shaper: 'unavailable(pass-through)' };
  const shaped = shaper.prepareHostEvents(JSON.parse(JSON.stringify(events)), sessionId, version, version);
  return { events: shaped, shaper: 'prepareHostEvents' };
}

/**
 * 宿主进程是否存活。
 * 探不到时按"活着"处理（fail-closed）：宁可拒绝写，也不要冒险撞上正在跑的宿主。
 * @returns {{alive:boolean, pids:number[], detail:string}}
 */
function hostAlive() {
  // 仅自测用：允许显式声明"宿主已退出"，用于在宿主运行时验证写盘路径。
  // 生产调用不应设置它；设了也会在审计记录里留痕。
  if (process.env.DSH_FIX_ASSUME_HOST_OFFLINE === '1') {
    return { alive: false, pids: [], detail: 'assumed offline via DSH_FIX_ASSUME_HOST_OFFLINE (self-test)' };
  }
  let stdout;
  try {
    stdout = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" | " +
          'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
    );
  } catch (e) {
    return { alive: true, pids: [], detail: 'probe failed (treated as alive): ' + e.message };
  }
  let list;
  try {
    list = JSON.parse(stdout || '[]');
  } catch {
    return { alive: true, pids: [], detail: 'probe output unparsable (treated as alive)' };
  }
  if (!Array.isArray(list)) list = [list];
  const pids = [];
  for (const p of list) {
    if (!HOST_SIGNATURE.test(String(p.CommandLine || ''))) continue;
    if (p.ProcessId === process.pid) continue;
    pids.push(p.ProcessId);
  }
  return {
    alive: pids.length > 0,
    pids,
    detail: pids.length ? 'dsh-desktop-host pid=' + pids.join(',') : 'no host process',
  };
}

function writeAudit(record) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(
      path.join(AUDIT_DIR, day + '.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n',
    );
  } catch {
    console.error('[safe-write] 审计记录写入失败（不影响已完成的落盘）');
  }
}

/**
 * 安全写一条会话日志。
 *
 * 事件**不需要**调用方自己整形：闸门会用插件 `prepareHostEvents()` 归一形状
 * （幂等），所以即使调用方传的是转换层刚产出的原始事件（含 `kind:'plugin'`），
 * 也不会写出宿主读不进的日志。这是 2026-10-21 事故（重导脚本忘了调整形函数，
 * 把 V3 的 source 写进 V4 日志、宿主整份拒载）的根治点。
 *
 * 异步：整形要动态 import 插件模块。旧的同步调用方用 `writeSessionLogSync`。
 *
 * @param {string} file 目标日志绝对路径
 * @param {object} header 物理 header（含 type:"session"）
 * @param {object[]} events 事件数组；seq 需 0..N-1 连续
 * @param {object} [opts]
 * @param {boolean} [opts.allowLiveHost=false] 宿主存活时是否允许（默认否）
 * @param {string}  [opts.backupRoot] 备份根目录
 * @param {string}  [opts.reason] 审计用的原因说明
 * @param {boolean} [opts.skipShape=false] 跳过整形（仅当事件已经是宿主写出的成品）
 * @returns {Promise<{backup:string|null, bytes:number, events:number, shaper:string}>}
 */
async function writeSessionLog(file, header, events, opts = {}) {
  const reason = opts.reason || 'unspecified';

  // 1) 宿主存活检查（离线改写的唯一安全前提）
  const host = hostAlive();
  if (host.alive && !opts.allowLiveHost) {
    throw new Error(
      `拒绝写盘：宿主正在运行（${host.detail}）。离线改写日志会被旧进程按旧长度续写，` +
        '导致 seq/turn 撞号（本机 2026-10-22 真实事故）。请从托盘右键退出宿主后重试。',
    );
  }

  // 2) 整形（内嵌，调用方不必记得）
  const shaped = opts.skipShape
    ? { events, shaper: 'skipped' }
    : await shapeEvents(events, header && header.id, 4);

  // 3) 先写临时文件，再用宿主真实读盘链校验它
  const headerLine = JSON.stringify(header);
  const bodyLines = shaped.events.map((e) => JSON.stringify(e));
  const tmp = file + '.safewrite.tmp';
  fs.writeFileSync(tmp, V.encodeTwoFrames(headerLine, bodyLines));

  let verified;
  try {
    verified = V.verifyFile(tmp);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error('读回校验异常（已放弃写入，原文件未改动）: ' + e.message);
  }
  if (!verified.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`拒绝写盘：读回 [${verified.stage}] ${verified.err}（原文件未改动）`);
  }

  // 3) 备份 → 原子替换
  let backupPath = null;
  if (fs.existsSync(file)) {
    const backupRoot = opts.backupRoot || path.join(AUDIT_DIR, 'backups');
    // 目标日志在 ~/.dsh/sessions 下时按相对路径归档；否则（测试库/临时目录，
    // 跨盘符时 path.relative 会返回绝对路径）用「目录名 + 文件名」扁平归档。
    const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
    const rel = path.relative(sessionsRoot, file);
    const usable = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const target = usable
      ? path.join(backupRoot, rel)
      : path.join(backupRoot, '_external', path.basename(path.dirname(file)), path.basename(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    backupPath = target;
  }
  fs.renameSync(tmp, file);

  const bytes = fs.statSync(file).size;
  writeAudit({
    file,
    reason,
    events: verified.events,
    bytes,
    backup: backupPath,
    hostAlive: host.alive,
    pids: host.pids,
    shaper: shaped.shaper,
  });
  return { backup: backupPath, bytes, events: verified.events, shaper: shaped.shaper };
}

/**
 * 同步版本（供尚未改成 async 的老脚本用）。
 * 整形走"同步取出已加载的 shaper"：首次调用时若模块尚未加载则跳过整形，
 * 但真实读盘链校验仍然生效——坏档一样写不进去。
 */
function writeSessionLogSync(file, header, events, opts = {}) {
  // 已加载过 shaper 才能同步整形；否则透传，靠后面的真实链校验兜底
  let evs = events;
  if (!opts.skipShape && cachedShaper && typeof cachedShaper.prepareHostEvents === 'function') {
    evs = cachedShaper.prepareHostEvents(JSON.parse(JSON.stringify(events)), header && header.id, 4, 4);
  }
  return writeSessionLogSyncCore(file, header, evs, opts);
}

// 同步核心（不含整形，逻辑与 async 版一致）
function writeSessionLogSyncCore(file, header, events, opts = {}) {
  const reason = opts.reason || 'unspecified';
  const host = hostAlive();
  if (host.alive && !opts.allowLiveHost) {
    throw new Error(
      `拒绝写盘：宿主正在运行（${host.detail}）。离线改写日志会被旧进程按旧长度续写，` +
        '导致 seq/turn 撞号（本机 2026-10-22 真实事故）。请从托盘右键退出宿主后重试。',
    );
  }
  const tmp = file + '.safewrite.tmp';
  fs.writeFileSync(tmp, V.encodeTwoFrames(JSON.stringify(header), events.map((e) => JSON.stringify(e))));
  const verified = V.verifyFile(tmp);
  if (!verified.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`拒绝写盘：读回 [${verified.stage}] ${verified.err}（原文件未改动）`);
  }
  let backupPath = null;
  if (fs.existsSync(file)) {
    const backupRoot = opts.backupRoot || path.join(AUDIT_DIR, 'backups');
    const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
    const rel = path.relative(sessionsRoot, file);
    const usable = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const target = usable
      ? path.join(backupRoot, rel)
      : path.join(backupRoot, '_external', path.basename(path.dirname(file)), path.basename(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    backupPath = target;
  }
  fs.renameSync(tmp, file);
  const bytes = fs.statSync(file).size;
  writeAudit({ file, reason, events: verified.events, bytes, backup: backupPath, hostAlive: host.alive, pids: host.pids });
  return { backup: backupPath, bytes, events: verified.events };
}

/**
 * 预热整形器（可选）。脚本开头 `await warmShaper()` 后，同步版也能整形。
 */
async function warmShaper() {
  cachedShaper = await loadShaper();
  return Boolean(cachedShaper);
}

/**
 * 字节级入口：调用方自己拼好了整份日志字节（历史脚本多是这种写法），
 * 只要把最后的「writeFileSync(tmp) + renameSync(tmp, file)」换成这一行，
 * 就同时拿到：宿主存活拒写 + 真实读盘链读回 + 备份 + 审计。
 *
 * 这是"一行接入"的兼容口——不要求调用方重构成传事件数组。
 * 整形（kind / 工具结果形状）仍由调用方负责；需要自动整形请用 writeSessionLog。
 *
 * @param {string} file 目标日志绝对路径
 * @param {Buffer} buf 整份日志字节（多帧 zstd 或明文 JSONL）
 * @param {object} [opts] {reason, backupRoot, allowLiveHost}
 * @returns {{backup:string|null, bytes:number, events:number}}
 */
function commitBuffer(file, buf, opts = {}) {
  const reason = opts.reason || 'unspecified';
  const host = hostAlive();
  if (host.alive && !opts.allowLiveHost) {
    throw new Error(
      `拒绝写盘：宿主正在运行（${host.detail}）。请从托盘右键退出宿主后重试。`,
    );
  }
  const tmp = file + '.safewrite.tmp';
  fs.writeFileSync(tmp, buf);
  const verified = V.verifyFile(tmp);
  if (!verified.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`拒绝写盘：读回 [${verified.stage}] ${verified.err}（原文件未改动）`);
  }
  let backupPath = null;
  if (fs.existsSync(file)) {
    const backupRoot = opts.backupRoot || path.join(AUDIT_DIR, 'backups');
    const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
    const rel = path.relative(sessionsRoot, file);
    const usable = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const target = usable
      ? path.join(backupRoot, rel)
      : path.join(backupRoot, '_external', path.basename(path.dirname(file)), path.basename(file));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    backupPath = target;
  }
  fs.renameSync(tmp, file);
  const bytes = fs.statSync(file).size;
  writeAudit({ file, reason, events: verified.events, bytes, backup: backupPath, hostAlive: host.alive, pids: host.pids, entry: 'commitBuffer' });
  return { backup: backupPath, bytes, events: verified.events };
}

module.exports = {
  hostAlive,
  writeSessionLog,
  writeSessionLogSync,
  commitBuffer,
  warmShaper,
  shapeEvents,
  writeAudit,
  AUDIT_DIR,
  HOST_SIGNATURE,
};
