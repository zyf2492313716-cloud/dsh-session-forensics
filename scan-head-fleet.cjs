// 只读扫描：全库会话的 protected head 健康度
// 分类：
//   OK        —— surface 第一个节点就是 system/message（有头）
//   HEADLESS  —— 整份日志没有 system/message，或头不在投影首位 → 能打开，但下次发消息必炸
//   MIDSYS    —— 投影中途还有 system/message → 现在就读不进（宿主拒载）
//   NOEVENT   —— 空日志/只有 header
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const SKILL = path.join(os.homedir(), '.dsh', 'skills', 'dsh-storage-surgery', 'scripts');
const V = require(path.join(SKILL, 'lib', 'v4check.cjs'));
V.bootstrapElectron();

const HC = require(path.join(__dirname, 'lib', 'head-class.cjs'));
const SURFACE = HC.SURFACE;
const classify = HC.classifyHead;

const root = path.join(os.homedir(), '.dsh', 'sessions');
const out = { at: new Date().toISOString(), total: 0, byClass: {}, rows: [], unreadable: [] };
for (const proj of fs.readdirSync(root)) {
  const pdir = path.join(root, proj);
  if (!fs.statSync(pdir).isDirectory()) continue;
  for (const sid of fs.readdirSync(pdir)) {
    const f = path.join(pdir, sid, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(f)) continue;
    out.total++;
    let loaded;
    try { loaded = V.loadSessionFile(f); } catch (e) { out.unreadable.push({ proj, sid, err: String(e.message).slice(0, 120) }); continue; }
    const c = classify(loaded.events);
    out.byClass[c.cls] = (out.byClass[c.cls] || 0) + 1;
    if (c.cls !== 'OK' && c.cls !== 'OK_MIDAPPEND') out.rows.push({ proj, sid, cls: c.cls, headSeq: c.headSeq, mid: c.mid.slice(0, 6), events: loaded.events.length, isImport: sid.startsWith('import-'), mtime: fs.statSync(f).mtime.toISOString().slice(0, 19) });
  }
}
const text = JSON.stringify(out, null, 1);
const dest = path.join(__dirname, 'head-fleet-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
fs.writeFileSync(dest, text);
console.log(text.length > 4000 ? text.slice(0, 4000) + '\n... (截断，全量见 ' + dest + ')' : text);
console.log('WROTE ' + dest);
