// Host 存储层单测：评估 plugin/host.js 函数体 + 内存 mock fs。
// 运行：node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const hostBody = readFileSync(new URL('../plugin/host.js', import.meta.url), 'utf8')
const hostFactory = new Function('ctx', 'harness', 'console', hostBody)

const noopConsole = { log() {}, error() {} }

const createFs = () => {
  const files = new Map()
  return {
    files,
    async resolve(path) { return { key: 'fs:' + path, path } },
    async readText(target) { return files.get(target.key) ?? '' },
    async writeText(target, content) { files.set(target.key, content) },
    async listDir() { return [] },
    async stat(target) { return files.has(target.key) ? { size: files.get(target.key).length } : undefined },
  }
}

const createHarness = () => {
  const handlers = new Map()
  const tools = new Map()
  return {
    handlers,
    tools,
    handle(name, fn) { handlers.set(name, fn) },
    call(name, args) { return handlers.get(name)(args) },
    defineTool(def) { return def },
    registerTool(ctx, def) { tools.set(def.name, def) },
  }
}

const boot = (opts = {}) => {
  const fs = opts.fs ?? createFs()
  const listeners = new Map()
  const ctx = {
    get(name) {
      if (name === 'fs') return fs
      if (name === 'sandboxPolicy') return { workspaceRoot: '/ws', defaultMode: 'workspace-write' }
      if (name === 'agents') return {
        currentInitiator: () => ({ id: 'agent-1' }),
        list: () => [{ id: 'agent-1' }],
      }
      if (name === 'hrec-config') return opts.config
      return undefined
    },
    on(name, fn) { listeners.set(name, fn); return () => {} },
  }
  const harness = createHarness()
  const plugin = hostFactory(ctx, harness, noopConsole)
  plugin.apply(ctx)
  return { ctx, harness, fs, listeners, fire: (name, payload) => (listeners.get(name) || (() => {}))(payload) }
}

test('空历史 init', async () => {
  const h = boot()
  const res = await h.harness.call('history/init', {})
  assert.equal(res.ok, true)
  assert.equal(res.persistentCount, 0)
  assert.equal(res.localCount, 0)
  assert.equal(res.highWatermarkId, 0)
})

test('record 写入 JSONL 且统一索引可读', async () => {
  const h = boot()
  await h.harness.call('history/init', {})
  await h.harness.call('history/record', { text: 'hello world', sessionId: 's1' })
  const status = await h.harness.call('history/status', {})
  assert.equal(status.total, 1)
  const got = await h.harness.call('history/get', { index: 0, requestId: 7 })
  assert.equal(got.entry.text, 'hello world')
  assert.equal(got.entry.kind, 'local')
  assert.equal(got.requestId, 7)
  assert.equal(got.total, 1)
  const fileText = await h.fs.readText(await h.fs.resolve('/ws/.dsh/prompt-history.jsonl'))
  const lines = fileText.trim().split('\n')
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.id, 1)
  assert.equal(rec.text, 'hello world')
  assert.equal(rec.sessionId, 's1')
})

test('inbox 事件: 匹配 agent+source.kind 提取文本、过滤他人/steering、跳过空文本', async () => {
  const h = boot()
  await h.harness.call('history/init', { sessionId: 'agent-1' })
  h.fire('agent/inbox/inserted', {
    agent: { id: 'agent-1' },
    message: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '第一个问题' }, { type: 'image', source: {} }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 'agent-9' },
    message: { id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '别人的' }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 'agent-1' },
    message: { id: 'm3', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [{ type: 'text', text: 'steering 消息' }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 'agent-1' },
    message: { id: 'm4', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool_result' }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 'agent-1' },
    message: { id: 'm5', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', source: {} }] },
    turn: 1,
  })
  await new Promise((r) => setTimeout(r, 10))
  const status = await h.harness.call('history/status', {})
  assert.equal(status.total, 1)
  const got = await h.harness.call('history/get', { index: 0 })
  assert.equal(got.entry.text, '第一个问题')
  assert.equal(got.entry.id, 1)
  // 未上报 sessionId 时事件不记录
  const h2 = boot()
  await h2.harness.call('history/init', {})
  h2.fire('agent/inbox/inserted', {
    agent: { id: 'agent-1' },
    message: { id: 'm6', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] },
    turn: 1,
  })
  await new Promise((r) => setTimeout(r, 10))
  const status2 = await h2.harness.call('history/status', {})
  assert.equal(status2.total, 0)
})

