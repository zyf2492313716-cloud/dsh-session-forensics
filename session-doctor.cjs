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
// --fix 处理五类：A（source.kind 是退休的 plugin 包装）/ C（尾段撞号）走 fix-v4-load，
// 头类（缺 protected first surface head：现在读不进 + 下次续聊才炸的雷）走
// repair-head-class，E（分支继承段结尾是未闭合轮）走 repair-fork-stub，
// 「无 cwd 的分支子会话残骸」走 cleanup-ghost（整批归档、带 manifest 与 rollback，不删除）。
// 全部经 lib/safe-write.cjs 同一把闸门：宿主活着一律不写。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const V = require('./lib/v4check.cjs');
V.bootstrapElectron();
const { hostAlive } = require('./lib/safe-write.cjs');
const { classifyHead, needsHead } = require('./lib/head-class.cjs');

const SESSIONS = process.env.DSH_SESSIONS || path.join(os.homedir(), '.dsh', 'sessions');
const REPORT_DIR = process.env.DSH_FIX_AUDIT_DIR || path.join(os.homedir(), '.dsh', 'logs', 'offline-writes');
const args = process.argv.slice(2);
const wantFix = args.includes('--fix');
// --fix-safe：只跑无损/可回滚的三类（补 protected head + E 类补收口 + 归档无 cwd 分支残骸），
// 不碰 A/C 那两类改既有正文的修复。开机项用的就是它。
const wantSafeFix = args.includes('--fix-safe');
const asJson = args.includes('--json');

async function main() {
  const host = hostAlive();
  const logs = V.listSessionLogs(SESSIONS);

  const broken = [];
  // 冷读通过但缺 protected head 的＝定时炸弹：用户在那条会话里发的第一条新消息会促使
  // 宿主补写一条中途 system/message，那一刻才变成上面的 broken（本机 2026-10-30 复发的
  // 就是这一类；判据与修法见 lib/head-class.cjs）。
  const headless = [];
  let healthy = 0;
  for (const { project, id, file } of logs) {
    let loaded = null;
    try { loaded = V.loadSessionFile(file); } catch (e) { broken.push({ project, id, file, stage: 'decode', err: e.message }); continue; }
    const err = V.verifyDecoded(loaded.header, loaded.events, loaded.inheritedEventCount, file);
    if (err) { broken.push({ project, id, file, stage: 'validate', err }); continue; }
    healthy++;
    if (needsHead(classifyHead(loaded.events).cls)) headless.push({ project, id, file });
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

  // ---- E 类（fork 继承段未闭合轮）与「无 cwd 子会话残骸」：交给两个专用工具 ----
  // 顺序有讲究：先把坏档修成可读，再归档残骸（修好的那条本身也是残骸，会一起被收走）。
  // 两者都走 lib/safe-write.cjs 同一把闸门，宿主活着一律不写。
  // 这两类是 --fix-safe 的范围：E 类只补一行宿主自己函数产的收口行（无损证明 + 备份 +
  // 复验不过就回滚），残骸是 move 不是删（manifest + rollback.ps1）；A/C 改的是既有正文，
  // 仍然只在用户显式 --fix 时才动。
  let eRepaired = 0, ghostsArchived = 0, headRepaired = 0, toolNotes = [];
  if ((wantFix || wantSafeFix) && !host.alive) {
    const runTool = (script) => {
      const r = spawnSync(process.execPath, [path.join(__dirname, script), 'apply'], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      return (r.stdout || '') + (r.stderr || '');
    };
    // 先补 protected head：既治"现在读不进"（BROKEN_NOW），也拆"下次续聊才炸"的雷（HEADLESS）。
    // 排在 E 类与残骸之前——修成可读之后才谈得上归档残骸。
    const hOut = runTool('repair-head-class.cjs');
    const hm = hOut.match(/RESULT=HEADFIXED:(\d+)/);
    headRepaired = hm ? Number(hm[1]) : 0;
    toolNotes.push(...hOut.split('\n').filter((l) => /需要补头|落盘|拒绝|放弃|拒写|RESULT=/.test(l)).map((l) => '头类 ' + l.trim()));
    const eOut = runTool('repair-fork-stub.cjs');
    const em = eOut.match(/模式=apply 修好=(\d+)/);
    eRepaired = em ? Number(em[1]) : 0;
    toolNotes.push(...eOut.split('\n').filter((l) => /RESULT=|拒写|未通过自证|自证不过/.test(l)).map((l) => 'E类 ' + l.trim()));
    const gOut = runTool('cleanup-ghost.cjs');
    const gm = gOut.match(/RESULT=ARCHIVED:(\d+)/);
    ghostsArchived = gm ? Number(gm[1]) : 0;
    toolNotes.push(...gOut.split('\n').filter((l) => /RESULT=|三条证明|归档目录|!!/.test(l)).map((l) => '残骸 ' + l.trim()));
  }

  const summary = {
    at: new Date().toISOString(),
    total: logs.length,
    healthy,
    broken: broken.length,
    headless: headless.length,
    headlessList: headless.map((h) => h.project + '\\' + h.id),
    fixed,
    headRepaired,
    eRepaired,
    ghostsArchived,
    toolNotes,
    hostAlive: host.alive,
    hostDetail: host.detail,
    unrepairable,
  };

  if (asJson) {
    // 注意：`broken` 恒为**条数**，清单放在 `brokenList`。早先这里写的是
    // {...summary, broken}，数组把计数覆盖了，导致 stdout 与 last-doctor.json 两种口径。
    console.log(JSON.stringify({ ...summary, brokenList: broken }, null, 2));
  } else {
    console.log(`会话体检：共 ${summary.total} 个，健康 ${healthy} 个，宿主打不开 ${broken.length} 个，缺 protected head（下次续聊才炸）${headless.length} 个`);
    for (const h of headless) console.log(`  ⚠ ${h.project}\\${h.id}`);
    for (const b of broken) {
      console.log(`  ✗ ${b.project}\\${b.id}\n      [${b.stage}] ${b.err}`);
    }
    if (wantFix || wantSafeFix) {
      if (headRepaired) console.log(`补 protected head 修好 ${headRepaired} 个（含拆掉"下次续聊必炸"的雷）`);
      if (fixed) console.log(`A/C 类自动修复 ${fixed} 个`);
      if (eRepaired) console.log(`E 类（分支继承段未闭合轮）补收口修好 ${eRepaired} 个`);
      if (ghostsArchived) console.log(`归档无 cwd 的分支子会话残骸 ${ghostsArchived} 条（可整批回滚，见 review-ghost-archive）`);
      for (const n of toolNotes) console.log('  · ' + n);
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

  // 修完还读不进才算失败；头类/E 类修复与残骸归档都计入"已处理"
  const stillBroken = broken.length - fixed - eRepaired - headRepaired;
  return broken.length === 0 || stillBroken <= 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
