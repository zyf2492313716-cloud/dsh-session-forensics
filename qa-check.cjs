// 发布前质检：替换产物（双重 ||、缺模块引入）+ 隐私残留。
// 用法：node qa-check.cjs [目录]
// 用户名不写死：默认取当前登录名动态构造正则，也可用 DSH_QA_USER 指定。
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = process.argv[2] || ".";
const USER = process.env.DSH_QA_USER || os.userInfo().username;

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (/(^|[\\/])(backups|node_modules|\.git)([\\/]|$)/.test(p)) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
}

// 本文件跳过隐私检查：它含规则字面量，会自匹配
const SELF = path.resolve(__filename);
let bad = 0;
for (const f of walk(root)) {
  if (!/\.(cjs|mjs|js|md|json|txt)$/.test(f)) continue;
  const t = fs.readFileSync(f, "utf8");
  const problems = [];
  if (/DSH_FIX_ROOT \|\|\s*\(process\.env\.DSH_FIX_ROOT/.test(t)) problems.push("双重替换 DSH_FIX_ROOT");
  if (/\bos\.(homedir|tmpdir|userInfo)\s*\(/.test(t) && !/node:os/.test(t)) problems.push("用了 os 但没引入");
  if (/\bpath\.(join|relative|dirname)\s*\(/.test(t) && !/node:path/.test(t)) problems.push("用了 path 但没引入");
  if (path.resolve(f) !== SELF) {
    const home = new RegExp("Users[\\\\/]" + USER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const dell = (t.match(home) || []).length;
    const sessId = (t.match(/(import|session|sess|chatcmpl)-[0-9a-f]{8}-[0-9a-f]{4}/gi) || []).length;
    const wxid = (t.match(/wx[_-]?id[_-]?[a-z0-9]{6,}/gi) || []).length;
    const token = (t.match(/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}/g) || []).length;
    if (dell) problems.push(`本机用户路径 x${dell}`);
    if (sessId) problems.push(`会话 GUID x${sessId}`);
    if (wxid) problems.push(`微信标识 x${wxid}`);
    if (token) problems.push(`疑似 token x${token}`);
  }
  if (problems.length) {
    bad++;
    console.log(`✗ ${f}\n    ${problems.join("; ")}`);
  }
}
console.log(bad ? `\n${bad} 个文件有问题` : "全部干净");
process.exit(bad ? 1 : 0);
