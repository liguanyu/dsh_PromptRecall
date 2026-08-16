// 存储核心单测：直接 import lib/store-core.js（纯 ESM 零依赖）。
// 运行：node --test
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore, isUserMessage, extractText, extractSig } from '../lib/store-core.js'

const memoryIo = () => {
  let content = ''
  return {
    read: async () => content,
    write: async (text) => { content = text },
    get: () => content,
  }
}

const userMessage = (text, blocks = [{ type: 'text', text }]) => ({
  id: 'm1',
  role: 'user',
  source: { kind: 'user' },
  content: blocks,
})

test('空历史 init', async () => {
  const io = memoryIo()
  const store = createStore(io)
  const r = await store.init('/ws', 's1')
  assert.equal(r.persistentCount, 0)
  assert.equal(r.localCount, 0)
  assert.equal(r.highWatermarkId, 0)
})

test('record 写入且统一索引可读', async () => {
  const io = memoryIo()
  const store = createStore(io)
  await store.init('/ws', 's1')
  const entry = await store.commit('hello world', { sessionId: 's1' })
  assert.equal(entry.id, 1)
  const hit = store.getUnified(0)
  assert.equal(hit.entry.text, 'hello world')
  assert.equal(hit.kind, 'local')
  const line = JSON.parse(io.get().trim().split('\n')[0])
  assert.equal(line.id, 1)
  assert.equal(line.text, 'hello world')
})

test('消息判别与提取: source.kind/文本/签名', () => {
  assert.equal(isUserMessage(userMessage('hi')), true)
  assert.equal(isUserMessage({ id: 's', role: 'user', source: { kind: 'plugin', plugin: 'x' }, content: [] }), false)
  assert.equal(isUserMessage({ id: 't', role: 'user', source: { kind: 'tool', callId: 'c' }, content: [] }), false)
  assert.equal(extractText(userMessage('第一个问题', [{ type: 'text', text: '第一个问题' }, { type: 'image', source: {} }])), '第一个问题')
  assert.equal(extractSig(userMessage('x', [{ type: 'text', text: 'x' }, { type: 'image' }])), 'i1')
  assert.equal(extractSig(userMessage('x')), '')
})

test('相邻重复折叠（局部），持久层保留重复', async () => {
  const io = memoryIo()
  const store = createStore(io)
  await store.init('/ws', 's1')
  await store.commit('a', { sessionId: 's1' })
  await store.commit('a', { sessionId: 's1' })
  await store.commit('b', { sessionId: 's1' })
  assert.equal(store.status().localCount, 2)
  assert.equal(store.getUnified(1).entry.text, 'b')
  assert.equal(io.get().trim().split('\n').length, 3)
})

test('同文本不同附件签名不折叠；同签名相邻才折叠', async () => {
  const io = memoryIo()
  const store = createStore(io)
  await store.init('/ws', 's1')
  await store.commit('看图', { sessionId: 's1', sig: 'i1' })
  await store.commit('看图', { sessionId: 's1', sig: '' })
  await store.commit('看图', { sessionId: 's1', sig: 'i1' })
  assert.equal(store.status().localCount, 3)
  const lines = io.get().trim().split('\n')
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[0]).sig, 'i1')
  assert.equal(JSON.parse(lines[1]).sig, '')
})

test('重启语义: 旧记录进快照；切换会话后本会话优先', async () => {
  const io = memoryIo()
  // 会话 s1 提交 a,b,c
  const s1 = createStore(io)
  await s1.init('/ws', 's1')
  await s1.commit('a', { sessionId: 's1' })
  await s1.commit('b', { sessionId: 's1' })
  await s1.commit('c', { sessionId: 's1' })
  // 重启（同文件），未指定会话：全部进快照
  const s2 = createStore(io)
  const r2 = await s2.init('/ws', null)
  assert.equal(r2.persistentCount, 3)
  assert.equal(r2.localCount, 0)
  // 会话 s2 提交 e,f
  await s2.init('/ws', 's2')
  await s2.commit('e', { sessionId: 's2' })
  await s2.commit('f', { sessionId: 's2' })
  // 回到 s1：本会话 a,b,c 重放进局部层（优先），其他会话 e,f 进快照（兜底）
  const s3 = createStore(io)
  const r3 = await s3.init('/ws', 's1')
  assert.equal(r3.persistentCount, 2)
  assert.equal(r3.localCount, 3)
  assert.equal(s3.getUnified(0).entry.text, 'e')
  assert.equal(s3.getUnified(0).kind, 'persistent')
  assert.equal(s3.getUnified(4).entry.text, 'c')
  assert.equal(s3.getUnified(4).kind, 'local')
  // 本会话新提交只出现一次且在局部末尾
  await s3.commit('d', { sessionId: 's1' })
  assert.equal(s3.status().persistentCount, 2)
  assert.equal(s3.status().localCount, 4)
  assert.equal(s3.getUnified(5).entry.text, 'd')
})

