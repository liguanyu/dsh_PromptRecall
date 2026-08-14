// 纯存储核心：零外部依赖，可在 Node 单测与宿主服务中复用。
// 两层历史语义（当前会话优先）：
// - 持久层: 稳定单调 historyId 的记录序列（JSONL 由宿主 io 落盘）。
// - 进入/切回会话时冻结快照：snapshot = 其他会话记录，local = 本会话记录（重放 + 新提交）。
// - 局部层相邻完整相等（文本+会话+附件签名）折叠；持久层保留重复。
// - 裁剪只删最旧整行、不重编号、保留最新；局部层条目数+字节双上限。

export const isUserMessage = (msg) => msg !== undefined && msg !== null && typeof msg === 'object'
  && msg.role === 'user'
  && msg.source !== undefined && msg.source !== null && typeof msg.source === 'object'
  && msg.source.kind === 'user'

export const extractText = (message) => {
  if (message === undefined || message === null) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let out = ''
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        out = out === '' ? block.text : out + '\n' + block.text
      }
    }
    return out
  }
  return ''
}

// 附件/富元素签名：非文本块计数（折叠判定用）。
export const extractSig = (message) => {
  if (message === undefined || message === null || !Array.isArray(message.content)) return ''
  let n = 0
  for (const block of message.content) {
    if (block && typeof block === 'object' && block.type !== 'text') n += 1
  }
  return n > 0 ? 'i' + n : ''
}

const serialize = (r) => JSON.stringify({
  v: 1, id: r.id, sid: r.sid, sessionId: r.sessionId, ts: r.ts, scope: r.scope, sig: r.sig || '', text: r.text,
})

const parseRecord = (rec) => rec && typeof rec === 'object' && typeof rec.id === 'number' && typeof rec.text === 'string'
  ? { id: rec.id, sid: rec.sid, sessionId: rec.sessionId, ts: rec.ts, scope: rec.scope, sig: rec.sig || '', text: rec.text }
  : null

export function createStore(io, options = {}) {
  const MAX_BYTES = typeof options.maxBytes === 'number' ? options.maxBytes : 10 * 1024 * 1024
  const TRIM_FACTOR = 0.8
  const MAX_LOCAL_ENTRIES = typeof options.maxLocalEntries === 'number' ? options.maxLocalEntries : 200
  const MAX_LOCAL_BYTES = typeof options.maxLocalBytes === 'number' ? options.maxLocalBytes : 256 * 1024

  const store = {
    snapshot: [],        // 冻结的【其他会话】记录（id 升序；未指定会话时为全部）
    local: [],           // 本会话记录：重放 + 新提交
    fileRecords: [],     // 文件内容 = 全部记录
    highWatermark: 0,
    nextId: 1,
    writeQueue: Promise.resolve(),
    scope: '',
  }

  const writeFile = async () => {
    const lines = store.fileRecords.map(serialize)
    await io.write(lines.length ? lines.join('\n') + '\n' : '')
  }

  const approxBytes = () => store.fileRecords.reduce((n, r) => n + r.text.length + 96, 0)

  const trimFile = () => {
    while (approxBytes() > MAX_BYTES && store.fileRecords.length > 1) {
      store.fileRecords.shift()
      if (approxBytes() <= MAX_BYTES * TRIM_FACTOR) break
    }
  }

  const localBytes = () => store.local.reduce((n, e) => n + e.text.length, 0)
  const trimLocal = () => {
    while (store.local.length > MAX_LOCAL_ENTRIES || (store.local.length > 1 && localBytes() > MAX_LOCAL_BYTES)) {
      store.local.shift()
    }
  }

  const init = async (scopeKey, forSessionId) => {
    const scope = forSessionId === undefined ? null : forSessionId
    await store.writeQueue
    store.scope = scopeKey || ''
    let text = ''
    try {
      text = await io.read()
    } catch (err) {
      text = ''
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const rec = parseRecord(JSON.parse(line))
        if (rec !== null) records.push(rec)
      } catch (err) { /* 跳过坏行 */ }
    }
    records.sort((a, b) => a.id - b.id)
    store.fileRecords = records.slice()
    // 冻结语义：scope 为空 → 快照=全部；否则快照只含其他会话，本会话按 id 序播种进局部层。
    store.snapshot = scope === null ? records : records.filter((r) => r.sessionId !== scope)
    store.local = []
    if (scope !== null) {
      for (const r of records) {
        if (r.sessionId !== scope) continue
        const last = store.local[store.local.length - 1]
        if (last !== undefined && last.text === r.text && last.sessionId === r.sessionId && (last.sig || '') === (r.sig || '')) continue
        store.local.push(r)
        trimLocal()
      }
    }
    store.highWatermark = records.length ? records[records.length - 1].id : 0
    store.nextId = store.highWatermark + 1
    return {
      persistentCount: store.snapshot.length,
      localCount: store.local.length,
      highWatermarkId: store.highWatermark,
    }
  }

  const commit = (text, meta) => {
    const entry = {
      id: 0, // commitEntry 时分配
      sid: meta && meta.sid !== undefined ? meta.sid : null,
      sessionId: meta && meta.sessionId !== undefined ? meta.sessionId : null,
      sig: meta && typeof meta.sig === 'string' ? meta.sig : '',
      ts: Date.now(),
      scope: store.scope,
      text,
    }
    const commitEntry = (e) => {
      e.id = store.nextId++
      const last = store.local[store.local.length - 1]
      const isDup = last !== undefined && last.text === e.text && last.sessionId === e.sessionId
        && (last.sig || '') === (e.sig || '')
      if (!isDup) {
        store.local.push(e)
        trimLocal()
      }
      store.fileRecords.push(e)
      trimFile()
      store.writeQueue = store.writeQueue.then(writeFile).catch((err) => {
        console.error('[prompt-recall] persist failed:', String(err && err.message))
      })
      return e
    }
    return commitEntry(entry)
  }

  const getUnified = (index) => {
    if (index < store.snapshot.length) return { entry: store.snapshot[index], kind: 'persistent' }
    const li = index - store.snapshot.length
    if (li < store.local.length) return { entry: store.local[li], kind: 'local' }
    return null
  }

  const clear = async () => {
    await store.writeQueue
    store.snapshot = []
    store.fileRecords = []
    store.highWatermark = 0
    try {
      await io.write('')
    } catch (err) {
      console.error('[prompt-recall] clear failed:', String(err && err.message))
    }
  }

  return {
    init,
    commit,
    getUnified,
    clear,
    status: () => ({
      persistentCount: store.snapshot.length,
      localCount: store.local.length,
      total: store.snapshot.length + store.local.length,
    }),
    snapshot: () => store,
  }
}
