// 把「无 cwd 的 branch 子会话残骸」挪出宿主扫描范围（不删除，可整批回滚）。
//
// 为什么它们必须被挪走：宿主读取历史的唯一入口 sourceFor() 对 header.cwd===undefined
// 直接抛 session/not-found（dsh-api-session-controller/lib/index.js 约 1638-1640 行），
// 所以这类会话日志再健康也打不开；而它们在侧栏里与父会话同名，就是"重复会话/空会话"。
// 产出方是自动复盘的 branch 模式（@lmzhen/dsh-evolution-review 建会话时 meta 漏了 cwd）。
//
// 判据（三条同时成立才动，任一不满足就跳过）：
//   1. header.parentSession 存在（是子会话）
//   2. header.cwd === undefined（点开必报 not-found）
//   3. 日志在 ~/.dsh/sessions/<project>/<id>/ 下
// 动作：整目录 move 到 ~/.dsh/logs/review-ghost-archive/<stamp>/，projcache 行改名留档，
//       写 manifest.json + rollback.ps1，逐条记 sha256 与"原位消失/归档在位/字节一致"三条证明。
//
// 用法：node cleanup-ghost.cjs dry|apply   （DSH_SESSIONS / DSH_PROJCACHE_DIR 可指向隔离根）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const V = require(path.join(__dirname, 'lib', 'v4check.cjs'));
V.bootstrapElectron();

const MODE = process.argv[2] === 'apply' ? 'apply' : 'dry';
const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const PC = process.env.DSH_PROJCACHE_DIR ||
  path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
const ARCHIVE_ROOT = process.env.DSH_GHOST_ARCHIVE_DIR ||
  path.join(os.homedir(), '.dsh', 'logs', 'review-ghost-archive');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const ARCHIVE = path.join(ARCHIVE_ROOT, STAMP);
// 年龄闸：刚被写过的日志一律不动。宿主对正在跑的会话可能持有写句柄，同卷 rename 保留 inode，
// 结果就是"归档后它继续往归档那份写"——不丢数据，但归档件在被追加、语义已经乱了。
// 本机 2026-10-30 实测踩过：13:38 刚建的复盘子会话被 13:40 归档（原位没被重建，父会话完好）。
const MIN_AGE_MIN = Number(process.env.DSH_GHOST_MIN_AGE_MIN || 10);

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** 只判不改：返回符合三条判据**且**已静置够久的会话；skipped 是被年龄闸挡下的。 */
function scan(projectsRoot) {
  const found = [];
  const skipped = [];
  const now = Date.now();
  for (const l of V.listSessionLogs(projectsRoot || SESSIONS)) {
    let head;
    try { head = JSON.parse(V.decodeFrames(fs.readFileSync(l.file))[0].split('\n')[0]); } catch { continue; }
    if (!head.parentSession) continue;
    if (head.cwd !== undefined) continue;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(l.file).mtimeMs; } catch { continue; }
    const ageMin = (now - mtimeMs) / 60000;
    if (ageMin < MIN_AGE_MIN) { skipped.push({ ...l, head, ageMin }); continue; }
    found.push({ ...l, head });
  }
  return { found, skipped };
}

function main() {
  const { found: targets, skipped } = scan();
  const lines = [];
  const L = (s) => { lines.push(s); console.log(s); };
  L('=== 无 cwd 的 branch 子会话残骸 ' + targets.length + ' 条可归档（年龄闸 ≥' + MIN_AGE_MIN + ' 分钟）  模式=' + MODE);
  for (const s of skipped) L('  跳过（还在被写，' + s.ageMin.toFixed(1) + ' 分钟前动过）: ' + s.project + '\\' + s.id);
  const manifest = { stamp: STAMP, mode: MODE, source: SESSIONS, items: [] };

  for (const t of targets) {
    const dir = path.dirname(t.file);
    const bytes = fs.statSync(t.file).size;
    const digest = sha(t.file);
    L('  ' + t.project + '\\' + t.id + '  建于 ' + new Date(t.head.createdAt).toLocaleString('zh-CN') +
      '  ' + bytes + ' 字节  sha256=' + digest.slice(0, 16) + '  父=' + t.head.parentSession);
    manifest.items.push({
      id: t.id, project: t.project, from: dir, to: path.join(ARCHIVE, t.id),
      bytes, sha256: digest, parentSession: t.head.parentSession, createdAt: t.head.createdAt,
    });
    if (MODE !== 'apply') continue;
    fs.mkdirSync(ARCHIVE, { recursive: true });
    fs.renameSync(dir, path.join(ARCHIVE, t.id));
    const pc = path.join(PC, t.id + '.json');
    if (fs.existsSync(pc)) {
      fs.mkdirSync(path.join(ARCHIVE, '_projcache'), { recursive: true });
      fs.renameSync(pc, path.join(ARCHIVE, '_projcache', t.id + '.json'));
    }
  }

  if (MODE === 'apply' && targets.length) {
    const proofs = manifest.items.map((it) => {
      const moved = !fs.existsSync(it.from);
      const there = fs.existsSync(path.join(it.to, 'session.v4.jsonl.zstd'));
      const same = there && fs.statSync(path.join(it.to, 'session.v4.jsonl.zstd')).size === it.bytes;
      return { id: it.id, 原位消失: moved, 归档在位: there, 字节一致: same };
    });
    manifest.proofs = proofs;
    const allOk = proofs.every((p) => p.原位消失 && p.归档在位 && p.字节一致);
    fs.writeFileSync(path.join(ARCHIVE, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const rb = [
      '# 回滚：把本批归档的残骸原样放回 sessions 与 projcache',
      '$ErrorActionPreference = "Stop"',
      'New-Item -ItemType Directory -Force -Path "' + SESSIONS + '" | Out-Null',
      'New-Item -ItemType Directory -Force -Path "' + PC + '" | Out-Null',
    ];
    for (const it of manifest.items) {
      rb.push('if (Test-Path "' + it.to + '") { Move-Item -Force "' + it.to + '" "' + it.from + '"; Write-Host "已放回 ' + it.id + '" }');
      rb.push('if (Test-Path "' + path.join(ARCHIVE, '_projcache', it.id + '.json') + '") { Move-Item -Force "' + path.join(ARCHIVE, '_projcache', it.id + '.json') + '" "' + path.join(PC, it.id + '.json') + '" }');
    }
    rb.push('Write-Host "回滚完成：' + manifest.items.length + ' 条"');
    fs.writeFileSync(path.join(ARCHIVE, 'rollback.ps1'), rb.join('\n'), 'utf8');
    L('');
    L('  三条证明全部通过: ' + allOk + '   manifest + rollback.ps1 已写入 ' + ARCHIVE);
    if (!allOk) L('  !! 有不一致的条目，见 manifest.proofs');
  } else if (MODE === 'dry') {
    L('');
    L('dry：一条都没动。要真归档：node cleanup-ghost.cjs apply');
  }
  L('RESULT=' + (MODE === 'apply' ? 'ARCHIVED:' + targets.length : 'DRY:' + targets.length) + ':SKIPPED-FRESH:' + skipped.length);
  return { count: targets.length, skippedFresh: skipped.length, archive: MODE === 'apply' ? ARCHIVE : null };
}

module.exports = { scan };
if (require.main === module) main();
