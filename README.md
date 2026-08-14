# PromptRecall

仿 Codex 的 DSH Web GUI 输入历史插件：在会话输入框按 `↑`/`↓` 浏览历史 prompt，历史跨会话、跨重启持久保留。
A Codex-style input-history plugin for the DSH Web GUI: browse previous prompts with `↑`/`↓` in the session composer, with history persisted across conversations and restarts.

## 特性 / Features

- **↑ 召回历史，↓ 向新移动**：空输入框按 ↑ 从最新条目开始逆序浏览，↓ 向新移动，越过最新项后清空输入框并退出浏览。
  **↑ recalls, ↓ moves forward**: an empty composer starts browsing from the newest entry; ↓ moves toward newer entries, and moving past the newest one clears the composer and exits browsing.
- **当前对话优先**：回到一个对话时，先召回该对话自己的历史，继续按 ↑ 才进入其他对话的历史。
  **Current conversation first**: returning to a conversation recalls that conversation's own history first; pressing ↑ further walks into other conversations' history.
- **跨会话、跨重启持久**：用户级 JSONL 全局历史，稳定单调 ID，刷新页面或重启后仍可召回。
  **Persistent across conversations and restarts**: a user-level JSONL history with stable monotonic IDs remains recallable after page reloads and restarts.
- **安全的按键路由**：非空草稿、多行正文中间、有选区、弹窗打开时，方向键一律交还编辑器，绝不误伤草稿。
  **Safe key routing**: with a non-empty draft, a caret in the middle of multi-line text, an active selection, or an open popup, arrow keys are handed back to the editor and never overwrite a draft.
- **Esc 草稿保险**：清空未发送的非空草稿时把它存入历史（仅文本），按 ↑ 可找回。
  **Esc draft insurance**: clearing an unsent non-empty draft stores it in the history (text only) so ↑ can bring it back.
- **位置指示**：输入框上方 pill 显示当前位置（如 `↑ 2/38`）；pill 上的 × 两次点击可清空全部历史。
  **Position indicator**: a pill above the composer shows the current position (e.g. `↑ 2/38`); clicking its × twice clears all history.
- **仅存文本 + 自动裁剪**：只持久化纯文本；相邻完全相同的条目折叠；文件超限时删除最旧整行并保留最新。
  **Text-only storage with auto-trim**: only plain text is persisted; adjacent identical entries are folded; oversized files drop the oldest complete records while keeping the newest.

## 设计 / Design

