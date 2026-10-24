// 与宿主读盘同构的会话日志校验库（唯一可信的尺子）。
//
// 为什么不能"自己解帧 + 直接喂 assertReleasedV4Relationships"：
// 宿主读盘是 readStoredLog → readZstdPrefix → codec.createDecoder → 逐行
// decoder.decodeRow(...) → finish() → assertReleasedV4Relationships → validateStoredEvents。
// 其中 decodeRow 内部走 V2 物理解码，会调用 decodeSeqRanges 把存储形态的
// 区间对 [[a,b]] 展开成 [a,a+1,…,b]。跳过 decodeRow 直接校验原始行，会把
// 本来能正常读的日志误判成坏档（本机 2026-10-22 实测：8 个会话因此被误诊、
// 多改了一遍）。
//
// 因此：判"宿主能不能打开"必须走本模块 loadSession()，它逐行经过了真实解码器。
//
// 依赖宿主模块（app.asar 内），必须用 Electron 当 node 运行：
//   $env:ELECTRON_RUN_AS_NODE=1; & "<安装目录>\DeepSeek Harness.exe" <script>
// 本模块的 bootstrapElectron() 可以在普通 node 下自动换成 Electron 重跑。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ZSTD_MAGIC = 0xfd2fb528;

function resolveResources() {
  const candidates = [];
  if (process.env.DSH_APP_RESOURCES) candidates.push(process.env.DSH_APP_RESOURCES);
  // 各平台的默认安装位置（按本机与常见 Windows 布局推导，不写死用户名）
  candidates.push(
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources'),
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'DeepSeek Harness', 'resources'),
    '/Applications/DeepSeek Harness.app/Contents/Resources',
  );
  for (const res of candidates) {
    if (res && fs.existsSync(path.join(res, 'app.asar'))) return res;
  }
  return undefined;
}

function hostModulesReadable(resources) {
  // 普通 node 无法穿透 asar（asar 是文件不是目录），只有 Electron 打过 fs 补丁才能
  try {
    return fs.statSync(path.join(resources, 'app.asar', 'dsh', 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 在普通 node 下把当前脚本换成「Electron 当 node」重跑同一份参数。
 * 已经是 Electron-as-node 或宿主模块可读时直接返回，不产生子进程。
 * @param {string[]} argv 原始 process.argv（用于原样转发）
 */
function bootstrapElectron(argv = process.argv) {
  const resources = resolveResources();
  if (!resources) return; // 让后续 require 抛清晰错误
  if (process.versions.electron || hostModulesReadable(resources)) return;
  const exe = path.join(path.dirname(resources), 'DeepSeek Harness.exe');
  if (!fs.existsSync(exe)) return;
  const child = spawnSync(exe, argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  process.exit(child.status === null ? 1 : child.status);
}

function loadHost() {
  const resources = resolveResources();
  if (!resources) {
    throw new Error('找不到 DSH 安装目录；用 DSH_APP_RESOURCES 指定 <安装目录>\\resources');
  }
  const mods = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
  const v4 = require(path.join(mods, 'dsh-session-format-v3-to-v4', 'lib', 'index.js'));
  const persistence = require(path.join(mods, 'dsh-session-persistence', 'lib', 'index.js'));
  const session = require(path.join(mods, 'dsh-session', 'lib', 'index.js'));
  return {
    resources,
    mods,
    v4,
    validateStoredEvents: persistence.validateStoredEvents,
    KNOWN_SESSION_EVENT_TYPES: session.KNOWN_SESSION_EVENT_TYPES,
    Session: session.Session,
    codec: v4.releasedV4SessionFormatCodec,
  };
}

let HOST_CACHE;
function host() {
  if (!HOST_CACHE) HOST_CACHE = loadHost();
  return HOST_CACHE;
}

/** 多帧 zstd：逐帧解压（单次 zstdDecompressSync 只解第一帧）。 */
function decodeFrames(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) starts.push(i);
  }
  if (!starts.length || starts[0] !== 0) throw new Error('no zstd magic at offset 0');
  const frames = [];
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    frames.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'));
  }
  return frames;
}

/** 写盘形态：帧1 恰好一行 header，正文另起一帧，带 checksum。 */
function encodeTwoFrames(headerLine, bodyLines) {
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  const f1 = zlib.zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), opts);
  const f2 = zlib.zstdCompressSync(Buffer.from(bodyLines.join('\n') + '\n', 'utf8'), opts);
  return Buffer.concat([f1, f2]);
}

