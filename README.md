# dsh_PromptRecall

仿 Codex 的 DSH Web GUI 输入历史插件：在会话输入框按 `↑`/`↓` 浏览历史 prompt，历史跨会话、跨重启持久保留。
A Codex-style input-history plugin for the DSH Web GUI: browse previous prompts with `↑`/`↓` in the session composer, with history persisted across conversations and restarts.

## 特性 / Features

- **↑ 召回历史，↓ 向新移动**：空输入框按 ↑ 从最新条目开始逆序浏览，↓ 向新移动，越过最新项后清空输入框并退出浏览。
- **当前对话优先**：回到一个对话时，先召回该对话自己的历史，继续按 ↑ 才进入其他对话的历史。
- **跨会话、跨重启持久**：用户级 JSONL 全局历史，稳定单调 ID，刷新页面或重启后仍可召回。
- **安全的按键路由**：非空草稿、多行正文中间、有选区、弹窗打开时，方向键一律交还编辑器，绝不误伤草稿。
- **Esc 草稿保险**：清空未发送的非空草稿时把它存入历史（仅文本），按 ↑ 可找回。
- **位置指示**：输入框上方 pill 显示当前位置（如 `↑ 2/38`）；pill 上的 × 两次点击可清空全部历史。
- **仅存文本 + 自动裁剪**：只持久化纯文本；相邻完全相同的条目折叠；文件超限时删除最旧整行并保留最新。


**↑ recalls, ↓ moves forward**: an empty composer starts browsing from the newest entry; ↓ moves toward newer entries, and moving past the newest one clears the composer and exits browsing.
**Current conversation first**: returning to a conversation recalls that conversation's own history first; pressing ↑ further walks into other conversations' history.
**Persistent across conversations and restarts**: a user-level JSONL history with stable monotonic IDs remains recallable after page reloads and restarts.
**Safe key routing**: with a non-empty draft, a caret in the middle of multi-line text, an active selection, or an open popup, arrow keys are handed back to the editor and never overwrite a draft.
**Esc draft insurance**: clearing an unsent non-empty draft stores it in the history (text only) so ↑ can bring it back.
**Position indicator**: a pill above the composer shows the current position (e.g. `↑ 2/38`); clicking its × twice clears all history.
**Text-only storage with auto-trim**: only plain text is persisted; adjacent identical entries are folded; oversized files drop the oldest complete records while keeping the newest.

## 设计 / Design

历史分两层：**持久层**（跨会话 JSONL 文件，只存文本）与**局部层**（当前会话的召回列表，含 Esc 暂存草稿）。
进入或切回一个会话时冻结快照：快照只含**其他会话**的记录，本会话的记录播种进局部层，因此统一索引的顺序是 `[其他会话记录 | 本会话记录]`。
示例：会话 A 依次输入 a、b、c，切到会话 B 输入 e、f，再切回 A 后按 ↑ 的顺序是 `c → b → a → f → e`（当前对话优先，全局兜底）。
每条记录带**稳定单调 ID**，裁剪只删最旧整行、不重编号；本会话新提交只出现在局部层，因此每条恰好出现一次；局部层相邻且完全相同的条目（文本+会话+附件签名）折叠，持久层保留重复记录。


