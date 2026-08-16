// 纯存储核心：零外部依赖，可在 Node 单测与宿主服务中复用。
// 两层历史语义（当前会话优先）：
// - 持久层: 稳定单调 historyId 的记录序列（JSONL 由宿主 io 落盘）。
// - 进入/切回会话时冻结快照：snapshot = 其他会话记录，local = 本会话记录（重放 + 新提交）。
// - 局部层相邻完整相等（文本+会话+附件签名）折叠；持久层保留重复。
// - 裁剪只删最旧整行、不重编号、保留最新；局部层条目数+字节双上限。
// - 所有会改变内存状态的 init/commit/clear 通过同一个队列串行执行；
//   落盘时通过 io.withLock 串行化跨进程的读-改-写。

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

const decodeRecords = (text) => {
  const records = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const rec = parseRecord(JSON.parse(line))
      if (rec !== null) records.push(rec)
    } catch (err) { /* 跳过坏行 */ }
  }
  records.sort((a, b) => a.id - b.id)
  return records
}

const sameRecord = (a, b) => a !== undefined && b !== undefined && a.id === b.id
  && a.text === b.text && a.sessionId === b.sessionId && (a.sig || '') === (b.sig || '')
const sameLocal = (a, b) => a !== undefined && b !== undefined
  && a.text === b.text && a.sessionId === b.sessionId && (a.sig || '') === (b.sig || '')

