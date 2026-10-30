// 开机自动体检（静默、不打扰），带**受限**自愈。
//
// 挂法：HKCU\...\Run 写一条 `dsh-session-doctor`，用无窗口方式跑本脚本。
// 行为：
//   * 宿主未运行时（登录那一刻通常成立，因为 DSH 桌面端不自启）才可能写盘
//   * 只跑 --fix-safe：E 类（分支继承段未闭合轮）补一行宿主自己函数产的收口行
//     + 归档「无 cwd 的分支子会话残骸」。两者都是无损/可回滚：
//     修前备份、修后用宿主真实读盘链复验、复验不过自动逐字节回滚；
//     残骸是 move 到 logs/review-ghost-archive/<stamp>/，带 manifest 与 rollback.ps1，不删。
//   * A/C 类改的是既有正文，仍然只在用户显式 `session-doctor.cjs --fix` 时才动。
//   * 全程不阻塞开机：体检放后台，最迟 60s 收尾；宿主活着时闸门一律拒写。
const path = require('node:path');
const { spawn } = require('node:child_process');

const DOCTOR = path.join(__dirname, 'session-doctor.cjs');
// DSH_DOCTOR_SAFE=0 可临时关掉自愈，退回纯只读体检
const args = process.env.DSH_DOCTOR_SAFE === '0' ? ['--json'] : ['--json', '--fix-safe'];

// 用 detached + 不继承 stdio，让开机项立刻返回，不拖慢登录
const child = spawn(process.execPath, [DOCTOR, ...args], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.unref();
