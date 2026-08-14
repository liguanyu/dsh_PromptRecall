// 手写的 typert 宿主面（TYPERT manifest）：
// 包导出 ./typert 指向本文件；dsh-typert-loader 挂载行时导入并注册到 ctx.typert，
// 网关据此校验参数/返回值并派发 promptRecall/<method>。
import { z } from 'zod'

const InitRequestSchema = z.object({ sessionId: z.string() })
const StatusRequestSchema = z.object({})
const GetRequestSchema = z.object({ index: z.number(), requestId: z.number() })
const RecordRequestSchema = z.object({ text: z.string(), sessionId: z.string() })
const ClearRequestSchema = z.object({})

const EntrySchema = z.object({ id: z.number(), text: z.string(), ts: z.number(), kind: z.string() })
const InitResultSchema = z.object({ persistentCount: z.number(), localCount: z.number(), highWatermarkId: z.number(), sessionFilter: z.string() })
const StatusResultSchema = z.object({ persistentCount: z.number(), localCount: z.number(), total: z.number() })
const GetResultSchema = z.object({ requestId: z.union([z.number(), z.null()]), index: z.number(), total: z.number(), entry: z.union([EntrySchema, z.null()]) })
const RecordResultSchema = z.object({ id: z.number() })
const ClearResultSchema = z.object({})

const PACKAGE = 'dsh-prompt-recall'
const SERVICE = 'promptRecall'

const invocation = (method, reqSchema, resSchema) => ({
  id: `${PACKAGE}#${SERVICE}/${method}`,
  service: SERVICE,
  namespace: SERVICE,
  method,
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Request`, schema: reqSchema },
  }],
  result: { mode: 'strict', typeSymbol: `${PACKAGE}#${method}Result`, schema: resSchema },
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
    { name: 'InitRequest', schema: InitRequestSchema, declaration: 'export interface InitRequest { readonly sessionId: string; }' },
    { name: 'StatusRequest', schema: StatusRequestSchema, declaration: 'export interface StatusRequest {}' },
    { name: 'GetRequest', schema: GetRequestSchema, declaration: 'export interface GetRequest { readonly index: number; readonly requestId: number; }' },
    { name: 'RecordRequest', schema: RecordRequestSchema, declaration: 'export interface RecordRequest { readonly text: string; readonly sessionId: string; }' },
    { name: 'ClearRequest', schema: ClearRequestSchema, declaration: 'export interface ClearRequest {}' },
    { name: 'Entry', schema: EntrySchema, declaration: 'export interface Entry { readonly id: number; readonly text: string; readonly ts: number; readonly kind: string; }' },
    { name: 'InitResult', schema: InitResultSchema, declaration: 'export interface InitResult { readonly persistentCount: number; readonly localCount: number; readonly highWatermarkId: number; readonly sessionFilter: string; }' },
    { name: 'StatusResult', schema: StatusResultSchema, declaration: 'export interface StatusResult { readonly persistentCount: number; readonly localCount: number; readonly total: number; }' },
    { name: 'GetResult', schema: GetResultSchema, declaration: 'export interface GetResult { readonly requestId: number | null; readonly index: number; readonly total: number; readonly entry: Entry | null; }' },
    { name: 'RecordResult', schema: RecordResultSchema, declaration: 'export interface RecordResult { readonly id: number; }' },
    { name: 'ClearResult', schema: ClearResultSchema, declaration: 'export interface ClearResult {}' },
  ],
  invocations: [
    invocation('open', InitRequestSchema, InitResultSchema),
    invocation('status', StatusRequestSchema, StatusResultSchema),
    invocation('get', GetRequestSchema, GetResultSchema),
    invocation('record', RecordRequestSchema, RecordResultSchema),
    invocation('clear', ClearRequestSchema, ClearResultSchema),
  ],
  events: [],
  objects: [],
}
