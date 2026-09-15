import {
  assistantStreamFirstTokenTime,
  expandAssistantStream,
  type AssistantStreamRecord,
  type TimedStreamChunk,
} from '@deepseek-ai/dsh-llm/assistant-stream'

export type JsonRecord = Record<string, unknown>

export type DshHeader = {
  type: 'session'
  version: number
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded?: boolean
  seedLength?: number
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
  [key: string]: unknown
}

export type DshEvent = {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
  ignorable?: true
}

export interface ParseIssue {
  line: number
  message: string
}

export interface ParsedSession {
  header: DshHeader
  events: DshEvent[]
  issues: ParseIssue[]
  sourceLines: number[]
  rawLineCount: number
}

export interface SessionStats {
  duration: number
  firstEventAt?: number
  lastEventAt?: number
  turns: number
  steps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  eventTypes: Map<string, number>
}

const PACKED_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertSafeInteger(value: unknown, label: string, min?: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (min !== undefined && (value as number) < min)) {
    throw new Error(`${label} must be ${min === 0 ? 'a non-negative ' : ''}safe integer`)
  }
}

function parseHeader(value: unknown): DshHeader {
  if (!isRecord(value) || value.type !== 'session') {
    throw new Error('first non-empty line must be a DSH session header')
  }
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('session header id must be a non-empty string')
  }
  assertSafeInteger(value.version, 'session header version', 0)
  assertSafeInteger(value.createdAt, 'session header createdAt', 0)
  if (value.cwd !== undefined && typeof value.cwd !== 'string') {
    throw new Error('session header cwd must be a string')
  }
  return value as DshHeader
}

function parseEvent(value: unknown): DshEvent {
  if (!isRecord(value)) throw new Error('event must be a JSON object')
  if (typeof value.type !== 'string' || value.type.length === 0) {
    throw new Error('event type must be a non-empty string')
  }
  assertSafeInteger(value.seq, 'event seq', 0)
  assertSafeInteger(value.time, 'event time')
  if (!Object.hasOwn(value, 'data')) throw new Error('event data is missing')
  if (value.sourceEventSeqs === undefined) return value as DshEvent
  return { ...value, sourceEventSeqs: decodeSeqRanges(value.sourceEventSeqs, value.seq) } as DshEvent
}

function decodeSeqRanges(value: unknown, eventSeq: number): number[] {
  if (!Array.isArray(value)) throw new Error('sourceEventSeqs must be an array')
  const output: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (!Array.isArray(entry)) {
      assertSafeInteger(entry, 'sourceEventSeqs member', 0)
      output.push(entry)
      continue
    }
    if (entry.length !== 2) throw new Error('sourceEventSeqs range must be a [start, end] pair')
    const [start, end] = entry
    assertSafeInteger(start, 'sourceEventSeqs range start', 0)
    assertSafeInteger(end, 'sourceEventSeqs range end', 0)
    if (start > end || end >= eventSeq) throw new Error('sourceEventSeqs range exceeds its event seq')
    for (let current = start; current <= end; current += 1) output.push(current)
    hasRange = true
  }
  const seen = new Set<number>()
  for (const source of output) {
    if (source >= eventSeq || seen.has(source)) throw new Error('sourceEventSeqs must contain unique earlier seqs')
    seen.add(source)
  }
  if (hasRange && output.some((source, index) => index > 0 && source <= (output[index - 1] as number))) {
    throw new Error('sourceEventSeqs ranges must be strictly increasing')
  }
  return output
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  return value
}

function expandPackedRow(value: JsonRecord): DshEvent[] {
  const type = value.type as string
  assertSafeInteger(value.seq0, `${type} seq0`, 0)
  assertSafeInteger(value.time0, `${type} time0`)
  if (!isRecord(value.data)) throw new Error(`${type} data must be an object`)

  const data = value.data
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    throw new Error(`${type} turn, step and index must be numbers`)
  }
  const members = type === 'tool-call-chunks'
    ? stringArray(data.args, `${type} args`)
    : stringArray(data.texts, `${type} texts`)
  const dt = data.dt
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    throw new Error(`${type} dt must be a safe-integer array`)
  }
  if (dt.length !== members.length - 1) {
    throw new Error(`${type} dt length does not match its members`)
  }
  if (type === 'tool-call-chunks' && typeof data.id !== 'string') {
    throw new Error(`${type} id must be a string`)
  }

  let time = value.time0 as number
  return members.map((member, index) => {
    if (index > 0) time += dt[index - 1] as number
    if (!Number.isSafeInteger(time)) throw new Error(`${type} member time exceeds safe integer range`)
    const chunk = type === 'text-chunks'
      ? { type: 'text-delta', index: data.index, text: member }
      : type === 'reasoning-chunks'
        ? { type: 'reasoning-delta', index: data.index, text: member }
        : {
            type: 'tool-call-delta',
            index: data.index,
            id: data.id,
            ...(typeof data.name === 'string' ? { name: data.name } : {}),
            argumentsDelta: member,
          }
    return {
      type: 'assistant/chunk',
      seq: (value.seq0 as number) + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    } as DshEvent
  })
}

