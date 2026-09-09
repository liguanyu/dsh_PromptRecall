// 客户端"触发菜单抑制"单测：直接加载 lib/client.js 产物。
// 客户端半是 shell 用 <script> 加载的 classic script + CJS factory，不能 import 兄弟
// 模块（loader 只解析模块表中的包名），因此这里用 window.__ModuleLoader__ 影子加载，
// 既验证注册形状（防止有人误改成 ESM 语法），也验证纯规则。
// 运行：node --test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const stubReact = {
  createElement: () => null,
  useReducer: () => [0, () => {}],
  useState: () => [false, () => {}],
  useEffect: () => {},
}

const loadBundle = () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration = null
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  new Function('window', source)(window)
  assert.notEqual(registration, null, 'lib/client.js 必须调用 window.__ModuleLoader__.load')
  assert.equal(typeof registration.factory, 'function')
  const exports = registration.factory((id) => {
    if (id === 'react') return stubReact
    throw new Error('unexpected require: ' + id)
  })
  return { registration, exports }
}

test('注册形状：id / apply / inject / 测试钩子', () => {
  const { registration, exports } = loadBundle()
  assert.equal(registration.id, 'dsh-prompt-recall')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual([...exports.inject], ['remote', 'slots'])
  assert.equal(typeof exports.__internals, 'object')
  assert.equal(typeof exports.__internals.createMenuGuard, 'function')
  assert.equal(typeof exports.__internals.liftsMenuSuppression, 'function')
  assert.equal(typeof exports.__internals.browsingOwnsArrows, 'function')
})

test('liftsMenuSuppression：导航键/修饰键不解除，编辑键解除', () => {
  const { exports } = loadBundle()
  const { liftsMenuSuppression } = exports.__internals

  // 浏览的导航键永不解除（否则会在浏览中把菜单放回来抢键），IME 组合中也不解除
  for (const key of ['ArrowUp', 'ArrowDown', 'Escape']) {
    assert.equal(liftsMenuSuppression(key, false), false, key)
    assert.equal(liftsMenuSuppression(key, true), false, key + ' + composing')
  }
  // 会改动草稿的按键：立刻解除，让本次编辑正常弹出菜单
  for (const key of ['a', 'Z', '1', ' ', 'Backspace', 'Delete', 'Enter']) {
    assert.equal(liftsMenuSuppression(key, false), true, key)
  }
  // 纯修饰键与非编辑键不解除
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'F5', 'Tab', 'Home']) {
    assert.equal(liftsMenuSuppression(key, false), false, key)
  }
  // IME 组合（key 常为 Process/Unidentified）视为编辑
  assert.equal(liftsMenuSuppression('Process', true), true)
  assert.equal(liftsMenuSuppression('Unidentified', true), true)
  // 非字符串防御
  assert.equal(liftsMenuSuppression(undefined, false), false)
  assert.equal(liftsMenuSuppression(null, false), false)
})

test('createMenuGuard：武装/解除与 dismiss 判定', () => {
  const { exports } = loadBundle()
  const { createMenuGuard } = exports.__internals
  const guard = createMenuGuard()

  assert.equal(guard.active, false)
  assert.equal(guard.shouldDismiss(true), false)
  guard.arm()
  assert.equal(guard.active, true)
  assert.equal(guard.shouldDismiss(true), true)
  assert.equal(guard.shouldDismiss(false), false)
  guard.arm()   // 重复武装幂等
  assert.equal(guard.shouldDismiss(true), true)
  guard.release()
  assert.equal(guard.active, false)
  assert.equal(guard.shouldDismiss(true), false)
  guard.release()   // 重复解除幂等
  assert.equal(guard.active, false)
})

test('browsingOwnsArrows：仅 browsing/loading 接管方向键', () => {
  const { exports } = loadBundle()
  const { browsingOwnsArrows } = exports.__internals
  assert.equal(browsingOwnsArrows('browsing'), true)
  assert.equal(browsingOwnsArrows('loading'), true)
  assert.equal(browsingOwnsArrows('idle'), false)
  assert.equal(browsingOwnsArrows(undefined), false)
})
