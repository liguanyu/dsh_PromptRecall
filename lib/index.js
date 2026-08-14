// 宿主半：promptRecall Remote 服务。
// 零外部依赖的纯 apply 插件：不继承任何 Service 类，避免"插件自带的 cordis 拷贝
// 与装载器的 cordis 不是同一实例"导致的 instanceof 识别失败；
// 服务经 ctx.provide 注册，typertRemote 绑定按网关校验契约手工构造
// （{ service, serviceKey, namespace }，gateway 用字段相等校验）。
// Remote 方法签名必须是简单标识符参数（网关对原型方法有签名约束）。
import { createStore, isUserMessage, extractText, extractSig } from './store-core.js'

class PromptRecallImpl {
  constructor(ctx) {
    this.ctx = ctx
    this.fs = ctx.get('fs')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    this.root = sandboxPolicy !== undefined ? String(sandboxPolicy.workspaceRoot) : ''
    this.filePath = this.root + '/.dsh/prompt-history.jsonl'
    this.sessionFilter = null
    this.store = createStore({
      read: async () => {
        if (this.fs === undefined) return ''
        return await this.fs.readText(await this.fs.resolve(this.filePath))
      },
      write: async (text) => {
        if (this.fs === undefined) return
        await this.fs.writeText(await this.fs.resolve(this.filePath), text)
      },
    })
  }

  // ---- Remote 方法（返回纯业务 JSON；非法输入直接抛错）----

  async open(request) {
    if (request === null || typeof request !== 'object' || typeof request.sessionId !== 'string' || request.sessionId === '') {
      throw new Error('prompt-recall: open requires a non-empty sessionId')
    }
    this.sessionFilter = request.sessionId
    const r = await this.store.init(this.root, this.sessionFilter)
    return { ...r, sessionFilter: this.sessionFilter }
  }

  async status(_request) {
    return this.store.status()
  }

  async get(request) {
    if (request === null || typeof request !== 'object' || typeof request.index !== 'number' || !Number.isInteger(request.index)) {
      throw new Error('prompt-recall: get requires an integer index')
    }
    const total = this.store.snapshot().snapshot.length + this.store.snapshot().local.length
    const hit = this.store.getUnified(request.index)
    return {
      requestId: typeof request.requestId === 'number' ? request.requestId : null,
      index: request.index,
      total,
      entry: hit === null ? null : { id: hit.entry.id, text: hit.entry.text, ts: hit.entry.ts, kind: hit.kind },
    }
  }

  async record(request) {
    if (request === null || typeof request !== 'object' || typeof request.text !== 'string' || request.text.trim() === '') {
      throw new Error('prompt-recall: record requires non-empty text')
    }
    const entry = this.store.commit(request.text, {
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : null,
      sig: typeof request.sig === 'string' ? request.sig : '',
    })
    await this.store.snapshot().writeQueue
    return { id: entry.id }
  }

  async clear(_request) {
    await this.store.clear()
    return {}
  }

  onInbox(payload) {
    try {
      if (this.sessionFilter === null) return
      const agent = payload && payload.agent
      if (agent === undefined || String(agent.id) !== this.sessionFilter) return
      const msg = payload.message
      if (!isUserMessage(msg)) return
      const text = extractText(msg)
      if (text.trim() === '') return
      this.store.commit(text, {
        sid: msg && msg.id !== undefined ? String(msg.id) : null,
        sessionId: this.sessionFilter,
        sig: extractSig(msg),
      })
      console.log('[prompt-recall] recorded submission (' + text.length + ' chars)')
    } catch (err) {
      console.error('[prompt-recall] inbox record failed:', String(err && err.message))
    }
  }
}

export function apply(ctx) {
  const service = new PromptRecallImpl(ctx)
  service.typertRemote = Object.freeze({ service, serviceKey: 'promptRecall', namespace: 'promptRecall' })
  ctx.provide('promptRecall', service)
  ctx.effect(() => {
    service.store.init(service.root, null)
  })
  ctx.on('agent/inbox/inserted', (payload) => service.onInbox(payload))
}

export default apply
