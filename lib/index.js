// 宿主半：输入历史 Remote 服务。
// - 纯 JS Service（extends TypertRemoteService，注册键 'promptRecall'），
//   typert 面由本包的 ./typert 导出（lib/typert.host.js），供网关发现与校验。
// - 存储核心见 ./store-core.js（JSONL 落盘由本文件绑定 fs 服务）。
// - 提交捕获沿用 agent/inbox/inserted（source.kind === 'user' 判别）。
// 注意：方法名避开 Cordis Service 生命周期保留名（init 等），会话初始化用 open。
import { Service } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createStore, isUserMessage, extractText, extractSig } from './store-core.js'

export class PromptRecallService extends TypertRemoteService {
  fs
  filePath = ''
  root = ''
  sessionFilter = null
  store = null

  constructor(ctx) {
    super(ctx, 'promptRecall')
    this.fs = ctx.get('fs')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    this.root = sandboxPolicy !== undefined ? String(sandboxPolicy.workspaceRoot) : ''
    this.filePath = this.root + '/.dsh/prompt-history.jsonl'
  }

  async [Service.init]() {
    const io = {
      read: async () => {
        if (this.fs === undefined) return ''
        return await this.fs.readText(await this.fs.resolve(this.filePath))
      },
      write: async (text) => {
        if (this.fs === undefined) return
        await this.fs.writeText(await this.fs.resolve(this.filePath), text)
      },
    }
    this.store = createStore(io)
    await this.store.init(this.root, null)
    this.ctx.on('agent/inbox/inserted', (payload) => this.onInbox(payload))
  }

  onInbox(payload) {
    try {
      if (this.sessionFilter === null || this.store === null) return
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
}

export default PromptRecallService