/**
 * 按宿主读盘链加载一条日志。
 * @returns {{header:object, events:object[], inheritedEventCount:number, frames:number, headerLine:string}}
 * @throws 解码/准入失败时抛错（错误信息即宿主会报的那一层）
 */
function loadSessionBuffer(buf) {
  const h = host();
  const frames = decodeFrames(buf);
  const headLines = frames[0].split('\n').filter(Boolean);
  if (headLines.length !== 1) throw new Error(`header frame has ${headLines.length} lines (must be exactly 1)`);
  const headerLine = headLines[0];
  const all = frames.join('').split('\n').filter(Boolean);
  if (all[0] !== headerLine) throw new Error('header line is not at the file head');

  const physical = JSON.parse(headerLine);
  const decoder = h.codec.createDecoder(physical, {});
  const events = [];
  const context = { emitRun: () => {}, emitEvent: (e) => events.push(e) };
  for (let i = 1; i < all.length; i++) {
    let row;
    try {
      row = JSON.parse(all[i]);
    } catch (e) {
      throw new Error(`line ${i}: unparsable JSON: ${e.message}`);
    }
    try {
      decoder.decodeRow(row, context);
    } catch (e) {
      throw new Error(`decodeRow line ${i}: ${e.message}`);
    }
  }
  const inheritedEventCount = decoder.finish({}) || 0;
  const header = { ...decoder.header };
  delete header.type;
  return { header, events, inheritedEventCount, frames: frames.length, headerLine };
}

function loadSessionFile(file) {
  return loadSessionBuffer(fs.readFileSync(file));
}

/**
 * 在已解码事件上跑宿主的关系校验与落盘校验（decodeRow 之后的第二、三道）。
 * @returns {null|string} 通过返回 null，否则返回宿主会报的错误信息
 */
function verifyDecoded(header, events, inheritedEventCount, fileLabel = '(memory)') {
  const h = host();
  try {
    h.v4.assertReleasedV4Header(header);
  } catch (e) {
    return 'header: ' + e.message;
  }
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq !== i) return `seq not dense at index ${i} (seq=${events[i].seq}, ${events[i].type})`;
    try {
      h.v4.assertV4RowAdmission(events[i], h.KNOWN_SESSION_EVENT_TYPES);
    } catch (e) {
      return `row ${i}: ` + e.message;
    }
  }
  try {
    h.v4.assertReleasedV4Relationships(
      { header, events, inheritedEventCount },
      h.KNOWN_SESSION_EVENT_TYPES,
    );
  } catch (e) {
    return 'relationships: ' + e.message;
  }
  try {
    h.validateStoredEvents(header, events, { kind: 'jsonl', path: fileLabel });
  } catch (e) {
    return 'stored: ' + e.message;
  }
  // 第五层：宿主真会跑的 surface 折叠 + 消息投影（Session.fromRestore）。
  // 只查前四层不够——surface 折叠会校验 replace 端点、遮蔽范围、protected head，
  // 这些是"能不能打开并正确渲染"的关键，本机曾在别处漏过。
  try {
    h.Session.fromRestore(
      header.id,
      events,
      header,
      inheritedEventCount,
      'detached',
      currentProjections(),
    );
  } catch (e) {
    return 'fromRestore: ' + e.message;
  }
  // 第六层：assistant 内嵌流回放（宿主 detached 恢复时也会做）
  const streamErr = replayAssistantStreams(events);
  if (streamErr) return streamErr;
  return null;
}