test('相邻重复折叠（局部），持久层保留重复', async () => {
  const h = boot()
  await h.harness.call('history/init', {})
  await h.harness.call('history/record', { text: 'a', sessionId: 's1' })
  await h.harness.call('history/record', { text: 'a', sessionId: 's1' })
  await h.harness.call('history/record', { text: 'b', sessionId: 's1' })
  const status = await h.harness.call('history/status', {})
  assert.equal(status.localCount, 2)      // a, b（第二个 a 折叠）
  const got = await h.harness.call('history/get', { index: 1 })
  assert.equal(got.entry.text, 'b')
  const fileText = await h.fs.readText(await h.fs.resolve('/ws/.dsh/prompt-history.jsonl'))
  assert.equal(fileText.trim().split('\n').length, 3)  // 持久层 3 条
})

test('重启（同文件系统二次 apply）: 旧记录进入快照，新记录进入局部', async () => {
  const fs = createFs()
  const h1 = boot({ fs })
  await h1.harness.call('history/init', {})
  await h1.harness.call('history/record', { text: 'old', sessionId: 's1' })
  await h1.harness.call('history/record', { text: 'older', sessionId: 's1' })
  await h1.harness.call('history/status', {})

  const h2 = boot({ fs })
  const res = await h2.harness.call('history/init', {})
  assert.equal(res.persistentCount, 2)
  assert.equal(res.localCount, 0)
  await h2.harness.call('history/record', { text: 'new', sessionId: 's1' })
  const status = await h2.harness.call('history/status', {})
  assert.equal(status.persistentCount, 2)
  assert.equal(status.localCount, 1)
  const g0 = await h2.harness.call('history/get', { index: 0 })
  assert.equal(g0.entry.text, 'old')                 // index 0 = 最旧
  assert.equal(g0.entry.kind, 'persistent')
  const g1 = await h2.harness.call('history/get', { index: 1 })
  assert.equal(g1.entry.text, 'older')
  const g2 = await h2.harness.call('history/get', { index: 2 })
  assert.equal(g2.entry.text, 'new')
  assert.equal(g2.entry.kind, 'local')
  assert.equal(g2.entry.id, 3)
})

test('maxBytes 裁剪: 只删最旧整行、保留最新、ID 不重编号', async () => {
  const fs = createFs()
  const bootA = boot({ fs, config: { maxBytes: 220 } })   // 每条 ≈ len+96，200 字符 → ≈296 > 220
  await bootA.harness.call('history/init', {})
  for (let i = 1; i <= 5; i++) {
    await bootA.harness.call('history/record', { text: 'x'.repeat(200) + '#' + i, sessionId: 's1' })
  }
  await bootA.harness.call('history/status', {})
  const fileText = await fs.readText(await fs.resolve('/ws/.dsh/prompt-history.jsonl'))
  const lines = fileText.trim().split('\n')
  assert.equal(lines.length, 1)                       // 仅保留最新一条
  const rec = JSON.parse(lines[0])
  assert.equal(rec.text, 'x'.repeat(200) + '#5')     // 保留的是最新一条
  assert.equal(rec.id, 5)                            // ID 不重编号

  const h2 = boot({ fs, config: { maxBytes: 220 } })
  const res = await h2.harness.call('history/init', {})
  assert.equal(res.persistentCount, 1)
  const g0 = await h2.harness.call('history/get', { index: 0 })
  assert.equal(g0.entry.id, 5)
})

test('clear: 清空持久层，局部保留，ID 继续单调', async () => {
  const h = boot()
  await h.harness.call('history/init', {})
  await h.harness.call('history/record', { text: 'a', sessionId: 's1' })
  await h.harness.call('history/record', { text: 'b', sessionId: 's1' })
  await h.harness.call('history/clear', {})
  const status = await h.harness.call('history/status', {})
  assert.equal(status.persistentCount, 0)
  assert.equal(status.localCount, 2)                  // 局部保留
  const fileText = await h.fs.readText(await h.fs.resolve('/ws/.dsh/prompt-history.jsonl'))
  assert.equal(fileText, '')
  await h.harness.call('history/record', { text: 'c', sessionId: 's1' })
  const g2 = await h.harness.call('history/get', { index: 2 })
  assert.equal(g2.entry.text, 'c')
  assert.equal(g2.entry.id, 3)                        // nextId 单调（clear 后不清零）
})

test('get 越界与非法索引', async () => {
  const h = boot()
  await h.harness.call('history/init', {})
  const out = await h.harness.call('history/get', { index: 3 })
  assert.equal(out.ok, true)
  assert.equal(out.entry, null)
  const bad = await h.harness.call('history/get', { index: 'x' })
  assert.equal(bad.ok, false)
})

