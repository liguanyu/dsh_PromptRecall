// Host 半：输入历史存储（JSONL 持久层 + 会话局部层）+ 提交事件捕获 + Client RPC。
// 本文件内容即 cordis_define code.host 的函数体（自由变量: ctx, harness, console）。
//
// 设计要点：
// - 持久层: JSONL，稳定单调 historyId，裁剪只删最旧整行、不重编号、保留最新一条。
// - 切换/进入会话时冻结快照：快照只含【其他会话】记录，本会话记录播种进局部层
//   → 当前对话优先召回，且每条只出现一次（sessionId 精确分区）。
// - 局部层: 相邻且完全相同的条目折叠（文本+会话+附件签名）；持久层保留重复记录；
//   双上限 200 条 / 256KB，从最旧淘汰。
// - 写入串行化 + 原子替换；读失败视为空历史。
return {
  apply(ctx) {
    const fs = ctx.get('fs')
    const agents = ctx.get('agents')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (fs === undefined || sandboxPolicy === undefined) {
      console.error('[hrec] host needs fs + sandboxPolicy services; store disabled')
      return
    }

    const config = ctx.get('hrec-config') || {}
    const MAX_BYTES = typeof config.maxBytes === 'number' ? config.maxBytes : 10 * 1024 * 1024
    const TRIM_FACTOR = 0.8
    const MAX_LOCAL_ENTRIES = 200
    const MAX_LOCAL_BYTES = typeof config.maxLocalBytes === 'number' ? config.maxLocalBytes : 256 * 1024

    const root = sandboxPolicy.workspaceRoot
    const filePath = root + '/.dsh/prompt-history.jsonl'

    const store = {
      snapshot: [],        // 激活时冻结的持久前缀（id 升序）
      local: [],           // 激活后本会话新提交（P0 文本版；富草稿 P1）
      fileRecords: [],     // 文件内容 = snapshot + 激活后新记录
      highWatermark: 0,
      nextId: 1,
      writeQueue: Promise.resolve(),
      scope: root,
    }

    const serialize = (r) => JSON.stringify({
      v: 1, id: r.id, sid: r.sid, sessionId: r.sessionId, ts: r.ts, scope: r.scope, sig: r.sig || '', text: r.text,
    })

    const writeFile = async () => {
      const lines = store.fileRecords.map(serialize)
      const target = await fs.resolve(filePath)
      await fs.writeText(target, lines.length ? lines.join('\n') + '\n' : '')
    }

    // 近似字节数：裁剪只删最旧整行，保留最新一行，不重编号
    const approxBytes = () => store.fileRecords.reduce((n, r) => n + r.text.length + 96, 0)

    const trimFile = () => {
      while (approxBytes() > MAX_BYTES && store.fileRecords.length > 1) {
        store.fileRecords.shift()
        if (approxBytes() <= MAX_BYTES * TRIM_FACTOR) break
      }
    }

    // 局部层淘汰：条目数与字节数双上限，从最旧条目开始删除
    const localBytes = () => store.local.reduce((n, e) => n + e.text.length, 0)
    const trimLocal = () => {
      while (store.local.length > MAX_LOCAL_ENTRIES || (store.local.length > 1 && localBytes() > MAX_LOCAL_BYTES)) {
        store.local.shift()
      }
    }

    const init = async (forSessionId) => {
      const scope = forSessionId === undefined ? null : forSessionId
      await store.writeQueue
      let text = ''
      try {
        text = await fs.readText(await fs.resolve(filePath))
      } catch (err) {
        text = ''
      }
      const records = []
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        try {
          const rec = JSON.parse(line)
          if (rec && typeof rec === 'object' && typeof rec.id === 'number' && typeof rec.text === 'string') {
            records.push({ id: rec.id, sid: rec.sid, sessionId: rec.sessionId, ts: rec.ts, scope: rec.scope, sig: rec.sig || '', text: rec.text })
          }
        } catch (err) { /* 跳过坏行 */ }
      }
      records.sort((a, b) => a.id - b.id)
      store.fileRecords = records.slice()
      // 冻结语义（当前会话优先）：
      // - scope 为空（激活窗口/未上报会话）→ 快照 = 全部记录，局部为空；
      // - scope 非空 → 快照只含【其他会话】记录（冻结），本会话记录按 id 序播种进局部层
      //   （stable sessionId 精确分区，无重复，不依赖文本匹配）。
      store.snapshot = scope === null ? records : records.filter((r) => r.sessionId !== scope)
      store.local = []
      if (scope !== null) {
        for (const r of records) {
          if (r.sessionId !== scope) continue
          const last = store.local[store.local.length - 1]
          // 相邻折叠：完整条目相等（文本 + 会话 + 附件签名）才折叠
          if (last !== undefined && last.text === r.text && last.sessionId === r.sessionId && (last.sig || '') === (r.sig || '')) continue
          store.local.push(r)
          trimLocal()
        }
      }
      store.highWatermark = records.length ? records[records.length - 1].id : 0
      store.nextId = store.highWatermark + 1
    }

    const commitEntry = (entry) => {
      entry.id = store.nextId++
      const last = store.local[store.local.length - 1]
      const isDup = last !== undefined && last.text === entry.text && last.sessionId === entry.sessionId
        && (last.sig || '') === (entry.sig || '')
      if (!isDup) {
        store.local.push(entry)
        trimLocal()
      }
      store.fileRecords.push(entry)
      trimFile()
      store.writeQueue = store.writeQueue.then(writeFile).catch((err) => {
        console.error('[hrec] persist failed:', String(err && err.message))
      })
      return entry
    }

    // init 完成前到达的提交先入缓冲，避免与快照读取竞态
    let ready = false
    let pendingBuffer = []

    const record = (text, meta) => {
      const entry = {
        id: 0, // commitEntry 时按 nextId 分配
        sid: meta && meta.sid !== undefined ? meta.sid : null,
        sessionId: meta && meta.sessionId !== undefined ? meta.sessionId : null,
        sig: meta && typeof meta.sig === 'string' ? meta.sig : '',
        ts: Date.now(),
        scope: store.scope,
        text,
      }
      if (ready) return commitEntry(entry)
      pendingBuffer.push(entry)
      return entry
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
        const target = await fs.resolve(filePath)
        await fs.writeText(target, '')
      } catch (err) {
        console.error('[hrec] clear failed:', String(err && err.message))
      }
    }

    // ---- 提交捕获: agent/inbox/inserted ----
    // 会话身份由 Client 在 history/init 时上报（currentInitiator 在插件上下文中不可靠），
    // 事件按 agent.id 过滤。真实用户消息的判别是 source.kind === 'user'
    // （steering/tool 结果等消息虽然 role 也是 'user'，但 source.kind 不同）。
    let sessionFilter = null

    const isUserMessage = (msg) => msg !== undefined && msg !== null && typeof msg === 'object'
      && msg.role === 'user'
      && msg.source !== undefined && msg.source !== null && typeof msg.source === 'object'
      && msg.source.kind === 'user'

    const extractText = (message) => {
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

    // 附件/富元素签名：非文本块计数。折叠判定用（同文本但附件不同 → 不同局部条目）。
    const extractSig = (message) => {
      if (message === undefined || message === null || !Array.isArray(message.content)) return ''
      let n = 0
      for (const block of message.content) {
        if (block && typeof block === 'object' && block.type !== 'text') n += 1
      }
      return n > 0 ? 'i' + n : ''
    }

    ctx.on('agent/inbox/inserted', (payload) => {
      try {
        if (sessionFilter === null) return
        const agent = payload && payload.agent
        if (agent === undefined || String(agent.id) !== sessionFilter) return
        const msg = payload.message
        if (!isUserMessage(msg)) return
        const text = extractText(msg)
        if (text.trim() === '') return
        record(text, {
          sid: msg && msg.id !== undefined ? String(msg.id) : null,
          sessionId: sessionFilter,
          sig: extractSig(msg),
        })
        console.log('[hrec] recorded submission (' + text.length + ' chars)')
      } catch (err) {
        console.error('[hrec] inbox record failed:', String(err && err.message))
      }
    })

    // ---- RPC（Client → Host，仅无损 JSON）----
    harness.handle('history/init', async (args) => {
      const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null
      if (sessionId !== null) sessionFilter = sessionId
      await init(sessionFilter)
      return {
        ok: true,
        persistentCount: store.snapshot.length,
        localCount: store.local.length,
        highWatermarkId: store.highWatermark,
        scope: store.scope,
        sessionFilter,
      }
    })

    harness.handle('history/status', async () => {
      await store.writeQueue
      return {
        ok: true,
        persistentCount: store.snapshot.length,
        localCount: store.local.length,
        total: store.snapshot.length + store.local.length,
      }
    })

    harness.handle('history/get', async (args) => {
      const index = args && typeof args.index === 'number' ? args.index : NaN
      const requestId = args && args.requestId
      if (!Number.isInteger(index)) return { ok: false, reason: 'bad-index' }
      const total = store.snapshot.length + store.local.length
      const hit = getUnified(index)
      return {
        ok: true,
        requestId,
        index,
        total,
        entry: hit === null ? null : { id: hit.entry.id, text: hit.entry.text, ts: hit.entry.ts, kind: hit.kind },
      }
    })

    harness.handle('history/record', async (args) => {
      const text = args && typeof args.text === 'string' ? args.text : ''
      if (text.trim() === '') return { ok: false, reason: 'empty' }
      const entry = record(text, {
        sessionId: args && args.sessionId,
        sig: args && typeof args.sig === 'string' ? args.sig : '',
      })
      await store.writeQueue
      return { ok: true, id: entry.id }
    })

    harness.handle('history/clear', async () => {
      await clear()
      return { ok: true }
    })

    // 只读状态工具：模型可调用以核对存储状态（不修改任何数据）
    const statusTool = harness.defineTool({
      name: 'hrec_status',
      description: 'Read PromptRecall store status: persistent/local counts, high watermark, file path, session filter, and last records (owned plain-JSON data only).',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: 'hrec: ' + JSON.stringify(value) }],
      },
      execute: async () => {
        await store.writeQueue
        return {
          ok: true,
          filePath,
          persistentCount: store.snapshot.length,
          localCount: store.local.length,
          total: store.snapshot.length + store.local.length,
          highWatermark: store.highWatermark,
          nextId: store.nextId,
          sessionFilter,
          lastRecords: store.fileRecords.slice(-5).map((r) => ({ id: r.id, text: r.text.slice(0, 60), sessionId: r.sessionId, sig: r.sig || '' })),
        }
      },
    })
    harness.registerTool(ctx, statusTool)

    // 激活即初始化（无会话过滤：全部记录进快照）；完成前到达的提交经 pendingBuffer 补录
    init(null).then(() => {
      const buffered = pendingBuffer
      pendingBuffer = []
      for (const e of buffered) commitEntry(e)
      ready = true
    }).catch((err) => {
      ready = true
      console.error('[hrec] init failed:', String(err && err.message))
    })
  },
}
