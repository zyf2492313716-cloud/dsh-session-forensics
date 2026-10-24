// 开机自动体检（静默、只读、不打扰）。
//
// 挂法：HKCU\...\Run 写一条 `dsh-session-doctor`，用无窗口方式跑本脚本。
// 行为：
//   * 只在宿主**未**运行时做深度检查（宿主在跑也能读盘校验，只是不修）
//   * 发现宿主打不开的日志 → 写报告 + 弹一次通知（不自动改，避免用户不知情）
//   * 全程不阻塞开机：体检放后台，最迟 60s 收尾
// 为什么不自动修：离线改写必须在宿主退出后，且用户要知情。
// 自动修只在用户显式 `session-doctor.cjs --fix` 时发生。
const path = require('node:path');
const { spawn } = require('node:child_process');

const DOCTOR = path.join(__dirname, 'session-doctor.cjs');

// 用 detached + 不继承 stdio，让开机项立刻返回，不拖慢登录
const child = spawn(process.execPath, [DOCTOR, '--json'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.unref();
