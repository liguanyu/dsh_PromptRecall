// 宿主半：promptRecall Remote 服务。
// 零外部依赖的纯 apply 插件：不继承任何 Service 类，避免"插件自带的 cordis 拷贝
// 与装载器的 cordis 不是同一实例"导致的 instanceof 识别失败；
// 服务经 ctx.provide 注册，typertRemote 绑定按网关校验契约手工构造
// （{ service, serviceKey, namespace }，gateway 用字段相等校验）。
// Remote 方法签名必须是简单标识符参数（网关对原型方法有签名约束）。
//
// 持久化：历史文件固定写在用户级 DSH 主目录（$DSH_HOME 或 ~/.dsh）下的
// prompt-history.jsonl，用 node:fs 原子替换（tmp+rename）落盘。不用 ctx.fs：
// 插件行 apply 时 fs/sandboxPolicy 服务可能尚未就绪（读成 undefined 会静默
// 变成内存-only），且匿名写路径的可写根是 dsh 启动目录（sandboxPolicy.
// workspaceRoot = process.cwd()），会随启动位置漂移并可能被围栏拒绝。
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createStore, isUserMessage, extractText, extractSig } from './store-core.js'

class PromptRecallImpl {
  constructor(ctx) {
    this.ctx = ctx
    const base = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh')
    this.base = base
    this.filePath = join(base, 'prompt-history.jsonl')
    this.sessionFilter = null
    this.store = createStore({
      read: async () => {
        try {
          return await readFile(this.filePath, 'utf8')
        } catch (err) {
          // 文件尚不存在 = 空历史；其他错误上抛，让 store 保留现有内存状态
          if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return ''
          throw err
        }
      },
      write: async (text) => {
        const tmp = this.filePath + '.tmp'
        try {
          await mkdir(dirname(this.filePath), { recursive: true })
          await writeFile(tmp, text, 'utf8')
          await rename(tmp, this.filePath)
        } catch (err) {
          try { await rm(tmp, { force: true }) } catch (cleanupErr) { /* ignore */ }
          throw err
        }
      },
    })
  }

  // ---- Remote 方法（返回纯业务 JSON；非法输入直接抛错）----

  async open(request) {
    if (request === null || typeof request !== 'object' || typeof request.sessionId !== 'string' || request.sessionId === '') {
      throw new Error('prompt-recall: open requires a non-empty sessionId')
    }
    this.sessionFilter = request.sessionId
    const r = await this.store.init(this.base, this.sessionFilter)
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
    if (request === null || typeof request !== 'object' || typeof request.text !== 'string') {
      throw new Error('prompt-recall: record requires non-empty text')
    }
    // 行尾统一到 LF（Windows 剪贴板粘贴会带 CRLF），保持历史文件格式一致
    const text = request.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (text.trim() === '') {
      throw new Error('prompt-recall: record requires non-empty text')
    }
    const entry = this.store.commit(text, {
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
      const text = extractText(msg).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      if (text.trim() === '') return
      this.store.commit(text, {
        sid: msg && msg.id !== undefined ? String(msg.id) : null,
        sessionId: this.sessionFilter,
        sig: extractSig(msg),
      })
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
    service.store.init(service.base, null)
  })
  ctx.on('agent/inbox/inserted', (payload) => service.onInbox(payload))
}

export default apply