export function createStore(io, options = {}) {
  const MAX_BYTES = typeof options.maxBytes === 'number' ? options.maxBytes : 10 * 1024 * 1024
  const TRIM_FACTOR = 0.8
  const MAX_LOCAL_ENTRIES = typeof options.maxLocalEntries === 'number' ? options.maxLocalEntries : 200
  const MAX_LOCAL_BYTES = typeof options.maxLocalBytes === 'number' ? options.maxLocalBytes : 256 * 1024

  const store = {
    snapshot: [],        // 冻结的【其他会话】记录（id 升序；未指定会话时为全部）
    local: [],           // 本会话记录：重放 + 新提交
    fileRecords: [],     // 最近一次计算的完整文件内容
    highWatermark: 0,
    nextId: 1,
    queue: Promise.resolve(),
    scope: '',
    unsynced: new Map(), // 已分配 ID、但尚未确认写入磁盘的记录
  }

  const withLock = (fn) => {
    if (io !== undefined && io !== null && typeof io.withLock === 'function') return io.withLock(fn)
    return fn()
  }

  const approxBytes = (records) => records.reduce((n, r) => n + r.text.length + 96, 0)

  const trimPersistent = (records) => {
    const next = records.slice()
    while (approxBytes(next) > MAX_BYTES && next.length > 1) {
      next.shift()
      if (approxBytes(next) <= MAX_BYTES * TRIM_FACTOR) break
    }
    return next
  }

  const localBytes = () => store.local.reduce((n, e) => n + e.text.length, 0)
  const trimLocal = () => {
    while (store.local.length > MAX_LOCAL_ENTRIES || (store.local.length > 1 && localBytes() > MAX_LOCAL_BYTES)) {
      store.local.shift()
    }
  }

  const enqueue = (task) => {
    const run = store.queue.then(task)
    store.queue = run.then(() => undefined, () => undefined)
    return run
  }

  const allocateEntry = (entry) => {
    entry.id = store.nextId++
    const last = store.local[store.local.length - 1]
    if (!sameLocal(last, entry)) {
      store.local.push(entry)
      trimLocal()
    }
    store.unsynced.set(entry.id, entry)
    store.fileRecords.push(entry)
    return entry
  }

  // 以磁盘内容为准整理待写记录：磁盘已包含的同 ID 记录视为已持久化；
  // 同 ID 但内容不同的记录（只可能来自此前未确认的写入与其他进程撞号）
  // 重新分配本地 ID，避免覆盖别的进程已经落盘的内容。
  const reconcileUnsynced = (diskRecords) => {
    const diskById = new Map()
    for (const r of diskRecords) diskById.set(r.id, r)
    const diskMax = diskRecords.length > 0 ? diskRecords[diskRecords.length - 1].id : 0
    store.nextId = Math.max(store.nextId, diskMax + 1)

    const next = new Map()
    for (const rec of [...store.unsynced.values()].sort((a, b) => a.id - b.id)) {
      const disk = diskById.get(rec.id)
      if (disk !== undefined && sameRecord(disk, rec)) continue
      if (disk !== undefined) rec.id = store.nextId++
      next.set(rec.id, rec)
    }
    store.unsynced = next
  }

  const buildFileRecords = (diskRecords) => {
    const byId = new Map()
    for (const r of diskRecords) byId.set(r.id, r)
    for (const rec of store.unsynced.values()) byId.set(rec.id, rec)
    const records = [...byId.values()].sort((a, b) => a.id - b.id)
    const file = trimPersistent(records)
    const keep = new Set(file.map((r) => r.id))
    for (const id of [...store.unsynced.keys()]) {
      if (!keep.has(id)) store.unsynced.delete(id)
    }
    return file
  }

  const currentCounts = () => ({
    persistentCount: store.snapshot.length,
    localCount: store.local.length,
    highWatermarkId: store.highWatermark,
  })

  const init = (scopeKey, forSessionId) => enqueue(async () => {
    const scope = forSessionId === undefined ? null : forSessionId
    store.scope = scopeKey || ''
    let text = ''
    let readOk = false
    try {
      text = await io.read()
      readOk = true
    } catch (err) {
      text = ''
    }
    // 读失败时保留现有内存状态（fileRecords/snapshot/local/水位都不动）。
    if (!readOk) return currentCounts()

    const diskRecords = decodeRecords(text)
    const diskMax = diskRecords.length > 0 ? diskRecords[diskRecords.length - 1].id : 0
    reconcileUnsynced(diskRecords)
    const records = [...diskRecords]
    for (const rec of store.unsynced.values()) records.push(rec)
    records.sort((a, b) => a.id - b.id)

    store.fileRecords = trimPersistent(records)
    const fileIds = new Set(store.fileRecords.map((r) => r.id))
    for (const id of [...store.unsynced.keys()]) {
      if (!fileIds.has(id)) store.unsynced.delete(id)
    }
    store.snapshot = scope === null ? records : records.filter((r) => r.sessionId !== scope)
    store.local = []
    if (scope !== null) {
      for (const r of records) {
        if (r.sessionId !== scope) continue
        const last = store.local[store.local.length - 1]
        if (!sameLocal(last, r)) {
          store.local.push(r)
          trimLocal()
        }
      }
    }
    store.highWatermark = diskMax
    const unsyncedMax = store.unsynced.size > 0 ? [...store.unsynced.values()].reduce((n, r) => Math.max(n, r.id), 0) : 0
    store.nextId = Math.max(diskMax + 1, unsyncedMax + 1)
    return currentCounts()
  })

  const commit = (text, meta) => enqueue(async () => {
    const entry = {
      id: 0,
      sid: meta && meta.sid !== undefined ? meta.sid : null,
      sessionId: meta && meta.sessionId !== undefined ? meta.sessionId : null,
      sig: meta && typeof meta.sig === 'string' ? meta.sig : '',
      ts: Date.now(),
      scope: store.scope,
      text,
    }
    try {
      await withLock(async () => {
        const diskRecords = decodeRecords(await io.read())
        reconcileUnsynced(diskRecords)
        allocateEntry(entry)
        const file = buildFileRecords(diskRecords)
        store.fileRecords = file
        await io.write(file.length ? file.map(serialize).join('\n') + '\n' : '')
        store.unsynced.clear()
      })
    } catch (err) {
      if (entry.id === 0) allocateEntry(entry)
      console.error('[prompt-recall] persist failed:', String(err && err.message))
    }
    return entry
  })

  const getUnified = (index) => {
    if (index < store.snapshot.length) return { entry: store.snapshot[index], kind: 'persistent' }
    const li = index - store.snapshot.length
    if (li < store.local.length) return { entry: store.local[li], kind: 'local' }
    return null
  }

  const clear = () => enqueue(async () => {
    store.snapshot = []
    store.fileRecords = []
    store.highWatermark = 0
    store.unsynced.clear()
    try {
      await withLock(async () => {
        await io.write('')
      })
    } catch (err) {
      console.error('[prompt-recall] clear failed:', String(err && err.message))
    }
  })

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
