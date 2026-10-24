// 全库会话体检 + 自修（事后兜底）。
//
// 目的：让"宿主打不开"的日志不会静静躺在盘上等用户撞见。
// 每次运行：
//   1. 用宿主真实读盘链（lib/v4check.cjs，含 decodeRow）扫全部会话
//   2. 只读报告：哪些宿主打不开、错误落在哪一层
//   3. 带 --fix 且宿主未运行时：自动修（走 lib/safe-write.cjs 闸门，整形内嵌）
// 退出码：0 = 全健康或已修复；1 = 有不可修/待人工的坏档
//
// 用法：
//   node session-doctor.cjs            只体检
//   node session-doctor.cjs --fix      体检并自动修（宿主必须已退出）
//   node session-doctor.cjs --json     机器可读输出
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const V = require('./lib/v4check.cjs');
V.bootstrapElectron();
const { hostAlive } = require('./lib/safe-write.cjs');

const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const REPORT_DIR = process.env.DSH_FIX_AUDIT_DIR || path.join(os.homedir(), '.dsh', 'logs', 'offline-writes');
const args = process.argv.slice(2);
const wantFix = args.includes('--fix');
const asJson = args.includes('--json');

async function main() {
  const host = hostAlive();
  const logs = V.listSessionLogs(SESSIONS);

  const broken = [];
  let healthy = 0;
  for (const { project, id, file } of logs) {
    const r = V.verifyFile(file);
    if (r.ok) {
      healthy++;
      continue;
    }
    broken.push({ project, id, file, stage: r.stage, err: r.err });
  }

  // ---- 修复（A/C 两类，复用 fix-v4-load 的 repairOne）----
  let fixed = 0;
  const unrepairable = [];
  if (wantFix && broken.length) {
    if (host.alive) {
      if (!asJson) {
        console.error(`宿主正在运行（${host.detail}），不能离线改写日志。请从托盘右键退出后重试 --fix。`);
      }
      unrepairable.push(...broken.map((b) => ({ ...b, reason: 'host-alive' })));
    } else {
      const fixer = require('./fix-v4-load.cjs');
      for (const b of broken) {
        let r;
        try {
          r = fixer.repairOne ? await fixer.repairOne(b.file) : { ok: false, reason: 'fixer-missing' };
        } catch (e) {
          r = { ok: false, reason: e.message };
        }
        if (r.ok) fixed++;
        else unrepairable.push({ ...b, reason: r.reason });
      }
    }
  }

  const summary = {
    at: new Date().toISOString(),
    total: logs.length,
    healthy,
    broken: broken.length,
    fixed,
    hostAlive: host.alive,
    hostDetail: host.detail,
    unrepairable,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...summary, broken }, null, 2));
  } else {
    console.log(`会话体检：共 ${summary.total} 个，健康 ${healthy} 个，宿主打不开 ${broken.length} 个`);
    for (const b of broken) {
      console.log(`  ✗ ${b.project}\\${b.id}\n      [${b.stage}] ${b.err}`);
    }
    if (wantFix) {
      console.log(fixed ? `已自动修复 ${fixed} 个` : '未修复任何（详见上）');
      for (const u of unrepairable) console.log(`  待人工 ${u.id}：${u.reason}`);
    }
    if (host.alive) console.log(`（宿主在运行：${host.detail}）`);
  }

  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'last-doctor.json'), JSON.stringify(summary, null, 2));
  } catch {
    /* 报告写不进去不影响体检结论 */
  }

  return broken.length === 0 || fixed === broken.length ? 0 : 1;
}

main().then((code) => process.exit(code));
