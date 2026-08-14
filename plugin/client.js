// Client 半：↑/↓ 输入历史交互（KeyRouter + HistoryNavigator + ComposerDraftAdapter + 位置 pill）。
// 本文件内容即 cordis_define code.client 的函数体（自由变量: ctx, React, host, styles, console）。
//
// 契约依据（运行时已验证）：
// - 挂载点 conversation.input.dock（session 级 list 槽，追加式无替换风险）。
// - props.input = InputState { draft, imageIds, draftRev, phase('plain'=正常), occurrences, queue }
//   （点时间快照，输入变化时重渲染）；props.inputActions.setDraft(text) 为官方写入口。
// - 键盘接管：document 冒泡阶段键监听（产品先消费弹窗/仲裁键，defaultPrevented 自动让位）；
//   只处理目标为 composer textarea 且 el.value === input.draft 的 ↑/↓/Esc，不匹配一律放行。
//
// 状态机：Idle | Browsing | Loading + position + epoch + requestId + pending。
// - 语义空草稿（文本+附件+mention 全空）按 ↑ 才进入浏览；否则交还编辑器。
// - 浏览中用户改动草稿（文本或附件签名变化）→ 退出接管并作废 pending 请求。
// - ↓ 越过最新项 → 清空输入框并退出浏览。
// - Esc → 清空非空草稿并存入历史（草稿保险：进局部层与全局文件，仅文本，↑ 可找回）。
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert(`
      .hrec-pill{display:inline-flex;gap:6px;align-items:center;padding:2px 8px;border-radius:999px;
        border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.10);
        font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.6;margin:0 2px 4px}
      .hrec-pill .hrec-clear{border:0;background:none;padding:0 3px;cursor:pointer;font-size:11px;opacity:.7}
      .hrec-pill .hrec-clear:hover{opacity:1}
    `)

    const machine = {
      mode: 'idle',            // 'idle' | 'browsing' | 'loading'
      position: null,          // 统一索引（persistent 段 + local 段）
      lastHistoryText: null,   // 最近一次应用的条目文本（草稿修订判定基准）
      epoch: 0,                // 每轮浏览的身份代；任何退出/重置都 +1
      requestId: 0,
      pending: null,           // { requestId, index, epoch, expectedText }
      total: 0,
      booting: false,          // 首次 ↑ 的 status 刷新在途
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
          console.error('[hrec] setDraft failed:', String(err && err.message))
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
        // 光标置尾：等 React 提交值后再落光标
        ctx.timeout(() => {
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
      host.call('history/get', { index, requestId }).then(
        (res) => {
          const p = machine.pending
          if (machine.mode !== 'loading' || p === null) return
          if (!res || res.ok !== true || res.requestId !== p.requestId || res.index !== p.index) return
          if (machine.epoch !== p.epoch) return
          if (machine.lastHistoryText !== p.expectedText) return
          if (!res.entry || typeof res.entry.text !== 'string') { exitBrowsing(); return }
          applyEntry(el, res.entry.text, res.index, res.total)
        },
        (err) => {
          console.error('[hrec] get failed:', String(err && err.message))
          if (machine.mode === 'loading') exitBrowsing()
        },
      )
      return true
    }

    const beginBrowse = (el) => {
      if (machine.booting) return true
      machine.booting = true
      machine.bootingDraft = el.value
      host.call('history/status', {}).then(
        (res) => {
          machine.booting = false
          if (machine.mode !== 'idle') return
          // 等待期间用户已开始输入 → 放弃接管，不覆盖新草稿
          const cur = inputRef.input && typeof inputRef.input.draft === 'string' ? inputRef.input.draft : null
          if (cur !== machine.bootingDraft) return
          if (!res || res.ok !== true) return
          machine.total = res.total
          if (machine.total <= 0) return
          navigateTo(el, machine.total - 1)
        },
        (err) => {
          machine.booting = false
          console.error('[hrec] status failed:', String(err && err.message))
        },
      )
      return true
    }

    const handleEscape = (el, text) => {
      const wasBrowsing = machine.mode !== 'idle'
      const hadText = text.length > 0
      if (wasBrowsing) exitBrowsing()
      if (hadText) {
        // 草稿保险：清空草稿并存入历史，↑ 可找回
        const sid = machine.sessionId
        host.call('history/record', { text, sessionId: sid === null ? undefined : sid }).then(
          () => {},
          (err) => console.error('[hrec] stash failed:', String(err && err.message)),
        )
        setDraftVia('')
        try { el.focus() } catch (err) { /* ignore */ }
      }
      return wasBrowsing || hadText
    }

    const handleArrow = (key, el, text, caret, semanticallyEmpty) => {
      const dir = key === 'ArrowUp' ? -1 : 1
      if (machine.mode === 'idle') {
        if (machine.booting) return true
        if (dir > 0) return false               // ↓ 在 idle 不进入历史
        if (!semanticallyEmpty) return false    // 语义非空草稿（含附件/mention）：↑ 交给编辑器
        return beginBrowse(el)                  // 语义空草稿：进入历史浏览
      }
      // browsing | loading
      if (caret !== 0 && caret !== text.length) return false  // 正文中间：交给编辑器
      if (dir < 0) {
        if (machine.position === null || machine.position <= 0) return true  // 最旧边界：no-op
        return navigateTo(el, machine.position - 1)
      }
      if (machine.position !== null && machine.position + 1 < machine.total) {
        return navigateTo(el, machine.position + 1)
      }
      // ↓ 越过最新项：清空输入框并退出浏览
      machine.lastHistoryText = null
      exitBrowsing()
      setDraftVia('')
      try { el.focus() } catch (err) { /* ignore */ }
      return true
    }

    const onKeydown = (event) => {
      // 冒泡阶段：产品的输入框 onKeyDown 先运行；弹窗/命令仲裁消费过的键（preventDefault）一律让位
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
      if (!input || typeof input !== 'object') return        // 无法识别 composer → 放行
      if (input.phase !== undefined && input.phase !== 'plain') return  // 非普通编辑阶段（发送/阻塞等）→ 放行
      if (typeof input.draft === 'string' && el.value !== input.draft) return  // 非 composer textarea → 放行
      if (isEscape) {
        if (handleEscape(el, el.value)) {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      const caret = el.selectionStart
      const caretEnd = el.selectionEnd
      if (caret === null || caretEnd === null || caret !== caretEnd) return  // 有选区 → 编辑器
      // 语义空：文本、附件、mention 全空才算空草稿
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

      // 会话切换：上报 sessionId（宿主据此过滤 inbox 事件）并重冻结快照
      React.useEffect(() => {
        if (typeof props.sessionId === 'string' && machine.sessionId !== props.sessionId) {
          machine.sessionId = props.sessionId
          exitBrowsing()
          host.call('history/init', { sessionId: props.sessionId }).then(
            (res) => {
              if (res && res.ok === true && machine.sessionId === props.sessionId) {
                machine.total = res.persistentCount + res.localCount
                emit()
              }
            },
            (err) => console.error('[hrec] init failed:', String(err && err.message)),
          )
        }
      }, [props.sessionId])

      // 草稿修订追踪：文本/附件签名变化且不等于我们刚应用的条目 → 用户改动 → 退出接管
      const curInput = props && props.input
      const curText = (curInput && typeof curInput.draft === 'string') ? curInput.draft : null
      const curImgSig = (curInput && Array.isArray(curInput.imageIds)) ? curInput.imageIds.join('|') : null
      React.useEffect(() => {
        if (prevInit && machine.mode !== 'idle') {
          if (curText !== prevText) {
            if (curText !== machine.lastHistoryText) exitBrowsing()
          }
          if (curImgSig !== prevImgSig) exitBrowsing()  // 附件变化（插件从不写附件，任何变化都是用户操作）
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
          ctx.timeout(() => setArmed(false), 3000)
          return
        }
        setArmed(false)
        host.call('history/clear', {}).then(
          () => {
            machine.total = 0
            exitBrowsing()
          },
          (err) => console.error('[hrec] clear failed:', String(err && err.message)),
        )
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

    slots.inject('conversation.input.dock', () => slots.register(
      { name: 'conversation.input.dock', id: 'prompt-recall', order: 50, label: 'PromptRecall' },
      (props) => React.createElement(HistoryPill, props),
    ))

    console.log('[hrec] client applied')
  },
}
