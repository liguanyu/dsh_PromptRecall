// typert 契约单测：直接加载 lib/typert.host.js（真实 TYPERT 清单）与 lib/client.js 产物。
//
// DSH 0.1.7 起 schema 与 codec 都是惰性工厂契约，装载器与注册表都会做同样两条校验
// （dsh-typert-loader/lib/index.js 校验 schemas[].create 与 strict codec 的 create；
// dsh-typert-registry/lib/{index,client}.js 同款），网关解码走 codec.create().parse()。
// 升级 DSH 后若这两条规则再变，本文件应当先失败——它就是那次踩坑的回归网。
//
// 运行：node --test
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TYPERT } from '../lib/typert.host.js'

const PACKAGE = 'dsh-prompt-recall'

// 每个 invocation 的 codec 清单：[codec, 标签]
const codecsOf = (inv) => [
  ...inv.parameters.map((p) => [p.codec, `${inv.method} parameter ${p.wire}`]),
  [inv.result, `${inv.method} result`],
]

// ---- 客户端影子加载（与 client-menu-guard.test.mjs 同款：shell 只读 apply/inject）----
const stubReact = {
  createElement: () => null,
  useReducer: () => [0, () => {}],
  useState: () => [false, () => {}],
  useEffect: () => {},
}

const loadClientBundle = () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registration = null
  const window = { __ModuleLoader__: { load: (reg) => { registration = reg } } }
  new Function('window', source)(window)
  assert.notEqual(registration, null, 'lib/client.js 必须调用 window.__ModuleLoader__.load')
  return registration.factory((id) => {
    if (id === 'react') return stubReact
    throw new Error('unexpected require: ' + id)
  })
}

test('宿主 TYPERT：schemas 条目是 name + 记忆化 create() 工厂', () => {
  assert.equal(TYPERT.schemas.length, 11)
  for (const entry of TYPERT.schemas) {
    assert.equal(typeof entry.name, 'string', 'schema 缺少 name')
    assert.notEqual(entry.name, '')
    assert.equal(typeof entry.create, 'function', `${entry.name} 缺少 create()`)
    const schema = entry.create()
    assert.equal(typeof schema.parse, 'function', `${entry.name} 的 create() 未返回带 parse 的 schema`)
    // 记忆化：注册表缓存 value，网关每次解码都会调用 create()，重复调用必须是同一实例
    assert.equal(entry.create(), schema, `${entry.name} 的 create() 未记忆化`)
  }
})

test('宿主 TYPERT：每个 codec 都是 strict + typeSymbol + create()', () => {
  assert.equal(TYPERT.invocations.length, 5)
  for (const inv of TYPERT.invocations) {
    for (const [codec, label] of codecsOf(inv)) {
      assert.equal(codec.mode, 'strict', `${label} 不是 strict codec`)
      assert.equal(typeof codec.typeSymbol, 'string', `${label} 缺少 typeSymbol`)
      assert.notEqual(codec.typeSymbol, '')
      assert.equal(typeof codec.create, 'function', `${label} 缺少 create()`)
    }
  }
})

test('宿主 TYPERT：typeSymbol 指向本包已注册的 schema 名', () => {
  const names = new Set(TYPERT.schemas.map((entry) => entry.name))
  for (const inv of TYPERT.invocations) {
    for (const [codec, label] of codecsOf(inv)) {
      const prefix = `${PACKAGE}#`
      assert.ok(codec.typeSymbol.startsWith(prefix), `${label} 的 typeSymbol 不属于本包：${codec.typeSymbol}`)
      const name = codec.typeSymbol.slice(prefix.length)
      assert.ok(names.has(name), `${label} 的 typeSymbol 未注册：${name}`)
    }
  }
})

test('宿主 TYPERT：create().parse 校验入参（网关 decode 同路径）', () => {
  const byMethod = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
  const parse = (method, value) => byMethod.get(method).parameters[0].codec.create().parse(value)

  assert.deepEqual(parse('open', { sessionId: 's1' }), { sessionId: 's1' })
  assert.throws(() => parse('open', {}), 'open 缺 sessionId 必须拒绝')
  assert.throws(() => parse('open', { sessionId: 1 }), 'open 的 sessionId 必须是字符串')

  assert.deepEqual(parse('status', {}), {})
  assert.deepEqual(parse('clear', {}), {})

  assert.deepEqual(parse('get', { index: 0, requestId: 3 }), { index: 0, requestId: 3 })
  // schema 只要求 number；「整数」由宿主方法自身（lib/index.js 的 Number.isInteger）承担，
  // 本次升级不改这一分工，所以 1.5 过 codec 是预期行为。
  assert.deepEqual(parse('get', { index: 1.5, requestId: 3 }), { index: 1.5, requestId: 3 })
  assert.throws(() => parse('get', { index: '0', requestId: 3 }), 'get 的 index 必须是数字')
  assert.throws(() => parse('get', { index: 0 }), 'get 缺 requestId 必须拒绝')

  assert.deepEqual(parse('record', { text: 'hi', sessionId: 's1' }), { text: 'hi', sessionId: 's1' })
  assert.throws(() => parse('record', { sessionId: 's1' }), 'record 缺 text 必须拒绝')
})