test('maxBytes 裁剪: 只删最旧整行、保留最新、ID 不重编号', async () => {
  const io = memoryIo()
  const store = createStore(io, { maxBytes: 220 })
  await store.init('/ws', 's1')
  for (let i = 1; i <= 5; i++) {
    await store.commit('x'.repeat(200) + '#' + i, { sessionId: 's1' })
  }
  const lines = io.get().trim().split('\n')
  assert.equal(lines.length, 1)
  const rec = JSON.parse(lines[0])
  assert.equal(rec.text, 'x'.repeat(200) + '#5')
  assert.equal(rec.id, 5)
})

test('局部历史字节上限：超限从最旧淘汰', async () => {
  const io = memoryIo()
  const store = createStore(io, { maxLocalBytes: 30 })
  await store.init('/ws', 's1')
  await store.commit('x'.repeat(20) + '1', { sessionId: 's1' })
  await store.commit('x'.repeat(20) + '2', { sessionId: 's1' })
  assert.equal(store.status().localCount, 1)
  assert.equal(store.getUnified(0).entry.text, 'x'.repeat(20) + '2')
})

test('clear: 清空持久层，局部保留，ID 继续单调', async () => {
  const io = memoryIo()
  const store = createStore(io)
  await store.init('/ws', 's1')
  await store.commit('a', { sessionId: 's1' })
  await store.commit('b', { sessionId: 's1' })
  await store.clear()
  assert.equal(store.status().persistentCount, 0)
  assert.equal(store.status().localCount, 2)
  assert.equal(io.get(), '')
  const c = await store.commit('c', { sessionId: 's1' })
  assert.equal(c.id, 3)
})

test('init 读盘期间提交不会被 init 重建覆盖', async () => {
  let content = ''
  let firstRead = true
  let finishFirstRead = null
  const io = {
    read: () => {
      if (firstRead) {
        firstRead = false
        return new Promise((resolve) => { finishFirstRead = () => resolve(content) })
      }
      return Promise.resolve(content)
    },
    write: async (text) => { content = text },
  }
  const store = createStore(io)
  const initing = store.init('/ws', 's1')
  const committing = store.commit('during-init', { sessionId: 's1' })
  await Promise.resolve()
  finishFirstRead()
  const [r, entry] = await Promise.all([initing, committing])
  assert.equal(r.localCount, 0)
  assert.equal(entry.id, 1)
  assert.equal(store.getUnified(0).entry.text, 'during-init')
  assert.equal(JSON.parse(content.trim().split('\n')[0]).text, 'during-init')
})

test('两个 store 实例共享文件时提交不丢失且 ID 不重复', async () => {
  let content = ''
  let chain = Promise.resolve()
  const io = {
    withLock: async (fn) => {
      const previous = chain
      let release = null
      chain = new Promise((resolve) => { release = resolve })
      await previous
      try { return await fn() } finally { release() }
    },
    read: async () => content,
    write: async (text) => { content = text },
  }
  const a = createStore(io)
  const b = createStore(io)
  await a.init('/ws', null)
  await b.init('/ws', null)
  await Promise.all([
    a.commit('from-a', { sessionId: 'sa' }),
    b.commit('from-b', { sessionId: 'sb' }),
  ])
  const lines = content.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines.map((line) => line.id).sort((x, y) => x - y), [1, 2])
  assert.deepEqual(lines.map((line) => line.text).sort(), ['from-a', 'from-b'])
})

test('get 越界返回 null', async () => {
  const store = createStore(memoryIo())
  await store.init('/ws', 's1')
  assert.equal(store.getUnified(3), null)
})

test('init 读失败：保留现有内存状态而不是清空', async () => {
  let content = ''
  let failRead = false
  const io = {
    read: async () => {
      if (failRead) throw new Error('transient read failure')
      return content
    },
    write: async (text) => { content = text },
  }
  const store = createStore(io)
  await store.init('/ws', 's1')
  await store.commit('a', { sessionId: 's1' })
  await store.commit('b', { sessionId: 's1' })
  assert.equal(store.status().total, 2)
  // 读开始失败：init 应保留 a/b 而不是清空
  failRead = true
  const r = await store.init('/ws', 's2')
  assert.equal(r.persistentCount, 0)
  assert.equal(r.localCount, 2)
  // highWatermark 只在磁盘读取成功时更新（磁盘水位仍为 0），内存记录不受影响
  assert.equal(r.highWatermarkId, 0)
  assert.equal(store.getUnified(0).entry.text, 'a')
  assert.equal(store.getUnified(1).entry.text, 'b')
})

test('写失败不中断内存 commit 与后续写入', async () => {
  let content = ''
  let failWrite = true
  const io = {
    read: async () => content,
    write: async (text) => {
      if (failWrite) throw new Error('write denied')
      content = text
    },
  }
  const store = createStore(io)
  await store.init('/ws', 's1')
  const e1 = await store.commit('first', { sessionId: 's1' })
  // 写失败：内存记录仍在，可召回
  assert.equal(e1.id, 1)
  assert.equal(store.getUnified(0).entry.text, 'first')
  assert.equal(content, '')
  // 恢复后继续提交：正常落盘且 ID 单调
  failWrite = false
  const e2 = await store.commit('second', { sessionId: 's1' })
  assert.equal(e2.id, 2)
  assert.equal(JSON.parse(content.trim().split('\n')[1]).text, 'second')
})