test('跨会话: 回到本会话时本会话条目优先（Codex 当前 thread 优先）', async () => {
  const fs = createFs()
  const h = boot({ fs })
  // 会话 s1 提交 a,b,c
  await h.harness.call('history/init', { sessionId: 's1' })
  await h.harness.call('history/record', { text: 'a', sessionId: 's1' })
  await h.harness.call('history/record', { text: 'b', sessionId: 's1' })
  await h.harness.call('history/record', { text: 'c', sessionId: 's1' })
  // 切到会话 s2 提交 e,f
  await h.harness.call('history/init', { sessionId: 's2' })
  await h.harness.call('history/record', { text: 'e', sessionId: 's2' })
  await h.harness.call('history/record', { text: 'f', sessionId: 's2' })
  // 回到 s1：本会话 a,b,c 重放进局部层（优先），其他会话 e,f 进快照（兜底）
  const res = await h.harness.call('history/init', { sessionId: 's1' })
  assert.equal(res.persistentCount, 2)   // 其他会话 e,f
  assert.equal(res.localCount, 3)        // 本会话 a,b,c
  const g0 = await h.harness.call('history/get', { index: 0 })
  assert.equal(g0.entry.text, 'e')
  assert.equal(g0.entry.kind, 'persistent')
  const g2 = await h.harness.call('history/get', { index: 2 })
  assert.equal(g2.entry.text, 'a')
  assert.equal(g2.entry.kind, 'local')
  const g4 = await h.harness.call('history/get', { index: 4 })
  assert.equal(g4.entry.text, 'c')       // ↑ 最新 = 本会话 c（当前对话优先）
  assert.equal(g4.entry.kind, 'local')
  // 本会话新提交仍只出现一次且在局部层末尾
  await h.harness.call('history/record', { text: 'd', sessionId: 's1' })
  const s = await h.harness.call('history/status', {})
  assert.equal(s.persistentCount, 2)
  assert.equal(s.localCount, 4)
  const g5 = await h.harness.call('history/get', { index: 5 })
  assert.equal(g5.entry.text, 'd')
})

test('同文本不同附件签名不折叠；同签名相邻才折叠', async () => {
  const h = boot()
  await h.harness.call('history/init', { sessionId: 's1' })
  h.fire('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', source: {} }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }] },
    turn: 1,
  })
  h.fire('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', source: {} }] },
    turn: 1,
  })
  await new Promise((r) => setTimeout(r, 10))
  // m1(sig i1) / m2(sig '') 不同 → 不折叠；m3 与 m2 签名不同 → 不折叠
  const status = await h.harness.call('history/status', {})
  assert.equal(status.localCount, 3)
  // 再来一条与 m3 完全相同（含附件）→ 与上一条相邻且签名相同 → 折叠
  h.fire('agent/inbox/inserted', {
    agent: { id: 's1' },
    message: { id: 'm4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', source: {} }] },
    turn: 1,
  })
  await new Promise((r) => setTimeout(r, 10))
  const status2 = await h.harness.call('history/status', {})
  assert.equal(status2.localCount, 3)
  // 持久层保留全部 4 条，且 sig 写入文件
  const fileText = await h.fs.readText(await h.fs.resolve('/ws/.dsh/prompt-history.jsonl'))
  const lines = fileText.trim().split('\n')
  assert.equal(lines.length, 4)
  assert.equal(JSON.parse(lines[0]).sig, 'i1')
  assert.equal(JSON.parse(lines[1]).sig, '')
})

test('局部历史字节上限：超限从最旧淘汰', async () => {
  const h = boot({ config: { maxLocalBytes: 30 } })
  await h.harness.call('history/init', { sessionId: 's1' })
  await h.harness.call('history/record', { text: 'x'.repeat(20) + '1', sessionId: 's1' })  // 21 字节
  await h.harness.call('history/record', { text: 'x'.repeat(20) + '2', sessionId: 's1' })  // 共 42 → 淘汰最旧
  const status = await h.harness.call('history/status', {})
  assert.equal(status.localCount, 1)
  const g = await h.harness.call('history/get', { index: 0 })
  assert.equal(g.entry.text, 'x'.repeat(20) + '2')
})

test('record 空文本拒绝', async () => {
  const h = boot()
  await h.harness.call('history/init', {})
  const res = await h.harness.call('history/record', { text: '   ' })
  assert.equal(res.ok, false)
})
