// lib/head-class.cjs —— 「protected first surface head」判据（单一真源）
//
// 宿主的硬规则（session-format 迁移器）：
//   system/message 落到非空 surface 上时，必须已经登记了 protected head，否则抛
//   "system/message requires a protected first surface head" → 整份日志冷读被拒。
// 所以：
//   OK          surface 第一个节点就是 system/message（有头）——中途再出现
//               system/message 是合法的（本机 45 条原生会话都是这个形态，宿主读得进）。
//   HEADLESS    有 surface 内容但整份没有头：**冷读能过**，用户在里面发的第一条新消息
//               会促使宿主补写一条中途 system/message，那一刻才炸 → 定时炸弹。
//   BROKEN_NOW  没头 + 已经有中途 append 的 system/message：现在就读不进（界面红字）。
//   NOEVENT     没有任何 surface 节点（空会话）：宿主自己会建头，不算病。
'use strict';

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);

/** 折叠 surface 投影，返回 {cls, headSeq, mid}（mid＝中途 append 的 system/message 的 seq） */
function classifyHead(events) {
  const state = [];
  let headSeq;
  const mid = [];
  for (const e of events) {
    if (!SURFACE.has(e.type)) continue;
    const so = e.surfaceOp;
    const isAppend = so === undefined || so === 'append';
    if (e.type === 'system/message' && isAppend) {
      if (state.length === 0) { if (headSeq === undefined) headSeq = e.seq; }
      else mid.push(e.seq);
    }
    if (isAppend) {
      state.push(e.seq);
    } else if (so && typeof so === 'object') {
      const a = so.startSeq, b = so.endSeq;
      for (let i = state.length - 1; i >= 0; i--) if (state[i] >= a && state[i] <= b) state.splice(i, 1);
      state.push(e.seq);
    }
  }
  if (state.length === 0) return { cls: 'NOEVENT', headSeq, mid };
  if (headSeq === undefined && mid.length) return { cls: 'BROKEN_NOW', headSeq, mid };
  if (headSeq === undefined) return { cls: 'HEADLESS', headSeq, mid };
  return { cls: 'OK', headSeq, mid };
}

/** 需要补头（HEADLESS / BROKEN_NOW）？ */
function needsHead(cls) { return cls === 'HEADLESS' || cls === 'BROKEN_NOW'; }

module.exports = { SURFACE, classifyHead, needsHead };
