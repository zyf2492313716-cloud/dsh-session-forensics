// fix-head.mjs —— 修「protected first surface head」类坏档
//
// 病灶：surface 投影里没有头 system/message（导入会话被 bundle 还原时丢了），
// 用户续聊时宿主在**投影中途**写了一条 system/message，冷读被自己的迁移器拒。
//
// 修法（最小改动，与 121 个健康导入会话同形）：
//   1) 在首个 step/start 之后插一条空头 system/message（content:[]、kind:system-prompt，
//      与插件 convert/events.mjs 的 pushSystemHead 同形）；
//   2) 摘掉所有「不在投影头部」的 system/message；
//   3) 后续指向被摘事件的 surfaceOp.replace 改指向新头（语义不变：宿主替换头）；
//   4) seq 重编号并重映射全部跨事件引用（surfaceOp / sourceEventSeqs / shadowedSeqs /
//      headerSeq / requestSeq / targetSeq / sourceSeq / data.targets[*].seq / sourceEventSeq）；
//   5) 用宿主真实读盘链（lib/v4check.cjs 六层）验 PASS 才允许落盘。
//
// 用法：
//   node fix-head.mjs dry  <sessionId> [outDir]   只生成候选 + 校验，不碰原文件
//   node fix-head.mjs apply <sessionId>           备份 → 原子替换 → 复验 → 摘 projcache
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const V = require(path.join(SKILL, 'lib', 'v4check.cjs'));
V.bootstrapElectron(); // 拿宿主自己的类当尺子

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const crypto = require('node:crypto');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');const SESSIONS = path.join(os.homedir(), '.dsh', 'sessions');
const PROJCACHE = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');

