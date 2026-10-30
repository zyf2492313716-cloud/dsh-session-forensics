# DSH 会话日志取证与防线工具

DeepSeek Harness（DSH）把每个对话存成 `~/.dsh/sessions/<工程>/<会话>/session.v4.jsonl.zstd`。
一旦这个日志写得不合宿主契约，界面只会给你一行红字：

> 历史加载失败: stored session "…" is corrupt: … SessionFormatError: format v4 message requires a producer-owned source kind (gateway/internal)

本仓库是围绕这类故障做的一套工具和经验，全部**离线运行**（不启动宿主也能用——宿主自带的校验代码从 `app.asar` 里直接 require）。

## 起因（真实事故时间线）

某次离线"全量重导"用了一个自写脚本：它绕过插件的落盘函数 `prepareHostEvents()`，
只调了底层的 `shapeToolResults()`——于是 V3 形状的 `source: {kind:"plugin", plugin:"…"}`
被原样写进 V4 日志，9 个会话全部拒载。随后旧宿主进程又在重导后的日志尾部追加了一段
沿用旧编号的事件，尾段 seq/turn 与头部撞号。

排查过程中还发现两个更隐蔽的问题：

1. **自写的三层校验器（帧结构/seq 连续/标题引用）全部通过，宿主照样拒载**——因为
   宿主读盘时还跑了行准入、关系校验、surface 折叠、消息投影、assistant 流回放。
2. **一个"更严格"的校验器把 8 个健康会话误判成坏档**——因为它跳过了宿主的
   `decodeRow`，而 `decodeRow` 内部会把存储形态的区间对 `[[a,b]]` 展开成 `[a,b]`。
   `sourceEventSeqs` 写成区间对是宿主的正常编码（读写对称），不是损坏。

## 工具清单

| 文件 | 作用 |
|---|---|
| `lib/v4check.cjs` | **唯一可信的尺子**：与宿主 `readStoredLog` 同构的六层校验（见下） |
| `prove-v4check.cjs` | CLI：全库体检；`--diff-bak <备份根>` 可证明修复无损 |
| `session-doctor.cjs` | 体检 + 修复。`--fix` 修 A/C/E 并归档残骸；`--fix-safe` 只跑无损可回滚的两类（E 补收口 + 归档无 cwd 分支残骸），开机项用后者。都要求宿主已退出，报告落 `~/.dsh/logs/offline-writes/last-doctor.json`（stdout 里 `broken` 是条数、清单在 `brokenList`） |
| `fix-v4-load.cjs` | 单点修复：只修真坏的 A/C 两类，dry 默认、apply 经闸门 |
| `boot-doctor.cjs` | 开机静默体检入口（注册到 HKCU Run，实测 60ms 返回不拖登录） |
| `lib/safe-write.cjs` | **离线写会话日志的唯一入口**（见"三道防线"） |
| `check-writers.cjs` | 静态护栏：揪出绕过闸门直写会话日志的脚本，退出码可接 CI |
| `audit-backup-superset.cjs` | 备份清理器（fail-closed）：只有证明"现盘是备份的超集、且副本里的每条真用户消息在全库都有落点"才删；判不了的保留。曾以此回收 ~400MB 且零丢失 |
| `migrate-tmp-rename.cjs` | 把历史脚本的 `writeFileSync(tmp)+renameSync` 一行迁移到闸门 |
| `repair-fork-stub.cjs` | **E 类**修复：分支继承段结尾是未闭合轮时，调宿主自己的 `repair.js#openTurnClosers(prefix,{kind:'forked'})` 补一行收口。只插一行 + 纯 seq 平移，自带无损证明与悬空引用检查，自证不过就拒绝落盘 |
| `cleanup-ghost.cjs` | 归档"无 cwd 的分支子会话残骸"（宿主读历史时对 `header.cwd===undefined` 直接判 `session/not-found`，这类会话点开必红字）。整目录 move + `manifest.json` + `rollback.ps1`，逐条记 sha256 与三条证明，**不删除**。带**年龄闸**（`DSH_GHOST_MIN_AGE_MIN`，默认 10 分钟）：刚被写过的会话一律不动 |
| `fix-mid-system-message.cjs` | 修「中途 `system/message` 没有受保护头」。**实测只摘除走得通**：补一条**带原内容/原轮步**的头会在更深一层撞 `compaction/summary shadowedSeqs do not name an exact current surface span`。摘除必须**完整重映射**引用——`sourceEventSeqs` 是挂在**事件根上的数字数组**，只走对象属性会整批漏掉。代价：丢那条系统提示副本（实测 7,107 字节，宿主恢复时按当前模型重生成）；正文核对 144 user / 8,429 assistant / 3,895 tool 一条不少 |
| `fix-head.cjs` + `lib/head-class.cjs` | 同一病灶的第二条路线（**并行实现，未在真件上跑过**）：插一条**空头** `system/message`（`content:[]`、`kind:system-prompt`，与插件 `convert/events.mjs` 的 `pushSystemHead` 同形）、摘掉不在头部的 system/message、把指向被摘事件的 `surfaceOp.replace` 改指新头，再做全量重映射。适合要把日志修成"健康导入会话同形"的场合。注意它按自己的固定根找会话，不读 `DSH_SESSIONS`，隔离测试要先改路径 |
| `test-repair-fork-stub.cjs` | E 类工具的合成回归测试（自带负控制）。`node test-repair-fork-stub.cjs`，退出码即结论 |
| `test-doctor-selfheal.cjs` | `--fix-safe` 的端到端测试：三种合成夹具，断言"坏档修好、残骸归档、顶层会话一字节不动、A/C 不被顺手跑、年龄闸生效、可幂等重跑" |