test('宿主 TYPERT：结果 schema 接受各方法实际返回的形状', () => {
  const byMethod = new Map(TYPERT.invocations.map((inv) => [inv.method, inv]))
  const result = (method, value) => byMethod.get(method).result.create().parse(value)

  // PromptRecallImpl 的返回值：open 四字段、status 三字段、record { id }、clear {}
  result('open', { persistentCount: 0, localCount: 0, highWatermarkId: 0, sessionFilter: 's1' })
  result('status', { persistentCount: 0, localCount: 1, total: 1 })
  result('record', { id: 7 })
  result('clear', {})
  // get：entry 为对象或 null，requestId 可空
  result('get', { requestId: 4, index: 0, total: 2, entry: { id: 1, text: 'hi', ts: 1, kind: 'local' } })
  result('get', { requestId: null, index: 0, total: 0, entry: null })
  assert.throws(() => result('get', {
    requestId: 4, index: 0, total: 1, entry: { id: 1, text: 'hi', ts: 1 },
  }), 'get 的 entry 缺 kind 必须拒绝')
})

test('宿主 TYPERT：5 个端点唯一且与 model.services 方法一一对应', () => {
  const endpoints = TYPERT.invocations.map((inv) => `${inv.namespace}/${inv.method}`)
  assert.deepEqual([...endpoints].sort(), ['promptRecall/clear', 'promptRecall/get', 'promptRecall/open', 'promptRecall/record', 'promptRecall/status'])
  assert.equal(new Set(TYPERT.invocations.map((inv) => inv.id)).size, TYPERT.invocations.length, 'invocation id 必须唯一')

  const service = TYPERT.model.services[0]
  assert.equal(service.key, 'promptRecall')
  const members = service.members.map((member) => member.name).sort()
  assert.deepEqual(members, ['clear', 'get', 'open', 'record', 'status'])
})

test('客户端贡献：codec 全部 strict 且带 create()（客户端 gateway/registry 同款校验）', () => {
  const exports = loadClientBundle()
  const descriptors = exports.__internals.clientDescriptors
  assert.ok(Array.isArray(descriptors), '客户端贡献必须暴露 descriptors 供契约测试')
  assert.equal(descriptors.length, 5)

  for (const descriptor of descriptors) {
    for (const parameter of descriptor.parameters) {
      // dsh-api-gateway/lib/client.js requireStrictInputs：参数 codec 必须 strict
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method} 参数不是 strict`)
      assert.equal(typeof parameter.codec.create, 'function', `${descriptor.method} 参数缺 create()`)
      assert.equal(typeof parameter.codec.create().parse, 'function', `${descriptor.method} 参数的 create() 未返回 { parse }`)
    }
    assert.equal(typeof descriptor.result.create, 'function', `${descriptor.method} result 缺 create()`)
    assert.equal(typeof descriptor.result.create().parse, 'function', `${descriptor.method} result 的 create() 未返回 { parse }`)
  }
})

test('两面一致：namespace/method/wire/typeSymbol 逐字对应', () => {
  const exports = loadClientBundle()
  const client = new Map(exports.__internals.clientDescriptors.map((d) => [d.method, d]))
  assert.equal(client.size, TYPERT.invocations.length)

  for (const inv of TYPERT.invocations) {
    const peer = client.get(inv.method)
    assert.notEqual(peer, undefined, `客户端缺少 ${inv.method}`)
    assert.equal(peer.namespace, inv.namespace)
    assert.equal(peer.service, inv.service)
    assert.equal(peer.invocation.kind, inv.invocation.kind)
    assert.deepEqual(
      peer.parameters.map((p) => [p.name, p.wire, p.source, p.codec.mode, p.codec.typeSymbol]),
      inv.parameters.map((p) => [p.name, p.wire, p.source, p.codec.mode, p.codec.typeSymbol]),
    )
    assert.equal(peer.result.typeSymbol, inv.result.typeSymbol)
  }
})
