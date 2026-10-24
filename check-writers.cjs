// 静态护栏：找出"绕过闸门直接写会话日志"的脚本。
//
// 判据（三个条件同时成立才算违规）：
//   1. 有写盘动词：writeFileSync / renameSync / cpSync
//   2. 写盘目标**就是会话日志**：附近出现 session.vN.jsonl 变量作写入参数，
//      **或**自己拼 zstd 帧（encodeFrames / encodeTwoFrames / zstdCompressSync /
//      compressZstdFrame）再写出去
//   3. 没有走闸门（safe-write 的任一入口：writeSessionLog / writeSessionLogSync / commitBuffer）
//
// 注意：只是**读**日志（把 session.v4.jsonl.zstd 拼进路径去 readFileSync）、
// 然后写自己的分析结果 JSON 的脚本不算违规——那类写法早期版本会误报
// （本机 analyze-workspace-loss.mjs、apply-v2.mjs 就是被这样误伤的）。
// 只写 workspace.json（注册表）、imports.json（导入登记）或 session-query.db
// （全文索引）的同样不算，它们不产生会话日志。
const fs = require('node:fs');
const path = require('node:path');

// 默认扫描目录：脚本自己所在目录（这样复制到技能 scripts/ 下也能直接跑）；
// 用 DSH_FIX_ROOT 覆盖，或用第一个非 -- 参数指定别的根。
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ROOT =
  positional[0] || process.env.DSH_FIX_ROOT || path.dirname(fs.realpathSync(__filename));
const quiet = process.argv.includes('--quiet');

const WRITE_CALL = /\b(writeFileSync|renameSync|cpSync)\s*\(([^\n]*)/g;
const FRAME_ENC = /encodeFrames|encodeTwoFrames|zstdCompressSync|compressZstdFrame|createZstdCompress/;
const LOG_VAR = /session\.v\d+\.jsonl|LOG\b|logPath|r\.file|t\.file/;
const LOG_NAME = /session\.v\d+\.jsonl/;
const GATE = /safe-write|writeSessionLog|commitBuffer/;

// 判断"这个写盘调用的目标是不是日志文件"
function writesLogFile(source) {
  let m;
  WRITE_CALL.lastIndex = 0;
  const hits = [];
  while ((m = WRITE_CALL.exec(source)) !== null) {
    const args = m[2] || '';
    // 目标参数里直接出现日志文件名，或用的是日志路径变量
    if (LOG_NAME.test(args) || /\b(r|t)\.file\b/.test(args) || /\blogPath\b|\bLOG\b|\bdir\b.*session/.test(args)) {
      hits.push(m[0].trim());
    }
  }
  return hits;
}

const files = fs
  .readdirSync(ROOT)
  .filter((f) => /\.(mjs|cjs)$/.test(f) && !f.startsWith('check-writers'))
  .map((f) => path.join(ROOT, f));

const offenders = [];
const gated = [];

for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  // 先判闸门：迁移后的脚本已经没有 writeFileSync 了，只有 commitBuffer，
  // 若先按"有没有写盘动词"过滤，这类正确的脚本会被漏掉（护栏自己就漏了 8 个）。
  const touchesLog = LOG_NAME.test(s) || FRAME_ENC.test(s);
  if (!touchesLog) continue;
  if (GATE.test(s)) {
    gated.push(path.basename(f));
    continue;
  }
  if (!/\b(writeFileSync|renameSync|cpSync)\s*\(/.test(s)) continue;
  const direct = writesLogFile(s);
  // 自己拼帧再写出去的也算（写法是 writeFileSync(tmp, encodeFrames(...))）
  const encodesFrames = FRAME_ENC.test(s) && /writeFileSync\s*\(/.test(s);
  if (!direct.length && !encodesFrames) continue;
  offenders.push({
    name: path.basename(f),
    lines: (direct.length ? direct : ['自己拼 zstd 帧后写盘']).slice(0, 4),
  });
}

if (!quiet) {
  console.log(`扫描 ${files.length} 个脚本（根：${ROOT}）`);
  console.log(`\n已接闸门（安全）：${gated.length} 个 → ${gated.join(', ') || '无'}`);
  console.log(`\n绕过闸门直写会话日志（违规）：${offenders.length} 个`);
  for (const o of offenders) {
    console.log(`  ✗ ${o.name}`);
    for (const line of o.lines) console.log(`       ${line}`);
  }
  if (offenders.length) {
    console.log('\n修法：把最后那步 writeFileSync(tmp)+renameSync(tmp,file) 换成');
    console.log("      require('./lib/safe-write.cjs').commitBuffer(file, buf, { reason: '...' })");
    console.log('      —— 一行接入，即可拿到"宿主存活拒写 + 真实读盘链读回 + 备份 + 审计"。');
  }
}

if (offenders.length) {
  if (quiet) {
    console.error(
      `check-writers: ${offenders.length} 个脚本绕过 safe-write 直写会话日志 → ` +
        offenders.map((o) => o.name).join(', '),
    );
  }
  process.exit(1);
}
process.exit(0);
