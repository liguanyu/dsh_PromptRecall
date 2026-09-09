// 浏览器半：↑/↓ 输入历史交互（按键路由 + 历史状态机 + 位置 pill）。
// 持久客户端插件入口格式：window.__ModuleLoader__.load 工厂（exports.apply/exports.inject）。
// - 依赖：react（shell seed 模块）、remote/slots 服务（模块级 inject）。
// - 通信：ctx.remote.$mount(本包 client face) 后经 remote.promptRecall.<method> 调用宿主服务。
// - 样式：注入 <style> 标签（持久插件无 styles 内建）。
// - 交互不变量与动态版一致：语义空才接管、非空草稿/正文中间/有选区/弹窗让位、
//   浏览中草稿改动退出接管、异步响应按 requestId/epoch/期望文本作废。
// - 编辑器适配：新版 composer 是 Lexical contenteditable div（[data-composer-input]，
//   祖先带 [data-input-scroll]），旧版是 [data-input-scroll] 内的 textarea。两条路线
//   都兼容：文本一律以 input.draft 为准（新版 draft 即编辑器真值），光标位置用
//   Selection/Range（contenteditable）或 selectionStart/End（textarea）判定。
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

      // 行尾规范化：复刻 DOM textarea 的 API value 规则（\r\n / \r → \n）。
      // Windows 剪贴板粘贴的 CRLF 会使机器草稿与编辑器值持久不一致，进而让
      // keydown 守卫（Esc 同路径）静默放行；统一到 LF 后比较才可靠。
      const normalizeText = (s) => (typeof s === 'string' ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s)

      const machine = {
        mode: 'idle',            // 'idle' | 'browsing' | 'loading'
        position: null,
        lastHistoryText: null,
        appliedDraftRev: null,   // 召回文本落地时的 draftRev（版本判定用户编辑，替代文本比较）
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
        machine.appliedDraftRev = null
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

      // ---- 编辑器探测与光标工具（contenteditable / textarea 双兼容）----

      // 只接管会话 composer 的编辑面；页面里其他输入区域的事件一律放行。
      // 新版 composer 是 Lexical contenteditable div（[data-composer-input]，
      // 祖先带 [data-input-scroll]）；旧版是 [data-input-scroll] 内的 textarea。
      const composerEditor = (el) => {
        if (!el || typeof el.closest !== 'function') return null
        const inputEl = el.closest('[data-composer-input]')
        if (inputEl !== null) {
          // contenteditable 路线：仅"可编辑"态算 composer（hero 触发器/禁用态放行）
          if (inputEl.closest('[data-input-scroll]') === null) return null
          if (inputEl.getAttribute('contenteditable') !== 'true') return null
          return inputEl
        }
        // textarea 路线（旧版 UI）
        if (el.tagName !== 'TEXTAREA') return null
        if (el.closest('[data-input-scroll]') === null) return null
        return el
      }

      // 光标是否折叠且在内容最前/最后。返回 null 表示不适用（无选区/有选区/选区不在编辑器内）。
      const caretState = (ed) => {
        if (ed.tagName === 'TEXTAREA') {
          const s = ed.selectionStart
          const e = ed.selectionEnd
          if (s === null || e === null || s !== e) return null
          return { atStart: s === 0, atEnd: s === ed.value.length }
        }
        const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
        if (sel === null || sel.rangeCount === 0 || !sel.isCollapsed) return null
        const range = sel.getRangeAt(0)
        if (!ed.contains(range.startContainer) || !ed.contains(range.endContainer)) return null
        const full = document.createRange()
        full.selectNodeContents(ed)
        const atStart = range.compareBoundaryPoints(Range.START_TO_START, full) === 0
        const atEnd = range.compareBoundaryPoints(Range.END_TO_END, full) === 0
        return { atStart, atEnd }
      }

      // 把光标放到编辑器内容末尾（contenteditable 用 Range，textarea 用 setSelectionRange）。
      const placeCaretEnd = (ed) => {
        if (ed.tagName === 'TEXTAREA') {
          try { ed.setSelectionRange(ed.value.length, ed.value.length) } catch (err) { /* ignore */ }
          return
        }
        try {
          ed.focus()
          const sel = typeof window.getSelection === 'function' ? window.getSelection() : null
          if (sel === null) return
          const range = document.createRange()
          range.selectNodeContents(ed)
          range.collapse(false)
          sel.removeAllRanges()
          sel.addRange(range)
        } catch (err) { /* ignore */ }
      }

      const applyEntry = (ed, text, index, total) => {
        // 旧记录可能含 CRLF（历史上"粘贴后未编辑即提交"的文本），统一到 LF，
        // 保证 lastHistoryText 与编辑器文本同基准。
        const entryText = normalizeText(text)
        machine.position = index
        machine.total = total
        machine.lastHistoryText = entryText
        machine.mode = 'browsing'
        machine.pending = null
        setDraftVia(entryText)
        // 光标置尾需"确认生效"：受控编辑器的值提交可能晚于首次放置，
        // 短轮询直到光标确实落在末尾；一旦用户移走光标则停止，不再争夺。
        try { ed.focus() } catch (err) { /* ignore */ }
        let placed = false
        let attempts = 0
        const placeCaret = () => {
          if (machine.mode !== 'browsing' || machine.lastHistoryText !== entryText) return
          attempts += 1
          const st = caretState(ed)
          const atEnd = st !== null && st.atEnd
          if (atEnd) {
            if (placed) return
            placed = true
          } else if (placed) {
            return
          } else {
            placeCaretEnd(ed)
          }
          if (attempts < 12) delay(placeCaret, 40)
        }
        delay(placeCaret, 20)
        emit()
      }

      const navigateTo = (ed, index) => {
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
          applyEntry(ed, value.entry.text, value.index, value.total)
        })
        return true
      }

      const beginBrowse = (ed) => {
        if (machine.booting) return true
        machine.booting = true
        machine.bootingDraft = inputRef.input && typeof inputRef.input.draft === 'string' ? inputRef.input.draft : ''
        call('status', {}).then((value) => {
          machine.booting = false
          if (machine.mode !== 'idle') return
          const cur = inputRef.input && typeof inputRef.input.draft === 'string' ? inputRef.input.draft : null
          if (cur !== machine.bootingDraft) return
          if (value === null) return
          machine.total = value.total
          if (machine.total <= 0) return
          navigateTo(ed, machine.total - 1)
        })
        return true
      }

      const handleEscape = (ed, rawText) => {
        // 行尾统一到 LF：CRLF 粘贴文本记录进历史时保持与召回同基准
        const text = normalizeText(rawText)
        const wasBrowsing = machine.mode !== 'idle'
        const hadText = text.length > 0
        if (wasBrowsing) exitBrowsing()
        if (hadText) {
          // 草稿保险：清空草稿并存入历史（进局部层与全局文件，仅文本），↑ 可找回
          const sid = machine.sessionId
          call('record', { text, sessionId: sid === null ? '' : sid })
          setDraftVia('')
          try { ed.focus() } catch (err) { /* ignore */ }
        }
        return wasBrowsing || hadText
      }

      const handleArrow = (key, ed, text, caret, semanticallyEmpty) => {
        const dir = key === 'ArrowUp' ? -1 : 1
        if (machine.mode === 'idle') {
          if (machine.booting) return true
          if (dir > 0) return false
          if (!semanticallyEmpty) return false
          return beginBrowse(ed)
        }
        if (caret === null || (!caret.atStart && !caret.atEnd)) return false
        if (dir < 0) {
          if (machine.position === null || machine.position <= 0) return true
          return navigateTo(ed, machine.position - 1)
        }
        if (machine.position !== null && machine.position + 1 < machine.total) {
          return navigateTo(ed, machine.position + 1)
        }
        machine.lastHistoryText = null
        exitBrowsing()
        setDraftVia('')
        try { ed.focus() } catch (err) { /* ignore */ }
        return true
      }

      const onKeydown = (event) => {
        // 弹窗/命令菜单消费过的按键（shell 已 preventDefault）一律让位
        if (event.defaultPrevented) return
        const key = event.key
        const isArrow = key === 'ArrowUp' || key === 'ArrowDown'
        const isEscape = key === 'Escape'
        if (!isArrow && !isEscape) return
        if (event.isComposing) return
        const ed = composerEditor(event.target)
        if (ed === null) return
        if (ed.tagName === 'TEXTAREA' && (ed.disabled || ed.readOnly)) return
        const input = inputRef.input
        if (!input || typeof input !== 'object') return
        if (input.phase !== undefined && input.phase !== 'plain') return
        // 文本源以 draft 为准（新版 shell 的 draft 即编辑器真值；contenteditable 的
        // DOM 文本因分块渲染不可直接比较），两者都做行尾规范化后再参与判定。
        const draftText = normalizeText(typeof input.draft === 'string' ? input.draft : '')
        if (ed.tagName === 'TEXTAREA') {
          // 旧版 textarea：受控组件同步滞后时（el.value 与 draft 短暂不一致），
          // 浏览中且文本未被修改仍按 draft 接管，防止静默放行浏览器默认行为。
          const elText = normalizeText(ed.value)
          if (elText !== draftText && (machine.mode === 'idle' || machine.lastHistoryText === null || draftText !== machine.lastHistoryText)) return
        }
        if (isEscape) {
          if (handleEscape(ed, ed.tagName === 'TEXTAREA' ? ed.value : draftText)) {
            event.preventDefault()
            event.stopPropagation()
          }
          return
        }
        const caret = caretState(ed)
        const semanticallyEmpty = draftText.length === 0
          && (!Array.isArray(input.imageIds) || input.imageIds.length === 0)
          && (!Array.isArray(input.occurrences) || input.occurrences.length === 0)
        if (handleArrow(key, ed, draftText, caret, semanticallyEmpty)) {
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

        // 草稿修订追踪：用 draftRev 版本判定用户编辑（文本比较易受往返/行尾差异误伤）；
        // 附件签名变化仍单独触发退出。程序化 setDraft 也会 +1，latch 在重渲染后的
        // effect 中完成，恰好捕获"召回文本落地"后的版本。
        const curInput = props && props.input
        const curText = (curInput && typeof curInput.draft === 'string') ? curInput.draft : null
        const curImgSig = (curInput && Array.isArray(curInput.imageIds)) ? curInput.imageIds.join('|') : null
        const curDraftRev = (curInput && typeof curInput.draftRev === 'number') ? curInput.draftRev : null
        React.useEffect(() => {
          if (prevInit && machine.mode !== 'idle') {
            if (curText !== prevText) {
              // 文本变了：等于召回文本 = 程序化应用/用户改回原文，latch 当前版本；
              // 否则是用户编辑，退出接管。rev 不可用时退化为纯文本比较。
              if (curText === machine.lastHistoryText) {
                machine.appliedDraftRev = curDraftRev
              } else {
                exitBrowsing()
              }
            } else if (curText === machine.lastHistoryText && curDraftRev !== null && machine.appliedDraftRev === null) {
              // 同文本重放（setDraft 无变化、effect 因 rev/附件变化触发）：补 latch
              machine.appliedDraftRev = curDraftRev
            }
            if (machine.mode !== 'idle' && machine.appliedDraftRev !== null && curDraftRev !== null
              && curDraftRev !== machine.appliedDraftRev && curText === machine.lastHistoryText) {
              // 文本未变但版本变了（同文编辑/程序化重设）→ 用户动过 → 退出
              exitBrowsing()
            }
            if (curImgSig !== prevImgSig) exitBrowsing()
          }
          prevText = curText
          prevImgSig = curImgSig
          prevInit = true
        }, [curText, curImgSig, curDraftRev])

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
