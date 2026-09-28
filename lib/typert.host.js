// 手写的 typert 宿主面（TYPERT manifest）：
// 包导出 ./typert 指向本文件；dsh-typert-loader 挂载行时导入并注册到 ctx.typert，
// 网关据此校验参数/返回值并派发 promptRecall/<method>。
//
// DSH 0.1.7 起 schema 与 codec 都是「惰性工厂」契约：装载器/注册表要求每个 schema 与
// strict codec 都提供 create()，注册表用 record.value ??= record.create() 缓存实例，
// 网关每次解码调用 codec.create().parse(value)。因此这里所有 schema 都是记忆化工厂，
// 且 schemas 声明与 codec 共享同一工厂：resolve('<pkg>#<Type>') 拿到的就是校验用的实例。
import { z } from 'zod'

const lazy = (build) => {
  let value
  return () => (value ??= build())
}

const InitRequestSchema = lazy(() => z.object({ sessionId: z.string() }))
const StatusRequestSchema = lazy(() => z.object({}))
const GetRequestSchema = lazy(() => z.object({ index: z.number(), requestId: z.number() }))
const RecordRequestSchema = lazy(() => z.object({ text: z.string(), sessionId: z.string() }))
const ClearRequestSchema = lazy(() => z.object({}))

const EntrySchema = lazy(() => z.object({ id: z.number(), text: z.string(), ts: z.number(), kind: z.string() }))
const InitResultSchema = lazy(() => z.object({ persistentCount: z.number(), localCount: z.number(), highWatermarkId: z.number(), sessionFilter: z.string() }))
const StatusResultSchema = lazy(() => z.object({ persistentCount: z.number(), localCount: z.number(), total: z.number() }))
const GetResultSchema = lazy(() => z.object({ requestId: z.union([z.number(), z.null()]), index: z.number(), total: z.number(), entry: z.union([EntrySchema(), z.null()]) }))
const RecordResultSchema = lazy(() => z.object({ id: z.number() }))
const ClearResultSchema = lazy(() => z.object({}))

const PACKAGE = 'dsh-prompt-recall'
const SERVICE = 'promptRecall'

// strict codec：typeSymbol 用与 schemas 注册名一致的规范符号（仅供诊断与 typert.resolve，
// 不跨线缆传输，也不参与 lookup/Context 的比对——本插件没有 lookup 参数）。
const codec = (typeName, create) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${typeName}`, create })

const invocation = (method, requestType, requestSchema, resultType, resultSchema) => ({
  id: `${PACKAGE}#${SERVICE}/${method}`,
  service: SERVICE,
  namespace: SERVICE,
  method,
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: codec(requestType, requestSchema),
  }],
  result: codec(resultType, resultSchema),
})

export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  model: {
    services: [{
      description: 'Cross-conversation input-history storage for the web composer: JSONL persistence, per-conversation recall partition, and submission capture.',
      summary: 'Cross-conversation input-history storage.',
      tags: [],
      key: SERVICE,
      exportName: 'PromptRecallService',
      members: [
        { kind: 'method', name: 'open', signature: 'open(request: InitRequest): Promise<InitResult>' },
        { kind: 'method', name: 'status', signature: 'status(request: StatusRequest): Promise<StatusResult>' },
        { kind: 'method', name: 'get', signature: 'get(request: GetRequest): Promise<GetResult>' },
        { kind: 'method', name: 'record', signature: 'record(request: RecordRequest): Promise<RecordResult>' },
        { kind: 'method', name: 'clear', signature: 'clear(request: ClearRequest): Promise<ClearResult>' },
      ],
      types: [
        { name: 'InitRequest', declaration: 'export interface InitRequest { readonly sessionId: string; }' },
        { name: 'StatusRequest', declaration: 'export interface StatusRequest {}' },
        { name: 'GetRequest', declaration: 'export interface GetRequest { readonly index: number; readonly requestId: number; }' },
        { name: 'RecordRequest', declaration: 'export interface RecordRequest { readonly text: string; readonly sessionId: string; }' },
        { name: 'ClearRequest', declaration: 'export interface ClearRequest {}' },
        { name: 'Entry', declaration: 'export interface Entry { readonly id: number; readonly text: string; readonly ts: number; readonly kind: string; }' },
        { name: 'InitResult', declaration: 'export interface InitResult { readonly persistentCount: number; readonly localCount: number; readonly highWatermarkId: number; readonly sessionFilter: string; }' },
        { name: 'StatusResult', declaration: 'export interface StatusResult { readonly persistentCount: number; readonly localCount: number; readonly total: number; }' },
        { name: 'GetResult', declaration: 'export interface GetResult { readonly requestId: number | null; readonly index: number; readonly total: number; readonly entry: Entry | null; }' },
        { name: 'RecordResult', declaration: 'export interface RecordResult { readonly id: number; }' },
        { name: 'ClearResult', declaration: 'export interface ClearResult {}' },
      ],
    }],
    events: [],
    objects: [],
  },
  schemas: [
    { name: 'InitRequest', create: InitRequestSchema, declaration: 'export interface InitRequest { readonly sessionId: string; }' },
    { name: 'StatusRequest', create: StatusRequestSchema, declaration: 'export interface StatusRequest {}' },
    { name: 'GetRequest', create: GetRequestSchema, declaration: 'export interface GetRequest { readonly index: number; readonly requestId: number; }' },
    { name: 'RecordRequest', create: RecordRequestSchema, declaration: 'export interface RecordRequest { readonly text: string; readonly sessionId: string; }' },
    { name: 'ClearRequest', create: ClearRequestSchema, declaration: 'export interface ClearRequest {}' },
    { name: 'Entry', create: EntrySchema, declaration: 'export interface Entry { readonly id: number; readonly text: string; readonly ts: number; readonly kind: string; }' },
    { name: 'InitResult', create: InitResultSchema, declaration: 'export interface InitResult { readonly persistentCount: number; readonly localCount: number; readonly highWatermarkId: number; readonly sessionFilter: string; }' },
    { name: 'StatusResult', create: StatusResultSchema, declaration: 'export interface StatusResult { readonly persistentCount: number; readonly localCount: number; readonly total: number; }' },
    { name: 'GetResult', create: GetResultSchema, declaration: 'export interface GetResult { readonly requestId: number | null; readonly index: number; readonly total: number; readonly entry: Entry | null; }' },
    { name: 'RecordResult', create: RecordResultSchema, declaration: 'export interface RecordResult { readonly id: number; }' },
    { name: 'ClearResult', create: ClearResultSchema, declaration: 'export interface ClearResult {}' },
  ],
  invocations: [
    invocation('open', 'InitRequest', InitRequestSchema, 'InitResult', InitResultSchema),
    invocation('status', 'StatusRequest', StatusRequestSchema, 'StatusResult', StatusResultSchema),
    invocation('get', 'GetRequest', GetRequestSchema, 'GetResult', GetResultSchema),
    invocation('record', 'RecordRequest', RecordRequestSchema, 'RecordResult', RecordResultSchema),
    invocation('clear', 'ClearRequest', ClearRequestSchema, 'ClearResult', ClearResultSchema),
  ],
  events: [],
  objects: [],
}