## 回归测试（改过任何一件都必须重跑）

```
node test-repair-fork-stub.cjs     # 退出码 0 = 通过
node test-doctor-selfheal.cjs      # 退出码 0 = 通过
node qa-check.cjs                  # 仓库自带隐私/产物自检
```

这两条测试不是装饰：2026-10-29 上线的 `repair-fork-stub.cjs` 曾经因为 `build()`
在调用方的事件数组上**原地改 seq**，让无损证明算出 58 条"假违规"，从此任何真坏档
都会被它拒绝修复——干跑看不出来，是拿一份真能复现故障的夹具跑了一遍才暴露的。
所以每条测试都带**负控制**（夹具必须先"坏得起来"），以及一条专门盯原地改 seq 的哨兵
（`仅 seq 平移 N`，N 必须 > 0）。

## 六层校验（判"宿主能不能打开"的完整链条）

```
① 多帧 zstd 解压，首帧恰好一行 header
② codec.createDecoder(header) → 逐行 decoder.decodeRow(row)   ← 关键，内含 decodeSeqRanges
③ assertV4RowAdmission：type/seq/time/data 四字段 + tool/result 形状 + source kind 准入
④ assertReleasedV4Relationships：replace 端点/遮蔽集合/protected head/事件类型
⑤ Session.fromRestore(..., currentSessionMessageProjections)：surface 折叠 + 消息投影
⑥ assistant 内嵌流回放：expandAssistantStream + BlockAssembler 核对 content/usage/replayState
```

**②不可跳过**：它把区间对展开，跳过就会把正常日志误判成坏档。
**校验器必须自证**：拿一个已知坏档跑它，必须报错；永远绿的尺子是橡皮的。

## 四类真因与一类误诊

| 类 | 症状 | 定性 |
|---|---|---|
| **A** `source.kind:"plugin"` | `decodeRow line 3: … requires a producer-owned source kind` | 真坏。V4 只认生产者自有 kind。修复按宿主 `producerKind()` 表改写 |
| **C** 尾段 seq/turn 撞号 | `format v4 event N is not dense` / `does not open the expected turn` | 真坏（重导+旧宿主续写交错）。整段平移修复，可字段级自证无损 |
| **D** 行缺 `time` | `released v2 row N lacks required field time` | 真坏，离线脚本裸 push 尾部事件不写 seq/time。修复只补 time、保持键序 |
| **E** 分支继承段结尾是未闭合轮 | `relationships: turn/start does not open the expected turn`，且未闭合的那一轮正好在 `session/end-seed{inherited:true}` 之前 | 真坏，但**责任在种下它的生产者**。宿主 `fork.js#buildForkSeed` 本应调 `openTurnClosers(prefix,{kind:'forked'})` 补收口；绕过这条路直接用 `agents.create` 建分支会话的（如自动复盘的 branch 模式）就没补。修复：补那一行，正文不动 |
| ~~B~~ 区间对 `[[a,b]]` | （只有跳过 decodeRow 的自写校验器会报） | **不是故障**。宿主写盘主动压缩、读盘自动展开，读写对称。别修 |

判 E 类的三个硬条件（少了就会误伤）：切点必须是 `data.inherited === true` 的那条
`session/end-seed`——`data:{}` 的是宿主启停补写的崩溃段尾标记，同一份日志里可以有多条；
扫到切点为止轮必须还开着；切点之后必须真的又开了新轮（只是尾部开着的话宿主崩溃恢复
自己会补，别抢它的活）。

## 与上游修复的关系（截至 2026-10-30）

宿主 `deepseek-ai/deepseek-harness` 是公开仓库（MIT），但 **Issues/PR 入口被关**，
反馈走 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。
上游 master 已有三条与本仓库同方向的修复，**但一行都没进发布通道**
（最新 tag `dsh-v0.2.1-rc.3`，落后 master 393 个 commit；桌面更新源 nightly 通道挂的
`0.2.1-rc.5` 发布于 PR 合并之前）：

