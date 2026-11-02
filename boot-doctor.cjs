// 开机自动体检（静默、不打扰），带**受限**自愈。
//
// 挂法：HKCU\...\Run 写一条 `dsh-session-doctor`，用无窗口方式跑本脚本。
// 行为：
//   * 只跑 --fix-safe，分两档：
//       - **日志重写类**（头类补 protected head、E 类补收口）：只在宿主未运行时做。
//       - **残骸归档**（无 cwd 的分支子会话）：宿主在跑也做，但闸门更严——30 分钟没写过
//         + 日志必须过完整读盘链；半写/坏档一律不碰。依据是 branch 复盘 1–3 分钟就结束，
//         静置 30 分钟基本排除"还在写"；动作是同卷 rename，不丢数据、有 manifest 与
//         rollback.ps1。本机 2026-11-02 实测：开机后 13 分钟宿主已在跑，只读闸门让 6 条
//         残骸白躺了三天，才加的这一档。
//   * A/C 类改的是既有正文，仍然只在用户显式 `session-doctor.cjs --fix` 时才动。
//   * 全程不阻塞开机：体检放后台，最迟 60s 收尾；所有日志写入仍经 lib/safe-write.cjs，
//     宿主活着时它照样拒写。
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