/** 宿主的当前消息投影表（懒加载；取不到时退回空数组，仍做 surface 折叠）。 */
let PROJECTIONS;
function currentProjections() {
  if (PROJECTIONS) return PROJECTIONS;
  try {
    const p = require(
      path.join(
        host().mods,
        'dsh-session-format-catalog',
        'lib',
        'types',
        'message-projections.js',
      ),
    );
    PROJECTIONS = p.currentSessionMessageProjections || [];
  } catch {
    PROJECTIONS = [];
  }
  return PROJECTIONS;
}

/**
 * 回放 assistant/message 内嵌的流，核对 content / usage / replayState 是否与流一致。
 * 宿主 detached 恢复会做这一步，不一致等于"读得进但渲染/续写会坏"。
 * @returns {null|string}
 */
function replayAssistantStreams(events) {
  const h = host();
  let BlockAssembler;
  let expandAssistantStream;
  try {
    const llm = require(path.join(h.mods, 'dsh-llm', 'lib', 'index.js'));
    BlockAssembler = llm.BlockAssembler;
    expandAssistantStream = llm.expandAssistantStream;
  } catch {
    return null; // 拿不到就跳过（不虚报失败）
  }
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev.type !== 'assistant/message' && ev.type !== 'assistant/attempt') continue;
    const as = new BlockAssembler();
    let timed;
    try {
      timed = expandAssistantStream(ev.data.stream);
      for (const m of timed) as.push(m.chunk);
    } catch (e) {
      return `seed ${ev.type} at index ${i} has an invalid embedded stream: ${e.message}`;
    }
    if (ev.type === 'assistant/attempt' || timed.length === 0) continue;
    const content = ev.data.interrupted === true ? as.interruptedBlocks() : as.blocks();
    if (!eq(ev.data.message && ev.data.message.content, content)) {
      return `seed assistant/message at index ${i} content disagrees with its embedded stream`;
    }
    if (!eq(ev.data.usage, as.usage)) {
      return `seed assistant/message at index ${i} usage disagrees with its embedded stream`;
    }
    if (!eq(ev.data.message && ev.data.message.source && ev.data.message.source.replayState, as.replayState)) {
      return `seed assistant/message at index ${i} replay state disagrees with its embedded stream`;
    }
  }
  return null;
}

/**
 * 端到端判定一个文件宿主能否打开。
 * @returns {{ok:true, events:number, frames:number}|{ok:false, err:string, stage:string}}
 */
function verifyFile(file) {
  let loaded;
  try {
    loaded = loadSessionFile(file);
  } catch (e) {
    return { ok: false, err: e.message, stage: 'decode' };
  }
  const err = verifyDecoded(loaded.header, loaded.events, loaded.inheritedEventCount, file);
  if (err) return { ok: false, err, stage: 'validate' };
  return { ok: true, events: loaded.events.length, frames: loaded.frames };
}

/** 枚举 ~/.dsh/sessions 下全部日志。 */
function listSessionLogs(sessionsRoot) {
  const out = [];
  for (const proj of fs.readdirSync(sessionsRoot)) {
    const base = path.join(sessionsRoot, proj);
    let st;
    try {
      st = fs.statSync(base);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const id of fs.readdirSync(base)) {
      const f = path.join(base, id, 'session.v4.jsonl.zstd');
      if (fs.existsSync(f)) out.push({ project: proj, id, file: f });
    }
  }
  return out;
}

module.exports = {
  ZSTD_MAGIC,
  bootstrapElectron,
  host,
  decodeFrames,
  encodeTwoFrames,
  loadSessionBuffer,
  loadSessionFile,
  verifyDecoded,
  verifyFile,
  listSessionLogs,
  resolveResources,
};

// 在普通 node 下被 require 时自动换成 Electron 重跑，避免调用方漏调 bootstrap 直接崩。
// 只有确实跑在普通 node、且宿主模块不可读时才触发，Electron-as-node 下是无操作。
if (require.main !== module) {
  // 被 require：只在"拿不到宿主模块"时才需要重跑，用一个惰性探测避免无谓开销
  const res = resolveResources();
  if (res && !process.versions.electron && !hostModulesReadable(res)) {
    bootstrapElectron();
  }
}