| PR | 内容 | 与本仓库的关系 |
|---|---|---|
| #109 | `修复 Fork 时继承的会话尾巴仍处于开启轮次`——**已随 rc.3 发布**（本机就是 rc.3） | 只在走宿主 `buildForkSeed` 的 fork 上生效。自动复盘的 branch 模式是自己调 `agents.create` 种会话，不经过那条路，所以本机照样出现 E 类。这条恰好反证了 E 类的责任在**生产者**，不在读路径 |
| #121 | `fix(api-session): fork 出来的会话当作普通可恢复会话，不再当子代理` | 治"无 cwd 残骸/点不开"的根 |
| #123 | `fix(api-session): 分支会话归一成普通会话；子代理保留 creator` | 同上，且把 fork 的 `meta` 改成 `origin/parentSession/workspaceId` 齐全 |

所以这三样东西的定位要说清楚：**它们是"上游修复发布之前"的离线防线**，不是要替代上游。
升级到含 #121/#123 的版本后，新的无 cwd 分支残骸应当不再产生，`cleanup-ghost.cjs`
自然无事可做；`repair-fork-stub.cjs` 仍需保留——历史上已经种下来的坏档不会自愈。

## 三道防线

1. **写盘闸门 `lib/safe-write.cjs`**：`writeSessionLog()` 内嵌整形（调用方忘了整形函数
   也写不出坏档，插件的 `prepareHostEvents` 已验证幂等）；**宿主存活即拒写**
   （判据：命令行含 `dsh-desktop-host` 的进程；探不到按活着算。文件锁不可用——宿主
   不持有日志句柄，实测 `FileShare.None` 照样打开）；写临时文件→真实链读回→原子替换→审计。
2. **静态护栏 `check-writers.cjs`**：任何直写会话日志的新脚本在收尾检查里变红。
3. **开机兜底 `boot-doctor.cjs`**：登录即全库体检，并跑**受限**自愈 `--fix-safe`
   （E 类补收口 + 归档无 cwd 分支残骸，两类都无损/可回滚）。DSH 桌面端不自启，
   所以登录那一刻正好是"宿主没在跑"的安全窗口；即便如此，闸门在宿主活着时照样拒写。
   想退回纯只读体检：设环境变量 `DSH_DOCTOR_SAFE=0`。改既有正文的 A/C 类不在自动范围内，
   仍要显式 `session-doctor.cjs --fix`。
   实测验证（真重启后）：报告 `mtime` 落在开机后 2 分钟、且 `hostAlive=false`（宿主未起的
   安全窗口），证明这条链真的通电——注册了不等于跑了。

## 快速开始

```powershell
# 普通 node（≥24，需 zlib.zstdDecompressSync）即可，模块会自动借 DSH 自带 Electron 重跑
node prove-v4check.cjs                     # 全库体检
node session-doctor.cjs                    # 体检 + 报告
node check-writers.cjs                     # 谁在绕过闸门直写

# 修（要求 DSH 已退出；先 dry 后 apply）
node fix-v4-load.cjs dry
node fix-v4-load.cjs apply

# 开机体检（Windows）
cmd /c start "" /b "<DSH安装目录>\DeepSeek Harness.exe" "<本目录>\boot-doctor.cjs"
# 然后把上面这行 set 成 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 的 dsh-session-doctor
```

环境变量：`DSH_APP_RESOURCES`（DSH 的 resources 目录，默认按 LOCALAPPDATA / ProgramFiles / /Applications 推导）、
`DSH_SESSIONS`、`DSH_FIX_AUDIT_DIR`、`DSH_FIX_BACKUP_ROOT`。自测旁路宿主检查用 `DSH_FIX_ASSUME_HOST_OFFLINE=1`
（会在审计日志里留痕，生产不要用）。

## 适用边界

- 面向 DSH **0.2.x（V4 日志世代）**；宿主升级后六层里的实现细节可能变化，体检器会显式报错而不是猜。
- 工具只依赖 `app.asar` 内的 `dsh-session-format-v3-to-v4` / `dsh-session-persistence` / `dsh-session`，不改宿主、不碰 `app.asar`。
- `session-doctor --fix` 只处理 A/C 两类；其余一律"需人工"上报，不做静默改动。
- 所有写入都带备份与审计：`~/.dsh/logs/offline-writes/`。

## 一句话教训

> 判"能不能打开"的尺子必须是宿主本尊的代码路径；写"要落盘的字节"的闸门必须让调用方想忘也忘不掉。

MIT 授权，见 LICENSE。