History has two layers: a **persistent layer** (the cross-conversation JSONL file, text only) and a **local layer** (the current conversation's recall list, including Esc-stashed drafts).
Entering or returning to a conversation freezes a snapshot: the snapshot keeps only **other conversations'** records, while this conversation's records are seeded into the local layer — the unified index order is `[other conversations | this conversation]`.
Example: conversation A submits a, b, c; conversation B submits e, f; back in A, ↑ recalls `c → b → a → f → e` (current conversation first, global history as fallback).
Every record carries a **stable monotonic ID**; trimming deletes only the oldest complete records and never renumbers. New submissions in the current conversation appear only in the local layer, so every entry appears exactly once. Adjacent identical entries in the local layer (text + conversation + attachment signature) are folded, while the persistent layer keeps duplicates.

## 键位与交互逻辑 / Keybindings & interaction logic

| 按键 | 行为 |
|---|---|
| `↑`（空草稿） | 进入历史浏览，从最新条目开始 |
| `↑` / `↓`（浏览中） | 向旧 / 向新移动；最旧处不回绕 |
| `↓`（最新项再按） | 清空输入框并退出浏览 |
| `↑`/`↓`（非空草稿、正文中间、有选区、弹窗打开） | 交还编辑器，只移动光标/候选 |
| `Esc`（非空草稿） | 清空草稿并存入历史（↑ 可找回） |
| `Esc`（浏览中） | 退出浏览；草稿为空时不做任何事 |

鼠标操作（非键盘）/ Mouse actions (not keyboard):
| 操作 | 行为 |
|---|---|
| 点击 pill 上的 `×` 两次（3 秒内） | 第一次点击变"确认?"，第二次清空全部历史（含持久文件） |

接管判定：按键目标必须是会话输入框；只有"语义空"草稿（文本、附件、mention 全空）按 ↑ 才进入浏览；浏览中一旦用户改动文本或附件，立即退出接管并作废在途请求；弹窗或命令菜单消费过的按键自动让位。



| Key | Behavior |
|---|---|
| `↑` (empty draft) | Start browsing history from the newest entry |
| `↑` / `↓` (browsing) | Move older / newer; no wrap at the oldest end |
| `↓` (past the newest) | Clear the composer and exit browsing |
| `↑`/`↓` (non-empty draft, mid-text, selection, popup open) | Handed back to the editor: move the caret / candidates only |
| `Esc` (non-empty draft) | Clear the draft and store it in history (recoverable with ↑) |
| `Esc` (browsing) | Exit browsing; no-op when the draft is empty |

| Action | Behavior |
|---|---|
| Click the pill's `×` twice (within 3 s) | The first click arms "confirm?", the second clears all history (including the persistent file) |

Takeover rules: the key target must be the conversation composer; browsing starts with ↑ only on a semantically empty draft (no text, attachments, or mentions); any user edit to the text or attachments while browsing immediately releases the takeover and invalidates in-flight requests; keys already consumed by a popup or command menu are always left alone.

## 数据与隐私 / Data & privacy

历史写入 DSH 主目录下的 `prompt-history.jsonl`（即 `$DSH_HOME/prompt-history.jsonl`；未设置 `DSH_HOME` 时默认 `~/.dsh/prompt-history.jsonl`），每行一条 JSON 记录；只保存纯文本，不保存图片、mention 绑定或其他附件内容。
容量限制：持久文件约 10 MB（超限删除最旧整行，永远保留最新一条）；当前会话的局部召回列表上限 200 条 / 256 KB（从最旧淘汰）。pill 上的 × 可随时清空全部历史。


History is written to `prompt-history.jsonl` under the DSH home directory (`$DSH_HOME/prompt-history.jsonl`; default `~/.dsh/prompt-history.jsonl` when `DSH_HOME` is unset), one JSON record per line; only plain text is saved — no images, mention bindings, or other attachment content.
Capacity: the persistent file is capped at roughly 10 MB (oldest complete records are dropped, the newest is always kept); the current conversation's local list is capped at 200 entries / 256 KB (oldest evicted). The pill's × clears everything at any time.

## 安装 / Installation

前置条件：已安装 `pnpm` 的 DSH 环境（`dsh plugin` 内部转发给 pnpm）。

**从 GitHub 安装：**

```bash
dsh plugin --profile web add github:liguanyu/dsh_PromptRecall
```

**本地安装：**

```bash
git clone https://github.com/liguanyu/dsh_PromptRecall
cd dsh_PromptRecall
pnpm install          # link 安装沿仓库真实路径解析依赖，需先在仓库内安装
dsh plugin --profile web add .
```

本地安装使用 pnpm 的 `link:` 协议（改代码后重启即生效，无需重装）；由于 Node 会解析链接的真实路径，请先 `pnpm install` 一次，让仓库内具备运行时依赖。`github:` 安装无需此步骤（依赖随包装入 profile 树）。

安装后重启 DSH Web（`dsh web`）即可生效；插件成为 web 组合中的一行，随启动自动加载，无需任何手动 define/run 步骤。

历史数据写入 `$DSH_HOME/prompt-history.jsonl`（默认 `~/.dsh/prompt-history.jsonl`）；目录不存在时会在首次写入时自动创建，无需手动准备。




Prerequisite: a DSH environment with `pnpm` installed (`dsh plugin` forwards to pnpm internally).

**Install from GitHub:**

```bash
dsh plugin --profile web add github:liguanyu/dsh_PromptRecall
```

**Install locally:**

```bash
git clone https://github.com/liguanyu/dsh_PromptRecall
cd dsh_PromptRecall
pnpm install          # link installs resolve dependencies via the repo's real path; run install in the repo first
dsh plugin --profile web add .
```

Local installs use pnpm's `link:` protocol (code edits take effect on restart without reinstalling); because Node resolves the link's real path, run `pnpm install` once so the repository has its runtime dependencies. `github:` installs need no such step (dependencies are installed into the profile tree with the package).

After installation, restart DSH Web (`dsh web`) to activate; the plugin becomes a row of the web composition, loads automatically at boot, and needs no manual define/run steps.

History data is written to `$DSH_HOME/prompt-history.jsonl` (default `~/.dsh/prompt-history.jsonl`); the directory is created automatically on first write, so no manual setup is needed.

## 开发 / Development

目录结构 / Layout:

- `lib/index.js` — Host 半：`promptRecall` Remote 服务（JSONL 存储 + inbox 提交捕获）
- `lib/store-core.js` — 纯存储核心（两层历史/折叠/裁剪，零依赖可单测）
- `lib/typert.host.js` — 手写的 typert 宿主面（网关校验与派发）
- `lib/client.js` — Client 半：按键路由、历史状态机、位置 pill
- `cordis.patch.yml` — bundle patch：把插件行插入 web 组合
- `test/store-core.test.mjs` — 存储核心单测（`node --test`）


- `lib/index.js` — Host half: the `promptRecall` Remote service (JSONL storage + inbox submission capture)
- `lib/store-core.js` — Pure storage core (two-layer history / folding / trimming, dependency-free and unit-testable)
- `lib/typert.host.js` — Hand-written typert host face (gateway validation and dispatch)
- `lib/client.js` — Client half: key routing, history state machine, position pill
- `cordis.patch.yml` — Bundle patch: inserts the plugin row into the web composition
- `test/store-core.test.mjs` — Storage core unit tests (`node --test`)

运行测试 / Run tests:

```text
node --test
```

## 局限与路线 / Limitations & roadmap

- 目前只持久化纯文本；图片、mention、大粘贴的富恢复属于后续路线。
- 历史作用域目前为全局；按工作区/会话隔离的可选作用域、读/写/清理独立开关属于后续路线。
- Ctrl+R 反向搜索、大文件分批读取属于后续路线。

- Currently only plain text is persisted; rich recovery of images, mentions, and large pastes is on the roadmap.
- History scope is currently global; optional workspace/agent scoping and separate read/write/clear controls are on the roadmap.
- Ctrl+R reverse search and batched reads for very large files are on the roadmap.