function findLog(sid) {
  for (const proj of fs.readdirSync(SESSIONS)) {
    const f = path.join(SESSIONS, proj, sid, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 宿主口径折叠 surface：返回头部 seq、每个 surface 事件是否落在头部位置 */
function fold(events) {
  const state = []; // 当前投影节点 seq（按出现顺序）
  let headSeq;      // 登记下来的 protected head
  const bad = [];   // 违反「head 必须是投影第一个节点」的 system/message
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue;
    const so = e.surfaceOp;
    const isAppend = so === undefined || so === 'append';
    if (e.type === 'system/message' && isAppend) {
      if (state.length === 0) {
        if (headSeq === undefined) headSeq = e.seq;
      } else {
        bad.push(e);
      }
    }
    if (isAppend) {
      state.push(e.seq);
    } else if (so && typeof so === 'object') {
      const a = so.startSeq, b = so.endSeq;
      for (let i = state.length - 1; i >= 0; i--) if (state[i] >= a && state[i] <= b) state.splice(i, 1);
      state.push(e.seq);
    }
  }
  return { headSeq, bad, surface: state };
}

function build(file, sid) {
  const stat0 = fs.statSync(file);
  const raw = fs.readFileSync(file);
  const frames = V.decodeFrames(raw);
  const headerLine = frames[0].split('\n').filter(Boolean)[0];
  const loaded = V.loadSessionBuffer(raw); // 真实解码器：区间对已在 decodeRow 里展开
  const events = loaded.events.map((e) => JSON.parse(JSON.stringify(e)));
  const { headSeq, bad } = fold(events);

  const drop = new Set(bad.map((e) => e.seq));
  const kept = events.filter((e) => !drop.has(e.seq));

  // 插空头的位置：第一个 step/start 之后（与宿主/插件同口径）
  const firstStepIdx = kept.findIndex((e) => e.type === 'step/start');
  const step0 = firstStepIdx >= 0 ? kept[firstStepIdx] : null;
  const head = {
    type: 'system/message',
    seq: -1, // 占位，下面统一编号
    time: typeof step0?.time === 'number' ? step0.time : (typeof loaded.header.createdAt === 'number' ? loaded.header.createdAt : Date.now()),
    data: {
      turn: step0?.data?.turn ?? 1,
      step: step0?.data?.step ?? 1,
      message: {
        id: 'import:' + sid + ':sys',
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      },
    },
    surfaceOp: 'append',
  };
  const needHead = headSeq === undefined;
  const out = needHead ? [...kept.slice(0, firstStepIdx + 1), head, ...kept.slice(firstStepIdx + 1)] : kept;

  // 旧 seq → 新 seq（插入的那条自己不参与映射，位置就是 firstStepIdx+1）
  const map = new Map();
  let next = 0;
  const staged = out.map((e) => {
    const seq = next++;
    if (e.seq >= 0) map.set(e.seq, seq);
    return { ...e, seq };
  });
  const headNewSeq = needHead ? firstStepIdx + 1 : undefined;
  const solve = (s) => map.get(s);

  let refsFixed = 0, refsDropped = 0, refsToHead = 0;
  for (const n of staged) {
    const so = n.surfaceOp;
    if (so && typeof so === 'object') {
      const a = solve(so.startSeq), b = solve(so.endSeq);
      if (a !== undefined && b !== undefined) {
        n.surfaceOp = { ...so, startSeq: a, endSeq: b };
        refsFixed++;
      } else if (needHead && headNewSeq !== undefined && drop.size > 0
        && (drop.has(so.startSeq) || drop.has(so.endSeq))) {
        // 原来替换的是被摘掉的那条中途 system/message → 改指新头，语义不变
        n.surfaceOp = { ...so, startSeq: headNewSeq, endSeq: headNewSeq };
        refsToHead++;
      } else {
        n.surfaceOp = 'append';
        refsDropped++;
      }
    }
    if (Array.isArray(n.sourceEventSeqs)) {
      // 引用指向被摘掉的中途 system/message 时改指新头（替换锚点语义不变）；
      // 真悬空才丢。替换类事件的 sourceEventSeqs 必须是数组，全丢时留 []，不能删键。
      const m = [];
      for (const s of n.sourceEventSeqs) {
        if (drop.has(s) && headNewSeq !== undefined) { m.push(headNewSeq); refsToHead++; continue; }
        const v = solve(s);
        if (v === undefined) { refsDropped++; continue; }
        m.push(v);
      }
      const isReplacement = !!(n.surfaceOp && typeof n.surfaceOp === 'object');
      if (m.length || isReplacement) n.sourceEventSeqs = m; else delete n.sourceEventSeqs;
    }
    if (n.type === 'compaction/summary' && Array.isArray(n.data?.shadowedSeqs)) {
      // 宿主校验：surface.slice(index(shadowedRange.start), index(end)+1) 必须逐项等于
      // shadowedSeqs。所以 range 的两个端点必须跟着重编号，漏一个就整份拒载。
      if (n.data.shadowedRange && typeof n.data.shadowedRange === 'object') {
        const a = solve(n.data.shadowedRange.start), b = solve(n.data.shadowedRange.end);
        if (a !== undefined && b !== undefined) {
          n.data.shadowedRange = { ...n.data.shadowedRange, start: a, end: b };
          refsFixed++;
        } else refsDropped++;
      }
      const m = n.data.shadowedSeqs.map(solve).filter((x) => x !== undefined);
      refsDropped += n.data.shadowedSeqs.length - m.length;
      n.data.shadowedSeqs = m;
    }
    if (Array.isArray(n.data?.targets)) {
      const m = n.data.targets.map((t) => { const s = solve(t.seq); return s === undefined ? null : { ...t, seq: s }; }).filter(Boolean);
      refsDropped += n.data.targets.length - m.length;
      n.data.targets = m;
    }
    for (const k of ['headerSeq', 'requestSeq', 'targetSeq', 'sourceSeq', 'sourceEventSeq']) {
      if (typeof n.data?.[k] === 'number') {
        const s = solve(n.data[k]);
        if (s === undefined) { delete n.data[k]; refsDropped++; } else { n.data[k] = s; refsFixed++; }
      }
    }
  }

  const body = staged.map((e) => JSON.stringify(e));
  const buf = V.encodeTwoFrames(headerLine, body);
  return {
    buf, headerLine, events, staged, drop, needHead, headNewSeq,
    snapshot: { size: stat0.size, mtimeMs: stat0.mtimeMs, sha: sha256(raw) },
    stats: {
      before: events.length, after: staged.length, dropped: [...drop],
      insertedHeadAt: needHead ? firstStepIdx + 1 : null,
      refsFixed, refsDropped, refsToHead,
    },
  };
}

function verifyBuffer(buf, label) {
  try {
    const loaded = V.loadSessionBuffer(buf);
    return { err: V.verifyDecoded(loaded.header, loaded.events, loaded.inheritedEventCount, label), loaded };
  } catch (e) {
    return { err: 'decode: ' + e.message };
  }
}

// ── 正文逐条比对：证明只动了预期的东西 ───────────────────────────────
function texts(events) {
  const out = new Map();
  for (const e of events) {
    if (e.type !== 'user/message' && e.type !== 'assistant/message') continue;
    const c = e.data?.message?.content ?? e.data?.content;
    const s = typeof c === 'string' ? c : JSON.stringify(c);
    const key = e.type + '|' + (e.data?.message?.id || '') + '|' + (e.time || '') + '|' + s.slice(0, 200);
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}
function diffTexts(a, b) {
  let missing = 0;
  for (const [k, n] of a) if ((b.get(k) || 0) < n) missing++;
  return missing;
}

const mode = process.argv[2];
const sid = process.argv[3];
if (!mode || !sid) { console.error('用法: node fix-head.mjs dry|apply <sessionId> [outDir]'); process.exit(2); }
const file = findLog(sid);
if (!file) { console.error('找不到会话日志 ' + sid); process.exit(2); }

const before = V.verifyFile(file);
console.log('原档: ' + file);
console.log('  改前宿主读盘链: ' + (before.ok ? 'PASS events=' + before.events : 'FAIL ' + before.stage + ': ' + before.err));

const r = build(file, sid);
const t0 = texts(r.events), t1 = texts(r.staged);
console.log('  事件 ' + r.stats.before + ' → ' + r.stats.after + '；摘掉 system/message seq=' + JSON.stringify(r.stats.dropped) +
  '；插入空头位置=' + r.stats.insertedHeadAt + '（新 seq=' + r.headNewSeq + '）');
console.log('  引用重映射 ' + r.stats.refsFixed + ' 处、丢弃悬空 ' + r.stats.refsDropped + ' 处、改指新头 ' + r.stats.refsToHead + ' 处');
console.log('  正文条目 ' + t0.size + '，改后缺失 ' + diffTexts(t0, t1) + ' 条');

const outDir = process.argv[4] || path.join(os.tmpdir(), 'dsh-fix-head');
fs.mkdirSync(outDir, { recursive: true });
const cand = path.join(outDir, sid + '.fixed.zstd');
fs.writeFileSync(cand, r.buf);
const after = V.verifyFile(cand);
console.log('  候选文件: ' + cand);
console.log('  改后宿主读盘链: ' + (after.ok ? 'PASS events=' + after.events + ' frames=' + after.frames : 'FAIL ' + after.stage + ': ' + after.err));
if (!after.ok) { console.log('  候选未通过，拒绝落盘'); process.exit(1); }
if (diffTexts(t0, t1) !== 0) { console.log('  正文有缺失，拒绝落盘'); process.exit(1); }

if (mode === 'dry') { console.log('  dry 模式：未改动原文件'); process.exit(0); }
if (mode !== 'apply') { console.error('未知模式 ' + mode); process.exit(2); }

// 落盘一律走 safe-write 闸门（tmp + 真实读盘链读回 + 备份 + 原子 rename + 审计）。
// 宿主存活时默认拒写；本类坏档的特殊性：宿主**读不进这条会话**，内存里没有它的 agent，
// 没有人会按旧长度续写 → 允许显式 DSH_FIX_ALLOW_LIVE=1 走在线强写，但必须先过
// 「新鲜度守卫」：从读取到落盘这段时间里文件一个字节都没变，否则放弃（说明有 agent 在写）。
const SW = require(path.join(SKILL, 'lib', 'safe-write.cjs'));
const alive = SW.hostAlive();
const allowLive = process.env.DSH_FIX_ALLOW_LIVE === '1';
const assumeOffline = process.env.DSH_FIX_ASSUME_HOST_OFFLINE === '1';
if (alive.alive && !allowLive && !assumeOffline) {
  console.log('  宿主在运行（' + alive.detail + '）：闸门拒绝写盘。');
  console.log('  确认该会话宿主读不进（无 agent、不会续写）后，可设 DSH_FIX_ALLOW_LIVE=1 在线强写。');
  process.exit(3);
}

// 新鲜度守卫：build() 之后文件必须逐字节未变
const st = fs.statSync(file);
const nowSha = sha256(fs.readFileSync(file));
if (st.size !== r.snapshot.size || st.mtimeMs !== r.snapshot.mtimeMs || nowSha !== r.snapshot.sha) {
  console.log('  放弃落盘：读取之后文件又变了（size ' + r.snapshot.size + '→' + st.size +
    '，sha ' + (nowSha === r.snapshot.sha ? '同' : '不同') + '）——有进程在写这条会话，等它停下来再来。');
  process.exit(4);
}
console.log('  新鲜度守卫通过：' + st.size + ' 字节 / sha ' + nowSha.slice(0, 16) + '… 自读取后未变');

const bakDir = path.join('G:/文档/deepseek-harness/dsh-fix', 'backups', 'head-fix');
fs.mkdirSync(bakDir, { recursive: true });
let res;
try {
  res = SW.commitBuffer(file, r.buf, {
    allowLiveHost: true,
    backupRoot: bakDir,
    reason: 'fix-head: 补回 protected first surface head（seq=2 空头）+ 摘中途 system/message' +
      (allowLive && alive.alive ? '；在线强写（宿主存活但该会话读不进、无 agent）' : ''),
  });
} catch (e) {
  console.log('  闸门拒写：' + e.message + '（原文件未改动）');
  process.exit(1);
}
const bak = res.backup;
const finalCheck = V.verifyFile(file);
console.log('  落盘: ' + (finalCheck.ok ? 'PASS events=' + finalCheck.events : 'FAIL ' + finalCheck.err) +
  '；备份 ' + (bak ? path.relative(bakDir, bak) : '无'));
if (!finalCheck.ok) {
  // 逐字节回滚 + 复验
  fs.copyFileSync(bak, file);
  const back = V.verifyFile(file);
  const same = sha256(fs.readFileSync(file)) === r.snapshot.sha;
  console.log('  已回滚：sha 与改前' + (same ? '逐字节一致' : '不一致！') + '；回滚后读盘链 ' +
    (back.ok ? 'PASS' : 'FAIL ' + back.err));
  process.exit(1);
}
// projcache 只在宿主确认离线时摘：在线摘了也会被退出时的内存旧值写回来
if (alive.alive) {
  console.log('  projcache 未动（宿主存活，退出时会整写覆盖）；下次重启由宿主重建');
} else {
  const pc = path.join(PROJCACHE, sid + '.json');
  if (fs.existsSync(pc)) { fs.renameSync(pc, pc + '.stale-' + Date.now()); console.log('  已摘 projcache（宿主重建）'); }
}

