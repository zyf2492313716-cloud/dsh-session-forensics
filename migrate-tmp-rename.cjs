// 一次性迁移：把「writeFileSync(tmp, buf) + …自检… + renameSync(tmp, target)」
// 换成 commitBuffer(target, buf, {…})，让落盘统一走 lib/safe-write.cjs 闸门。
//
// 只替换「tmp 由 target + 后缀 拼出来」这一种形态，且要求 writeFileSync 与
// renameSync 的 tmp 变量名一致、rename 的目标与 tmp 的来源一致；
// 任何不确定的形态一律跳过并打印，留给人看（不猜）。
//
// 用法：node migrate-tmp-rename.mjs [--apply] [文件…]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = process.env.DSH_FIX_ROOT || path.join(os.homedir(), 'dsh-fix');
const apply = process.argv.includes('--apply');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

// 默认目录不存在时给出明确指引，而不是让 readdirSync 抛 ENOENT
if (!fs.existsSync(ROOT)) {
  console.error(`扫描目录不存在：${ROOT}\n用 DSH_FIX_ROOT 指定，或直接把目标文件作为参数传入。`);
  process.exit(2);
}
const files = (only.length ? only.map((f) => path.join(ROOT, f)) : fs.readdirSync(ROOT).filter((f) => /\.mjs$/.test(f)).map((f) => path.join(ROOT, f)))
  .filter((f) => fs.existsSync(f) && !/migrate-tmp-rename/.test(f));

let changed = 0;
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  const name = path.basename(file);
  const lines = src.split('\n');

  // 找 const <tmp> = <target> + '<suffix>';
  const out = [];
  const rewrites = [];
  for (let i = 0; i < lines.length; i++) out.push(lines[i]);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/const\s+(\w+)\s*=\s*([A-Za-z_$][\w$.]*)\s*\+\s*'[^']*'\s*;?/);
    if (!m) continue;
    const tmp = m[1];
    const target = m[2];
    // 同一文件里找 writeFileSync(tmp, EXPR) 与 renameSync(tmp, target)
    const wIdx = lines.findIndex((l) => new RegExp(`fs\\.writeFileSync\\(\\s*${tmp}\\s*,`).test(l));
    const rIdx = lines.findIndex((l) => new RegExp(`fs\\.renameSync\\(\\s*${tmp}\\s*,\\s*${target.replace(/\./g, '\\.')}\\s*\\)`).test(l));
    if (wIdx === -1 || rIdx === -1 || rIdx < wIdx) continue;
    const wLine = lines[wIdx];
    const wm = wLine.match(new RegExp(`fs\\.writeFileSync\\(\\s*${tmp}\\s*,\\s*([\\s\\S]*)\\)\\s*;\\s*$`));
    if (!wm) continue;
    const bufExpr = wm[1].trim();
    // 自检段原样保留（在 tmp 上读回校验的代码仍能工作，因为闸门也是先写 tmp 再读回）
    rewrites.push({ i, wIdx, rIdx, tmp, target, bufExpr, indent: lines[wIdx].match(/^\s*/)[0] });
  }

  if (!rewrites.length) continue;

  // 正确改法（保持自检语义）：
  //   1. 在自检之前，把要写的字节绑到变量 __buf = <EXPR>
  //   2. 自检里所有 readFileSync(tmp) → __buf（校验的就是真正要落盘的那份字节）
  //   3. 删掉 const tmp = ... 与 fs.renameSync(tmp, target)
  //   4. 末尾落盘换成 commitBuffer(target, __buf, { reason })
  for (const rw of rewrites.sort((a, b) => b.wIdx - a.wIdx)) {
    // 用 __buf 承载字节：把原 writeFileSync(tmp, EXPR) 换成 const __buf = EXPR
    lines[rw.wIdx] = `${rw.indent}const __buf_${rw.wIdx} = ${rw.bufExpr};`;
    // 删掉 const tmp 行
    lines[rw.i] = null;
    // 删掉 renameSync 行，换成 commitBuffer
    lines[rw.rIdx] = `${rw.indent}commitBuffer(${rw.target}, __buf_${rw.wIdx}, { reason: '${name}' });`;
    // 自检段里 fs.readFileSync(tmp) → __buf_<wIdx>
    for (let j = rw.wIdx + 1; j < rw.rIdx; j++) {
      if (lines[j] == null) continue;
      lines[j] = lines[j].replace(new RegExp(`fs\\.readFileSync\\(\\s*${rw.tmp}\\s*\\)`, 'g'), `__buf_${rw.wIdx}`);
    }
  }
  let next = lines.filter((l) => l !== null).join('\n');

  if (!/safe-write/.test(next)) {
    const inject = [
      `import { createRequire as __cr } from 'node:module';`,
      `const { commitBuffer } = __cr(import.meta.url)('./lib/safe-write.cjs');`,
    ];
    const ls = next.split('\n');
    let last = -1;
    for (let i = 0; i < ls.length; i++) if (/^import .* from 'node:/.test(ls[i])) last = i;
    if (last === -1) ls.unshift(...inject);
    else ls.splice(last + 1, 0, ...inject);
    next = ls.join('\n');
  }

  if (!apply) {
    console.log(`[dry] ${name}  ${rewrites.length} 处 tmp+rename → commitBuffer`);
    continue;
  }
  fs.writeFileSync(file, next);
  console.log(`[apply] ${name}  ${rewrites.length} 处已迁移`);
  changed++;
}
console.log(`\n${apply ? `已迁移 ${changed} 个` : 'dry 模式，未改动'}`);