export function parseDshJsonl(text: string): ParsedSession {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  let header: DshHeader | undefined
  const events: DshEvent[] = []
  const sourceLines: number[] = []
  const issues: ParseIssue[] = []
  let expectedSeq = 0

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim()
    if (!raw) continue
    const line = index + 1
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      throw new Error(`Line ${line}: invalid JSON (${error instanceof Error ? error.message : 'parse failed'})`)
    }

    if (header === undefined) {
      try {
        header = parseHeader(value)
      } catch (error) {
        throw new Error(`Line ${line}: ${error instanceof Error ? error.message : 'invalid header'}`)
      }
      continue
    }

    let decoded: DshEvent[]
    try {
      decoded = isRecord(value) && PACKED_TYPES.has(String(value.type))
        ? expandPackedRow(value)
        : [parseEvent(value)]
    } catch (error) {
      throw new Error(`Line ${line}: ${error instanceof Error ? error.message : 'invalid event'}`)
    }

    for (const event of decoded) {
      if (event.seq !== expectedSeq) {
        issues.push({ line, message: `Expected seq ${expectedSeq}, found ${event.seq}` })
        expectedSeq = event.seq
      }
      events.push(event)
      sourceLines.push(line)
      expectedSeq += 1
    }
  }

  if (header === undefined) throw new Error('The file is empty')
  return { header, events, issues, sourceLines, rawLineCount: lines.filter(line => line.trim()).length }
}

function numberAt(record: unknown, key: string): number {
  return isRecord(record) && typeof record[key] === 'number' ? record[key] as number : 0
}

export function getSessionStats(session: ParsedSession): SessionStats {
  const eventTypes = new Map<string, number>()
  const turns = new Set<number>()
  const steps = new Set<string>()
  let inputTokens = 0
  let outputTokens = 0
  let toolCalls = 0
  let toolErrors = 0

  for (const event of session.events) {
    eventTypes.set(event.type, (eventTypes.get(event.type) ?? 0) + 1)
    const data = isRecord(event.data) ? event.data : undefined
    if (typeof data?.turn === 'number') turns.add(data.turn)
    if (typeof data?.turn === 'number' && typeof data.step === 'number') steps.add(`${data.turn}:${data.step}`)
    if (event.type === 'tool/call') toolCalls += 1
    if (event.type === 'tool/result' && isRecord(data?.message)) {
      const content = data.message.content
      if (Array.isArray(content) && content.some(block => isRecord(block) && block.isError === true)) toolErrors += 1
    }
    if (event.type === 'assistant/message') {
      inputTokens += numberAt(data?.usage, 'inputTokens')
      outputTokens += numberAt(data?.usage, 'outputTokens')
    }
  }

  const firstEventAt = session.events.at(0)?.time
  const lastEventAt = session.events.at(-1)?.time
  return {
    duration: firstEventAt === undefined || lastEventAt === undefined ? 0 : Math.max(0, lastEventAt - firstEventAt),
    firstEventAt,
    lastEventAt,
    turns: turns.size,
    steps: steps.size,
    toolCalls,
    toolErrors,
    inputTokens,
    outputTokens,
    eventTypes,
  }
}

export function sessionTitle(session: ParsedSession): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if ((event?.type as string) === 'session/title' && isRecord(event?.data) && typeof event.data.title === 'string') {
      return event.data.title
    }
  }
  return undefined
}

export function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

/** Expand the compact stream embedded by DSH v2+ without duplicating its wire codec. */
export function eventAssistantStream(event: DshEvent): readonly TimedStreamChunk[] {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return []
  const data = isRecord(event.data) ? event.data : undefined
  if (!Array.isArray(data?.stream)) return []
  try {
    return expandAssistantStream(data.stream as AssistantStreamRecord[])
  } catch {
    // The raw event remains inspectable when a future or damaged stream cannot be expanded.
    return []
  }
}

/** Read first-token timing from the compact stream using DSH's canonical definition. */
export function eventFirstTokenTime(event: DshEvent): number | undefined {
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const data = isRecord(event.data) ? event.data : undefined
  if (!Array.isArray(data?.stream)) return undefined
  try {
    return assistantStreamFirstTokenTime(data.stream as AssistantStreamRecord[])
  } catch {
    return undefined
  }
}
