// 浏览器半：↑/↓ 输入历史交互（按键路由 + 历史状态机 + 位置 pill）。
// 持久客户端插件入口格式：window.__ModuleLoader__.load 工厂（exports.apply/exports.inject）。
// - 依赖：react（shell seed 模块）、remote/slots 服务（模块级 inject）。
// - 通信：ctx.remote.$mount(本包 client face) 后经 remote.promptRecall.<method> 调用宿主服务。
// - 样式：注入 <style> 标签（持久插件无 styles 内建）。
// - 交互不变量与动态版一致：语义空才接管、非空草稿/正文中间/有选区/弹窗让位、
//   浏览中草稿改动退出接管、异步响应按 requestId/epoch/期望文本作废。
window.__ModuleLoader__.load({
  id: 'dsh-prompt-recall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const PACKAGE = 'dsh-prompt-recall'
    const SERVICE = 'promptRecall'

    // 客户端 face：仅需 typeSymbol + parse（宿主侧真 zod 权威校验）
    const passthrough = () => ({ parse: (v) => v })
    const clientInvocation = (method) => ({
      id: `${PACKAGE}#${SERVICE}/${method}`,
      service: SERVICE,
      namespace: SERVICE,
      method,
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, schema: passthrough() },
      }],
      result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, schema: passthrough() },
    })
    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: ['open', 'status', 'get', 'record', 'clear'].map(clientInvocation),
    }

    const inject = ['remote', 'slots']

    async function apply(ctx) {
      const stylesTag = () => {
        if (typeof document === 'undefined') return
        const tagId = PACKAGE + '/pill.css'
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
        const tag = document.createElement('style')
        tag.dataset.pluginCss = tagId
        tag.textContent = `
          .hrec-pill{display:inline-flex;gap:6px;align-items:center;padding:2px 8px;border-radius:999px;
            border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.10);
            font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;margin:0 2px 4px}
          .hrec-pill .hrec-clear{border:0;background:none;padding:0 3px;cursor:pointer;font-size:11px;opacity:.7}
          .hrec-pill .hrec-clear:hover{opacity:1}
        `
        document.head.appendChild(tag)
      }

      // 挂载本包 remote 命名空间
      await ctx.remote.$mount(CONTRIBUTION)
      const api = ctx.get('remote.' + SERVICE)
      if (api === undefined) {
        console.error('[prompt-recall] remote namespace not mounted')
        return
      }

      // remote 调用统一解包：{ ok, value } / { ok:false, error }
      const call = async (method, args) => {
        try {
          const res = await api[method](args)
          if (res === null || typeof res !== 'object' || res.ok !== true) return null
          return res.value
        } catch (err) {
          console.error('[prompt-recall] remote ' + method + ' failed:', String(err && err.message))
          return null
        }
      }

      stylesTag()

      const timer = ctx.get('timer')
      const delay = (fn, ms) => {
        if (timer !== undefined && typeof timer.timeout === 'function') { timer.timeout(fn, ms); return }
        globalThis.setTimeout(fn, ms)
      }

      const machine = {
        mode: 'idle',            // 'idle' | 'browsing' | 'loading'
        position: null,
        lastHistoryText: null,
        epoch: 0,
        requestId: 0,
        pending: null,
        total: 0,
        booting: false,
        sessionId: null,
        listeners: [],
      }

      const emit = () => { for (const fn of machine.listeners.slice()) fn() }
      const subscribe = (fn) => {
        machine.listeners.push(fn)
        return () => {
          const i = machine.listeners.indexOf(fn)
          if (i >= 0) machine.listeners.splice(i, 1)
        }
      }

      const inputRef = { input: null, actions: null }
      let prevText = null
      let prevImgSig = null
      let prevInit = false

      const exitBrowsing = () => {
        machine.mode = 'idle'
        machine.position = null
        machine.lastHistoryText = null
        machine.pending = null
        machine.epoch += 1
        emit()
      }

      const setDraftVia = (text) => {
        const actions = inputRef.actions
        if (actions && typeof actions.setDraft === 'function') {
          try { actions.setDraft(text) } catch (err) {
            console.error('[prompt-recall] setDraft failed:', String(err && err.message))
          }
        }
      }

      const applyEntry = (el, text, index, total) => {
        machine.position = index
        machine.total = total
        machine.lastHistoryText = text
        machine.mode = 'browsing'
        machine.pending = null
        setDraftVia(text)
        try {
          el.focus()
          delay(() => {
            try { el.setSelectionRange(text.length, text.length) } catch (err) { /* ignore */ }
          }, 20)
        } catch (err) { /* ignore */ }
        emit()
      }

      const navigateTo = (el, index) => {
        const requestId = ++machine.requestId
        const epoch = machine.epoch
        const expectedText = machine.lastHistoryText
        machine.mode = 'loading'
        machine.position = index
        machine.pending = { requestId, index, epoch, expectedText }
        emit()
        call('get', { index, requestId }).then((value) => {
          const p = machine.pending
          if (machine.mode !== 'loading' || p === null) return
          if (value === null || value.requestId !== p.requestId || value.index !== p.index) return
          if (machine.epoch !== p.epoch) return
          if (machine.lastHistoryText !== p.expectedText) return
          if (value.entry === null || typeof value.entry.text !== 'string') { exitBrowsing(); return }
          applyEntry(el, value.entry.text, value.index, value.total)
        })
        return true
      }

      const beginBrowse = (el) => {
        if (machine.booting) return true
        machine.booting = true
        machine.bootingDraft = el.value
        call('status', {}).then((value) => {
          machine.booting = false
          if (machine.mode !== 'idle') return
          const cur = inputRef.input && typeof inputRef.input.draft === 'string' ? inputRef.input.draft : null
          if (cur !== machine.bootingDraft) return
          if (value === null) return
          machine.total = value.total
          if (machine.total <= 0) return
          navigateTo(el, machine.total - 1)
        })
        return true
      }

      const handleEscape = (el, text) => {
        const wasBrowsing = machine.mode !== 'idle'
        const hadText = text.length > 0
        if (wasBrowsing) exitBrowsing()
        if (hadText) {
          // 草稿保险：清空草稿并存入历史（进局部层与全局文件，仅文本），↑ 可找回
          const sid = machine.sessionId
          call('record', { text, sessionId: sid === null ? '' : sid })
          setDraftVia('')
          try { el.focus() } catch (err) { /* ignore */ }
        }
        return wasBrowsing || hadText
      }

      const handleArrow = (key, el, text, caret, semanticallyEmpty) => {
        const dir = key === 'ArrowUp' ? -1 : 1
        if (machine.mode === 'idle') {
          if (machine.booting) return true
          if (dir > 0) return false
          if (!semanticallyEmpty) return false
          return beginBrowse(el)
        }
        if (caret !== 0 && caret !== text.length) return false
        if (dir < 0) {
          if (machine.position === null || machine.position <= 0) return true
          return navigateTo(el, machine.position - 1)
        }
        if (machine.position !== null && machine.position + 1 < machine.total) {
          return navigateTo(el, machine.position + 1)
        }
        machine.lastHistoryText = null
        exitBrowsing()
        setDraftVia('')
        try { el.focus() } catch (err) { /* ignore */ }
        return true
      }

      const onKeydown = (event) => {
        if (event.defaultPrevented) return
        const key = event.key
        const isArrow = key === 'ArrowUp' || key === 'ArrowDown'
        const isEscape = key === 'Escape'
        if (!isArrow && !isEscape) return
        if (event.isComposing) return
        const el = event.target
        if (!el || el.tagName !== 'TEXTAREA') return
        if (el.disabled || el.readOnly) return
        const input = inputRef.input
        if (!input || typeof input !== 'object') return
        if (input.phase !== undefined && input.phase !== 'plain') return
        if (typeof input.draft === 'string' && el.value !== input.draft) return
        if (isEscape) {
          if (handleEscape(el, el.value)) {
            event.preventDefault()
            event.stopPropagation()
          }
          return
        }
        const caret = el.selectionStart
        const caretEnd = el.selectionEnd
        if (caret === null || caretEnd === null || caret !== caretEnd) return
        const semanticallyEmpty = el.value.length === 0
          && (!Array.isArray(input.imageIds) || input.imageIds.length === 0)
          && (!Array.isArray(input.occurrences) || input.occurrences.length === 0)
        if (handleArrow(key, el, el.value, caret, semanticallyEmpty)) {
          event.preventDefault()
          event.stopPropagation()
        }
      }

      const HistoryPill = (props) => {
        const [, force] = React.useReducer((x) => x + 1, 0)
        const [armed, setArmed] = React.useState(false)
        React.useEffect(() => subscribe(force), [])
        React.useEffect(() => {
          document.addEventListener('keydown', onKeydown)
          return () => document.removeEventListener('keydown', onKeydown)
        }, [])

        // 会话切换：上报 sessionId（宿主据此过滤 inbox 并分区快照/局部）
        React.useEffect(() => {
          if (typeof props.sessionId === 'string' && machine.sessionId !== props.sessionId) {
            machine.sessionId = props.sessionId
            exitBrowsing()
            call('open', { sessionId: props.sessionId }).then((value) => {
              if (value !== null && machine.sessionId === props.sessionId) {
                machine.total = value.persistentCount + value.localCount
                emit()
              }
            })
          }
        }, [props.sessionId])

        // 草稿修订追踪：文本/附件签名变化 → 用户改动 → 退出接管
        const curInput = props && props.input
        const curText = (curInput && typeof curInput.draft === 'string') ? curInput.draft : null
        const curImgSig = (curInput && Array.isArray(curInput.imageIds)) ? curInput.imageIds.join('|') : null
        React.useEffect(() => {
          if (prevInit && machine.mode !== 'idle') {
            if (curText !== prevText) {
              if (curText !== machine.lastHistoryText) exitBrowsing()
            }
            if (curImgSig !== prevImgSig) exitBrowsing()
          }
          prevText = curText
          prevImgSig = curImgSig
          prevInit = true
        }, [curText, curImgSig])

        inputRef.input = props && props.input
        inputRef.actions = props && props.inputActions

        const onClear = () => {
          if (!armed) {
            setArmed(true)
            delay(() => setArmed(false), 3000)
            return
          }
          setArmed(false)
          call('clear', {}).then(() => {
            machine.total = 0
            exitBrowsing()
          })
        }

        if (machine.mode === 'idle' && !armed) return null
        const label = machine.mode === 'loading'
          ? '↑ …'
          : '↑ ' + (machine.position === null ? '?' : machine.position + 1) + '/' + machine.total
        return React.createElement('div', { className: 'hrec-pill', title: '↑/↓ 浏览历史 · Esc 清空草稿（可 ↑ 找回）' },
          React.createElement('span', null, label),
          React.createElement('button', {
            className: 'hrec-clear',
            title: armed ? '再次点击确认清空全部历史' : '清空输入历史',
            onClick: onClear,
          }, armed ? '确认?' : '×'),
        )
      }

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
        { name: 'conversation.input.dock', id: 'prompt-recall', order: 50, label: 'PromptRecall' },
        (props) => React.createElement(HistoryPill, props),
      ))

      console.log('[prompt-recall] client applied')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