历史分两层：**持久层**（跨会话 JSONL 文件，只存文本）与**局部层**（当前会话的召回列表，含 Esc 暂存草稿）。
History has two layers: a **persistent layer** (the cross-conversation JSONL file, text only) and a **local layer** (the current conversation's recall list, including Esc-stashed drafts).

进入或切回一个会话时冻结快照：快照只含**其他会话**的记录，本会话的记录播种进局部层，因此统一索引的顺序是 `[其他会话记录 | 本会话记录]`。
Entering or returning to a conversation freezes a snapshot: the snapshot keeps only **other conversations'** records, while this conversation's records are seeded into the local layer — the unified index order is `[other conversations | this conversation]`.

示例：会话 A 依次输入 a、b、c，切到会话 B 输入 e、f，再切回 A 后按 ↑ 的顺序是 `c → b → a → f → e`（当前对话优先，全局兜底）。
Example: conversation A submits a, b, c; conversation B submits e, f; back in A, ↑ recalls `c → b → a → f → e` (current conversation first, global history as fallback).

每条记录带**稳定单调 ID**，裁剪只删最旧整行、不重编号；本会话新提交只出现在局部层，因此每条恰好出现一次；局部层相邻且完全相同的条目（文本+会话+附件签名）折叠，持久层保留重复记录。
Every record carries a **stable monotonic ID**; trimming deletes only the oldest complete records and never renumbers. New submissions in the current conversation appear only in the local layer, so every entry appears exactly once. Adjacent identical entries in the local layer (text + conversation + attachment signature) are folded, while the persistent layer keeps duplicates.

## 键位与交互逻辑 / Keybindings & interaction logic

| 按键 Key | 行为 Behavior |
|---|---|
| `↑`（空草稿）<br>`↑` (empty draft) | 进入历史浏览，从最新条目开始<br>Start browsing history from the newest entry |
| `↑` / `↓`（浏览中）<br>`↑` / `↓` (browsing) | 向旧 / 向新移动；最旧处不回绕<br>Move older / newer; no wrap at the oldest end |
| `↓`（最新项再按）<br>`↓` (past the newest) | 清空输入框并退出浏览<br>Clear the composer and exit browsing |
| `↑`/`↓`（非空草稿、正文中间、有选区、弹窗打开）<br>`↑`/`↓` (non-empty draft, mid-text, selection, popup open) | 交还编辑器，只移动光标/候选<br>Handed back to the editor: move the caret / candidates only |
| `Esc`（非空草稿）<br>`Esc` (non-empty draft) | 清空草稿并存入历史（↑ 可找回）<br>Clear the draft and store it in history (recoverable with ↑) |
| `Esc`（浏览中）<br>`Esc` (browsing) | 退出浏览；草稿为空时不做任何事<br>Exit browsing; no-op when the draft is empty |

鼠标操作（非键盘）/ Mouse actions (not keyboard):

| 操作 Action | 行为 Behavior |
|---|---|
| 点击 pill 上的 `×` 两次（3 秒内）<br>Click the pill's `×` twice (within 3 s) | 第一次点击变"确认?"，第二次清空全部历史（含持久文件）<br>The first click arms "confirm?", the second clears all history (including the persistent file) |

接管判定：按键目标必须是会话输入框；只有"语义空"草稿（文本、附件、mention 全空）按 ↑ 才进入浏览；浏览中一旦用户改动文本或附件，立即退出接管并作废在途请求；弹窗或命令菜单消费过的按键自动让位。
Takeover rules: the key target must be the conversation composer; browsing starts with ↑ only on a semantically empty draft (no text, attachments, or mentions); any user edit to the text or attachments while browsing immediately releases the takeover and invalidates in-flight requests; keys already consumed by a popup or command menu are always left alone.

## 数据与隐私 / Data & privacy

历史写入 DSH 主目录（通常为用户主目录）下的 `.dsh/prompt-history.jsonl`，每行一条 JSON 记录；只保存纯文本，不保存图片、mention 绑定或其他附件内容。
History is written to `.dsh/prompt-history.jsonl` under the DSH home directory (usually the user's home directory), one JSON record per line; only plain text is saved — no images, mention bindings, or other attachment content.

容量限制：持久文件约 10 MB（超限删除最旧整行，永远保留最新一条）；当前会话的局部召回列表上限 200 条 / 256 KB（从最旧淘汰）。pill 上的 × 可随时清空全部历史。
Capacity: the persistent file is capped at roughly 10 MB (oldest complete records are dropped, the newest is always kept); the current conversation's local list is capped at 200 entries / 256 KB (oldest evicted). The pill's × clears everything at any time.

## 安装 / Installation

前置条件：运行中的 DSH Web GUI 会话。
Prerequisite: a running DSH Web GUI session.

1. 读取本仓库 `plugin/host.js` 与 `plugin/client.js` 全文。
   Read the full contents of `plugin/host.js` and `plugin/client.js` in this repository.
2. 在 DSH 会话中调用 `cordis_define` 定义一个 Package，将两个文件内容分别作为 `code.host` 与 `code.client`（同一 pluginId 下可追加新版本）。
   In the DSH session, call `cordis_define` to define a Package, passing the two files as `code.host` and `code.client` (later versions append to the same pluginId).
3. 调用 `cordis_run` 激活；如弹出审批请通过。
   Activate with `cordis_run`; approve the request if prompted.
4. 历史数据写入 `<DSH 主目录>/.dsh/`；若该目录不存在，先创建：`New-Item -ItemType Directory -Force <home>/.dsh`（Windows）或 `mkdir -p ~/.dsh`（POSIX）。
   History data is written to `<DSH home>/.dsh/`; if that directory does not exist, create it first: `New-Item -ItemType Directory -Force <home>/.dsh` (Windows) or `mkdir -p ~/.dsh` (POSIX).

动态插件属于当前会话与进程：DSH 重启后按上述步骤重新 define/run 即可，历史数据不受影响。
Dynamic plugins belong to the current session and process: after a DSH restart, just re-define/re-run as above — the history data is unaffected.

## 开发 / Development

目录结构 / Layout:

- `plugin/host.js` — Host 半：JSONL 存储、提交捕获、Client RPC、只读状态工具 `hrec_status`
  Host half: JSONL storage, submission capture, Client RPC, read-only status tool `hrec_status`
- `plugin/client.js` — Client 半：按键路由、历史状态机、输入框适配、位置 pill
  Client half: key routing, history state machine, composer adapter, position pill
- `test/host.store.test.mjs` — Host 存储逻辑单测
  Host storage unit tests

运行测试 / Run tests:

```text
node --test
```

## 局限与路线 / Limitations & roadmap

- 目前只持久化纯文本；图片、mention、大粘贴的富恢复属于后续路线。
  Currently only plain text is persisted; rich recovery of images, mentions, and large pastes is on the roadmap.
- 历史作用域目前为全局；按工作区/会话隔离的可选作用域、读/写/清理独立开关属于后续路线。
  History scope is currently global; optional workspace/agent scoping and separate read/write/clear controls are on the roadmap.
- Ctrl+R 反向搜索、大文件分批读取属于后续路线。
  Ctrl+R reverse search and batched reads for very large files are on the roadmap.
