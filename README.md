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
| `session-doctor.cjs` | 体检 + `--fix` 自动修（要求宿主已退出），报告落 `~/.dsh/logs/offline-writes/last-doctor.json` |
| `fix-v4-load.cjs` | 单点修复：只修真坏的 A/C 两类，dry 默认、apply 经闸门 |
| `boot-doctor.cjs` | 开机静默体检入口（注册到 HKCU Run，实测 60ms 返回不拖登录） |
| `lib/safe-write.cjs` | **离线写会话日志的唯一入口**（见"三道防线"） |
| `check-writers.cjs` | 静态护栏：揪出绕过闸门直写会话日志的脚本，退出码可接 CI |
| `audit-backup-superset.cjs` | 备份清理器（fail-closed）：只有证明"现盘是备份的超集、且副本里的每条真用户消息在全库都有落点"才删；判不了的保留。曾以此回收 ~400MB 且零丢失 |
| `migrate-tmp-rename.cjs` | 把历史脚本的 `writeFileSync(tmp)+renameSync` 一行迁移到闸门 |

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

## 三类真因与一类误诊

| 类 | 症状 | 定性 |
|---|---|---|
| **A** `source.kind:"plugin"` | `decodeRow line 3: … requires a producer-owned source kind` | 真坏。V4 只认生产者自有 kind。修复按宿主 `producerKind()` 表改写 |
| **C** 尾段 seq/turn 撞号 | `format v4 event N is not dense` / `does not open the expected turn` | 真坏（重导+旧宿主续写交错）。整段平移修复，可字段级自证无损 |
| **D** 行缺 `time` | `released v2 row N lacks required field time` | 真坏，离线脚本裸 push 尾部事件不写 seq/time。修复只补 time、保持键序 |
| ~~B~~ 区间对 `[[a,b]]` | （只有跳过 decodeRow 的自写校验器会报） | **不是故障**。宿主写盘主动压缩、读盘自动展开，读写对称。别修 |

## 三道防线

1. **写盘闸门 `lib/safe-write.cjs`**：`writeSessionLog()` 内嵌整形（调用方忘了整形函数
   也写不出坏档，插件的 `prepareHostEvents` 已验证幂等）；**宿主存活即拒写**
   （判据：命令行含 `dsh-desktop-host` 的进程；探不到按活着算。文件锁不可用——宿主
   不持有日志句柄，实测 `FileShare.None` 照样打开）；写临时文件→真实链读回→原子替换→审计。
2. **静态护栏 `check-writers.cjs`**：任何直写会话日志的新脚本在收尾检查里变红。
3. **开机兜底 `boot-doctor.cjs`**：登录即全库体检（只读+报告），坏档不会静默躺到下次点开才暴露。
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
