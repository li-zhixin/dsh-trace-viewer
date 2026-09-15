/* Direct port of DSH TrajectoryToolbar, TrajectoryTimeline and the primary
 * TrajectoryTable split-pane presentation. The local code only projects
 * session.jsonl events into the records consumed by that presentation. */
import { ChevronLeft, ChevronRight, Clock3, Maximize2, Search, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react'
import { createTwoFilesPatch } from 'diff'
import { asRecord, eventAssistantStream, eventFirstTokenTime, type DshEvent } from '../lib/dsh'
import { formatDuration } from '../lib/format'
import { JsonBlock } from './JsonBlock'

type Kind = 'system' | 'request' | 'user' | 'context' | 'message' | 'tool' | 'retry' | 'command' | 'notice' | 'compaction' | 'boundary'
type DetailTab = 'summary' | 'preview' | 'source' | 'input' | 'output' | 'schema' | 'options' | 'tools' | 'usage' | 'timing' | 'diff' | 'attempts' | 'raw'

interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

interface RequestAttempt {
  seq: number
  time: number
  error?: string
  errorCode?: string
  reasoning?: string
  content?: string
}

interface LedgerRow {
  index: number
  kind: Kind
  text: string
  event: DshEvent
  turn: number
  step: number
  startedAt: number
  completedAt: number
  firstTokenAt?: number
  request?: string
  result?: string
  reasoning?: string
  content?: string
  usage?: Usage
  error?: boolean
  collapsedSummary?: string
  collapsedSummaryKind?: 'turn' | 'assistant'
  collapsedTarget?: number
  status?: 'running' | 'complete' | 'error' | 'interrupted'
  provider?: string
  model?: string
  parentCallId?: string
  callId?: string
  callIds?: string[]
  options?: unknown
  tools?: unknown
  requestNumber?: number
  requestReason?: string
  source?: unknown
  schema?: unknown
  previousContent?: string
  previousTools?: unknown
  requestContext?: unknown
  cumulativeUsage?: Usage
  attempts?: RequestAttempt[]
  requestOnly?: boolean
  replacementSeq?: number
  shadowedItemCount?: number
  shadowedTokenCount?: number
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value) as Record<string, unknown> | undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function contentText(value: unknown, compact = false): string {
  if (typeof value === 'string') return compact ? value.replace(/\s+/g, ' ').trim() : value
  return array(value).map(item => {
    const block = rec(item)
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (block?.type === 'tool-result') return contentText(block.content, compact)
    return ''
  }).join(compact ? ' ' : '')
}

function assistantParts(value: unknown): { content: string; reasoning: string; tools: string[]; callIds: string[] } {
  const content: string[] = []
  const reasoning: string[] = []
  const tools: string[] = []
  const callIds: string[] = []
  for (const raw of array(value)) {
    const block = rec(raw)
    if (block?.type === 'text' && typeof block.text === 'string') content.push(block.text)
    else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text)
    else if (block?.type === 'tool-call') {
      tools.push(`${String(block.name ?? 'tool')} ${String(block.arguments ?? '')}`)
      if (typeof block.id === 'string') callIds.push(block.id)
    }
  }
  return { content: content.join('\n\n'), reasoning: reasoning.join('\n\n'), tools, callIds }
}

function streamParts(event: DshEvent): ReturnType<typeof assistantParts> {
  const content: string[] = []
  const reasoning: string[] = []
  const tools = new Map<number, { name: string; args: string }>()
  for (const member of eventAssistantStream(event)) {
    const chunk = rec(member.chunk)
    const index = typeof chunk?.index === 'number' ? chunk.index : tools.size
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') content.push(chunk.text)
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning.push(chunk.text)
    else if (chunk?.type === 'tool-call-delta') {
      const current = tools.get(index) ?? { name: '', args: '' }
      tools.set(index, {
        name: typeof chunk.name === 'string' ? chunk.name : current.name,
        args: current.args + (typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''),
      })
    }
  }
  return { content: content.join(''), reasoning: reasoning.join(''), tools: [...tools.values()].map(tool => requestSummary(tool.name || 'tool', tool.args)), callIds: [] }
}

function failureText(value: unknown): string | undefined {
  const failure = rec(value)
  if (failure?.code === 'AUTH') return 'Authentication failed'
  return typeof failure?.message === 'string' ? failure.message : undefined
}

function hasError(value: unknown): boolean {
  return array(value).some(item => { const block = rec(item); return block?.isError === true || hasError(block?.content) })
}

function requestSummary(name: string, args: string): string {
  return `${name} ${args}`.trim()
}

function addUsage(current: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (next === undefined) return current
  const result = { ...current }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key]
  }
  return result
}

export function deriveRows(events: DshEvent[]): LedgerRow[] {
  const rows: LedgerRow[] = []
  const calls = new Map<string, { event: DshEvent; name: string; args: string; turn: number; step: number }>()
  const settledCalls = new Set<string>()
  const stepStarts = new Map<string, number>()
  const firstTokens = new Map<string, number>()
  const compactions = new Map<string, LedgerRow>()
  const retries = new Map<string, LedgerRow>()
  const commands = new Map<string, LedgerRow>()
  const attemptsByStep = new Map<string, RequestAttempt[]>()
  const assistantSteps = new Set<string>()
  const schemas = new Map<string, unknown>()
  let currentTurn = 1
  let currentStep = 0
  let requestNumber = 0
  let currentRequestNumber = 0
  let currentProvider: string | undefined
  let currentModel: string | undefined
  let currentRequest: LedgerRow | undefined
  let cumulativeUsage: Usage | undefined
  let effectiveSystem = ''
  let effectiveTools: unknown
  let index = 0

  for (const event of events) {
    const data = rec(event.data)
    if (event.type === 'turn/start' && typeof data?.turn === 'number') {
      currentTurn = data.turn
      currentStep = 0
    }
    if (event.type === 'step/start') {
      const turn = typeof data?.turn === 'number' ? data.turn : currentTurn
      const step = typeof data?.step === 'number' ? data.step : 0
      currentStep = step
      stepStarts.set(`${turn}:${step}`, event.time)
      continue
    }
    const turn = typeof data?.turn === 'number' ? data.turn : currentTurn
    const step = typeof data?.step === 'number' ? data.step : currentStep

    if (event.type === 'assistant/chunk') {
      const key = `${turn}:${step}`
      if (!firstTokens.has(key)) firstTokens.set(key, event.time)
    } else if (event.type === 'system/message') {
      const message = rec(data?.message)
      const prompt = contentText(message?.content)
      if (prompt !== '') {
        const previousContent = effectiveSystem === '' || effectiveSystem === prompt ? undefined : effectiveSystem
        rows.push({ index: ++index, kind: 'system', text: previousContent === undefined ? 'System prompt' : 'System prompt update', event, turn, step, startedAt: event.time, completedAt: event.time, content: prompt, ...(previousContent === undefined ? {} : { previousContent }), status: 'complete', source: message?.source })
        effectiveSystem = prompt
      }
    } else if (event.type === 'request/header') {
      const header = rec(data?.header)
      const config = rec(header?.config)
      const prompt = typeof header?.system === 'string' ? header.system : ''
      if (prompt !== '') {
        const previousContent = effectiveSystem === '' || effectiveSystem === prompt ? undefined : effectiveSystem
        rows.push({ index: ++index, kind: 'system', text: previousContent === undefined ? 'System prompt' : 'System prompt update', event, turn, step, startedAt: event.time, completedAt: event.time, content: prompt, ...(previousContent === undefined ? {} : { previousContent }), status: 'complete' })
        effectiveSystem = prompt
      }
      requestNumber += 1
      currentRequestNumber = requestNumber
      currentProvider = typeof config?.provider === 'string' ? config.provider : undefined
      currentModel = typeof config?.model === 'string' ? config.model : undefined
      const route = [currentProvider, currentModel].filter(Boolean).join('/')
      const reason = typeof data?.reason === 'string' ? data.reason : undefined
      const tools = header?.tools
      if (Array.isArray(tools)) {
        for (const raw of tools) {
          const tool = rec(raw)
          if (typeof tool?.name === 'string') schemas.set(tool.name, raw)
        }
      }
      const previousTools = effectiveTools === undefined || JSON.stringify(effectiveTools) === JSON.stringify(tools) ? undefined : effectiveTools
      const row: LedgerRow = {
        index: ++index, kind: 'request', text: `Request #${requestNumber}${route === '' ? '' : ` · ${route}`}${reason === undefined ? '' : ` · ${reason}`}`,
        event, turn, step, startedAt: event.time, completedAt: event.time, status: 'running',
        options: header?.config, tools, requestNumber,
        ...(previousTools === undefined ? {} : { previousTools }),
        ...(reason === undefined ? {} : { requestReason: reason }),
        ...(currentProvider === undefined ? {} : { provider: currentProvider }),
        ...(currentModel === undefined ? {} : { model: currentModel }),
      }
      rows.push(row)
      currentRequest = row
      effectiveTools = tools
    } else if (event.type === 'request/context') {
      currentProvider = typeof data?.provider === 'string' ? data.provider : currentProvider
      currentModel = typeof data?.model === 'string' ? data.model : currentModel
      if (currentRequest !== undefined) {
        currentRequest.requestContext = data
        currentRequest.provider = currentProvider
        currentRequest.model = currentModel
      }
    } else if (event.type === 'user/message') {
      const source = rec(data?.source)
      const compactionId = source?.kind === 'plugin' && source.plugin === 'compact' && typeof source.compactionId === 'string' ? source.compactionId : undefined
      if (compactionId !== undefined) {
        const compaction = compactions.get(compactionId)
        if (compaction !== undefined) {
          compaction.replacementSeq = event.seq
          continue
        }
      }
      const injected = (source !== undefined && source.kind !== 'user') || data?.provenance !== undefined || data?.synthetic === true
      rows.push({ index: ++index, kind: injected ? 'context' : 'user', text: contentText(data?.content, true), event, turn, step, startedAt: event.time, completedAt: event.time, content: contentText(data?.content), source })
    } else if (event.type === 'assistant/message') {
      const message = rec(data?.message)
      const parts = assistantParts(message?.content)
      const usage = rec(data?.usage ?? message?.usage) as Usage | undefined
      const source = rec(message?.source)
      const key = `${turn}:${step}`
      assistantSteps.add(key)
      cumulativeUsage = addUsage(cumulativeUsage, usage)
      const firstTokenAt = eventFirstTokenTime(event) ?? firstTokens.get(`${turn}:${step}`)
      if (currentRequest !== undefined) {
        currentRequest.completedAt = event.time
        currentRequest.firstTokenAt = firstTokenAt
        currentRequest.usage = usage
        currentRequest.cumulativeUsage = cumulativeUsage
        currentRequest.attempts = attemptsByStep.get(key)
        currentRequest.status = 'complete'
      }
      rows.push({
        index: ++index,
        kind: 'message',
        text: parts.content || parts.reasoning || parts.tools[0] || 'Assistant response',
        event,
        turn,
        step,
        startedAt: stepStarts.get(`${turn}:${step}`) ?? event.time,
        completedAt: event.time,
        firstTokenAt,
        content: parts.content,
        reasoning: parts.reasoning,
        request: currentRequestNumber === 0 ? undefined : `Request #${currentRequestNumber}`,
        requestNumber: currentRequestNumber === 0 ? undefined : currentRequestNumber,
        callIds: parts.callIds,
        usage,
        cumulativeUsage,
        attempts: attemptsByStep.get(key),
        status: data?.interrupted === true ? 'interrupted' : 'complete',
        ...(typeof source?.provider === 'string' ? { provider: source.provider } : currentProvider === undefined ? {} : { provider: currentProvider }),
        ...(typeof source?.model === 'string' ? { model: source.model } : currentModel === undefined ? {} : { model: currentModel }),
      })
    } else if (event.type === 'assistant/attempt') {
      const parts = streamParts(event)
      const finish = [...eventAssistantStream(event)].reverse().map(member => rec(member.chunk)).find(chunk => chunk?.type === 'finish')
      const reason = rec(finish?.reason)
      const detail = reason?.kind === 'error' ? failureText(reason.error) : undefined
      const key = `${turn}:${step}`
      const attempts = attemptsByStep.get(key) ?? []
      const failure = rec(reason?.error)
      attempts.push({ seq: event.seq, time: event.time, ...(detail === undefined ? {} : { error: detail }), ...(typeof failure?.code === 'string' ? { errorCode: failure.code } : {}), ...(parts.reasoning === '' ? {} : { reasoning: parts.reasoning }), ...(parts.content === '' ? {} : { content: parts.content }) })
      attemptsByStep.set(key, attempts)
      if (currentRequest !== undefined) currentRequest.attempts = attempts
    } else if (event.type === 'llm/retry') {
      const detail = failureText(data?.failure)
      const retry = typeof data?.retry === 'number' ? data.retry : undefined
      const retryId = typeof data?.retryId === 'string' && data.retryId !== '' ? data.retryId : String(event.seq)
      const previous = retries.get(retryId)
      if (previous === undefined) {
        const row: LedgerRow = { index: ++index, kind: 'retry', text: retry === undefined ? 'Model retry scheduled' : `Model retry ${retry} scheduled`, event, turn, step, startedAt: event.time, completedAt: event.time, content: detail, status: 'running', provider: typeof data?.provider === 'string' ? data.provider : undefined, attempts: attemptsByStep.get(`${turn}:${step}`), requestNumber: currentRequestNumber || undefined }
        retries.set(retryId, row)
        rows.push(row)
      } else {
        previous.text = retry === undefined ? 'Model retry scheduled' : `Model retry ${retry} scheduled`
        previous.event = event
        previous.completedAt = event.time
        previous.content = detail
        previous.status = 'running'
      }
    } else if (event.type === 'llm/retry-started') {
      const retryId = typeof data?.retryId === 'string' ? data.retryId : ''
      const row = retries.get(retryId)
      if (row !== undefined) {
        const retry = typeof data?.retry === 'number' ? data.retry : undefined
        row.text = retry === undefined ? 'Model retry started' : `Model retry ${retry} started`
        row.event = event
        row.completedAt = event.time
        row.status = 'complete'
      }
    } else if (event.type === 'command/run') {
      const commandId = String(data?.commandId ?? event.seq)
      const name = typeof data?.name === 'string' ? data.name : 'command'
      const args = typeof data?.args === 'string' ? data.args : undefined
      const row: LedgerRow = { index: ++index, kind: 'command', text: `/${name}${args ?? ''}`, event, turn, step, startedAt: event.time, completedAt: event.time, request: args, status: 'running' }
      commands.set(commandId, row)
      rows.push(row)
    } else if (event.type === 'command/done') {
      const commandId = String(data?.commandId ?? event.seq)
      let row = commands.get(commandId)
      if (row === undefined) {
        row = { index: ++index, kind: 'command', text: '/command', event, turn, step, startedAt: event.time, completedAt: event.time }
        commands.set(commandId, row)
        rows.push(row)
      }
      row.event = event
      row.completedAt = event.time
      row.result = typeof data?.text === 'string' ? data.text : undefined
      row.content = row.result
      row.error = data?.kind === 'error'
      row.status = row.error ? 'error' : 'complete'
    } else if (event.type === 'tool/call') {
      const callId = typeof data?.callId === 'string' ? data.callId : `call-${event.seq}`
      calls.set(callId, {
        event,
        name: typeof data?.name === 'string' ? data.name : 'tool',
        args: typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? {}),
        turn,
        step,
      })
    } else if (event.type === 'tool/result') {
      const message = rec(data?.message)
      const source = rec(message?.source)
      if (typeof source?.callId !== 'string') continue
      const call = calls.get(source.callId)
      const result = contentText(message?.content)
      settledCalls.add(source.callId)
      rows.push({
        index: ++index,
        kind: 'tool',
        text: requestSummary(call?.name ?? 'tool', call?.args ?? ''),
        event,
        turn: call?.turn ?? turn,
        step: call?.step ?? step,
        startedAt: call?.event.time ?? event.time,
        completedAt: event.time,
        request: call?.args,
        result,
        content: result,
        error: hasError(message?.content),
        status: hasError(message?.content) || data?.error !== undefined ? 'error' : 'complete',
        schema: call === undefined ? undefined : schemas.get(call.name),
        callId: source.callId,
        requestNumber: currentRequestNumber || undefined,
      })
    } else if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/code-dispatch-start') {
      const callId = typeof data?.subCallId === 'string' ? data.subCallId : `ptc-${event.seq}`
      calls.set(callId, {
        event, name: typeof data?.name === 'string' ? data.name : 'tool',
        args: JSON.stringify(data?.arguments ?? {}), turn, step,
      })
    } else if (event.type === 'tool/ptc-dispatch' || event.type === 'tool/code-dispatch') {
      const callId = typeof data?.subCallId === 'string' ? data.subCallId : `ptc-${event.seq}`
      const call = calls.get(callId)
      const result = contentText(data?.content)
      settledCalls.add(callId)
      rows.push({
        index: ++index, kind: 'tool', text: requestSummary(call?.name ?? String(data?.name ?? 'tool'), call?.args ?? JSON.stringify(data?.arguments ?? {})),
        event, turn, step, startedAt: call?.event.time ?? event.time, completedAt: event.time,
        request: call?.args, result, content: result, error: data?.isError === true,
        status: data?.isError === true ? 'error' : 'complete',
        callId,
        requestNumber: currentRequestNumber || undefined,
        ...(typeof data?.parentCallId === 'string' ? { parentCallId: data.parentCallId } : {}),
      })
    } else if (event.type === 'compaction/start') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : String(event.seq)
      const row: LedgerRow = { index: ++index, kind: 'compaction', text: 'Compacting conversation', event, turn: typeof data?.turn === 'number' ? data.turn : 0, step: 0, startedAt: event.time, completedAt: event.time, status: 'running' }
      compactions.set(id, row)
      rows.push(row)
    } else if (event.type === 'compaction/summary') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : ''
      const row = compactions.get(id)
      if (row !== undefined) {
        row.result = contentText(data?.summary)
        row.content = row.result
        row.usage = rec(data?.usage) as Usage | undefined
        row.provider = typeof data?.provider === 'string' ? data.provider : undefined
        row.model = typeof data?.model === 'string' ? data.model : undefined
        row.shadowedItemCount = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : undefined
        row.shadowedTokenCount = typeof data?.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined
      }
    } else if (event.type === 'compaction/end') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : ''
      const row = compactions.get(id)
      if (row !== undefined) {
        row.event = event
        row.completedAt = event.time
        row.error = data?.error !== undefined
        row.status = row.error ? 'error' : 'complete'
        row.text = row.error ? 'Conversation compaction failed' : 'Conversation compacted'
        if (typeof data?.error === 'string') row.result = data.error
      }
    } else if (event.type === 'turn/end') {
      const reason = rec(data?.reason)
      if (reason?.kind === 'error') {
        const detail = failureText(reason.error) ?? 'Turn failed'
        if (currentRequest?.status === 'running') {
          currentRequest.completedAt = event.time
          currentRequest.status = 'error'
          currentRequest.error = true
          currentRequest.result = detail
        }
        rows.push({ index: ++index, kind: 'notice', text: 'Turn failed', event, turn, step, startedAt: event.time, completedAt: event.time, content: detail, result: detail, error: true, status: 'error' })
      } else if (reason?.kind === 'max-tokens') {
        if (currentRequest?.status === 'running') {
          currentRequest.completedAt = event.time
          currentRequest.status = 'complete'
        }
        rows.push({ index: ++index, kind: 'notice', text: 'Maximum output tokens reached', event, turn, step, startedAt: event.time, completedAt: event.time, content: 'The response may be incomplete.', status: 'complete' })
      }
    } else if (event.type === 'step/end') {
      const key = `${turn}:${step}`
      const attempts = attemptsByStep.get(key)
      if (!assistantSteps.has(key) && attempts !== undefined && attempts.length > 0) {
        const latest = attempts.at(-1)
        if (currentRequest !== undefined) {
          currentRequest.completedAt = event.time
          currentRequest.status = 'error'
          currentRequest.error = true
          currentRequest.result = latest?.error
          currentRequest.attempts = attempts
        }
        rows.push({ index: ++index, kind: 'message', text: latest?.error ?? 'Model request failed', event, turn, step, startedAt: stepStarts.get(key) ?? event.time, completedAt: event.time, content: latest?.content, reasoning: latest?.reasoning, result: latest?.error, error: true, status: 'error', requestOnly: true, attempts, request: currentRequest?.requestNumber === undefined ? undefined : `Request #${currentRequest.requestNumber}`, requestNumber: currentRequest?.requestNumber, provider: currentProvider, model: currentModel })
      }
    } else if (event.type === 'session/end-seed') {
      rows.push({ index: ++index, kind: 'boundary', text: 'End of seeded history', event, turn: 0, step: 0, startedAt: event.time, completedAt: event.time, status: 'complete' })
    }
  }

  for (const [callId, call] of calls) {
    if (settledCalls.has(callId)) continue
    rows.push({ index: ++index, kind: 'tool', text: requestSummary(call.name, call.args), event: call.event, turn: call.turn, step: call.step, startedAt: call.event.time, completedAt: call.event.time, request: call.args, status: 'running', callId })
  }

  rows.forEach((row, position) => { row.index = position + 1 })
  return rows
}

function summarizeTurn(rows: readonly LedgerRow[]): string {
  const steps = new Set(rows.map(row => row.step).filter(step => step > 0)).size
  const calls = rows.filter(row => row.kind === 'tool').length
  return `${steps} ${steps === 1 ? 'step' : 'steps'} · ${calls} tool ${calls === 1 ? 'call' : 'calls'}`
}

/** Match DSH's turn fold: keep the first row and append a clickable summary. */
function collapseTurnRows(rows: readonly LedgerRow[], collapsedTurns: ReadonlySet<number>): LedgerRow[] {
  const recordsByTurn = new Map<number, LedgerRow[]>()
  for (const row of rows) {
    if (row.turn === 0) continue
    const records = recordsByTurn.get(row.turn) ?? []
    records.push(row)
    recordsByTurn.set(row.turn, records)
  }
  return rows.flatMap(row => {
    if (row.turn === 0 || !collapsedTurns.has(row.turn)) return [row]
    const records = recordsByTurn.get(row.turn) ?? [row]
    if (records.length <= 1 || row.index !== records[0]?.index) return row.index === records[0]?.index ? [row] : []
    return [
      row,
      {
        ...row,
        text: summarizeTurn(records.slice(1)),
        content: undefined,
        request: undefined,
        result: undefined,
        collapsedSummary: summarizeTurn(records.slice(1)),
        collapsedSummaryKind: 'turn' as const,
        collapsedTarget: row.turn,
      },
    ]
  })
}

function summarizeAssistantTools(rows: readonly LedgerRow[]): string {
  const names = [...new Set(rows.map(row => row.text.split(' · ', 1)[0]).filter(Boolean))]
  const summary = `${rows.length} tool ${rows.length === 1 ? 'call' : 'calls'}`
  return names.length > 0 ? `${summary} · ${names.join(', ')}` : summary
}

/** Match DSH's assistant fold: keep the assistant row and summarize its calls. */
function collapseAssistantRows(rows: readonly LedgerRow[], collapsedAssistants: ReadonlySet<number>): LedgerRow[] {
  const output: LedgerRow[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) continue
    output.push(row)
    if (row.kind !== 'message' || !collapsedAssistants.has(row.index)) continue
    const calls: LedgerRow[] = []
    for (let next = index + 1; next < rows.length; next += 1) {
      const candidate = rows[next]
      if (!candidate || candidate.kind !== 'tool' || candidate.collapsedSummary !== undefined) break
      calls.push(candidate)
    }
    if (calls.length === 0) continue
    const summary = summarizeAssistantTools(calls)
    output[output.length - 1] = { ...row }
    output.push({
      ...row,
      text: summary,
      content: undefined,
      request: undefined,
      result: undefined,
      event: calls[calls.length - 1]?.event ?? row.event,
      collapsedSummary: summary,
      collapsedSummaryKind: 'assistant',
      collapsedTarget: row.index,
    })
    index += calls.length
  }
  return output
}

const LABELS: Record<Kind, string> = { system: 'SYSTEM', request: 'REQUEST', user: 'USER', context: 'CONTEXT', message: 'ASSISTANT', tool: 'TOOL', retry: 'RETRY', command: 'COMMAND', notice: 'NOTICE', compaction: 'COMPACT', boundary: 'BOUNDARY' }

interface TimelineProjection { row: LedgerRow; start: number; end: number }
interface FractionRange { start: number; end: number }

/** DSH's two timeline projections: sequence slots versus recorded durations
 * with idle gaps removed. */
function projectTimeline(rows: LedgerRow[], duration: boolean): TimelineProjection[] {
  const timed = rows.filter(row => row.kind !== 'system' && row.kind !== 'request' && row.kind !== 'retry' && row.kind !== 'notice' && row.kind !== 'boundary')
  if (!duration) return timed.map((row, index) => ({ row, start: index, end: index + 1 }))

  const raw = timed.map(row => ({ row, start: row.startedAt, end: Math.max(row.startedAt, row.completedAt) }))
    .sort((left, right) => left.start - right.start || left.end - right.end)
  if (raw.length === 0) return []
  const offsets = new Map<number, number>()
  let removedIdle = 0
  let coveredUntil: number | null = null
  for (const span of raw) {
    if (coveredUntil !== null && span.start > coveredUntil) removedIdle += span.start - coveredUntil
    offsets.set(span.row.index, removedIdle)
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end)
  }
  return raw.map(span => {
    const offset = offsets.get(span.row.index) ?? 0
    return { row: span.row, start: span.start - offset, end: span.end - offset }
  })
}

function timelineFractions(rows: LedgerRow[], duration: boolean): { span: TimelineProjection; start: number; end: number }[] {
  const spans = projectTimeline(rows, duration)
  const start = spans.length === 0 ? 0 : Math.min(...spans.map(span => span.start))
  const end = spans.length === 0 ? 1 : Math.max(...spans.map(span => span.end), start + 1)
  const domain = Math.max(1, end - start)
  return spans.map(span => ({ span, start: (span.start - start) / domain, end: (span.end - start) / domain }))
}

function TimelineOverview({ rows, duration, selected, searchMatches, viewport, range, onViewport, onRange, onSelect, onFocus }: { rows: LedgerRow[]; duration: boolean; selected: number | null; searchMatches: ReadonlySet<number> | null; viewport: FractionRange; range: FractionRange | null; onViewport: (range: FractionRange) => void; onRange: (range: FractionRange | null) => void; onSelect: (index: number) => void; onFocus: (index: number) => void }) {
  const spans = timelineFractions(rows, duration)
  const [drag, setDrag] = useState<{ anchor: number; current: number; clientX: number; pointerId: number } | null>(null)
  const viewportWidth = Math.max(.01, viewport.end - viewport.start)
  const point = (event: Pick<ReactPointerEvent<HTMLDivElement>, 'clientX' | 'currentTarget'>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.min(1, Math.max(0, viewport.start + ((event.clientX - rect.left) / Math.max(1, rect.width)) * viewportWidth))
  }
  const focusNearest = (value: number) => {
    const nearest = spans.reduce<{ index: number; distance: number } | undefined>((best, item) => {
      const distance = Math.abs((item.start + item.end) / 2 - value)
      return best === undefined || distance < best.distance ? { index: item.span.row.index, distance } : best
    }, undefined)
    if (nearest !== undefined) onFocus(nearest.index)
  }
  const wheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const center = viewport.start + ((event.clientX - rect.left) / Math.max(1, rect.width)) * viewportWidth
    if (event.shiftKey) {
      const delta = Math.sign(event.deltaY || event.deltaX) * viewportWidth * .12
      const start = Math.min(1 - viewportWidth, Math.max(0, viewport.start + delta))
      onViewport({ start, end: start + viewportWidth })
      return
    }
    const nextWidth = Math.min(1, Math.max(.05, viewportWidth * (event.deltaY > 0 ? 1.25 : .8)))
    const ratio = (center - viewport.start) / viewportWidth
    const start = Math.min(1 - nextWidth, Math.max(0, center - nextWidth * ratio))
    onViewport({ start, end: start + nextWidth })
  }
  const visibleRange = drag === null ? range : { start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current) }
  return <div className="dsh-timeline-overview"><div className="dsh-timeline-labels"><span>Input</span><span>Model</span><span>Tools</span></div><div className="dsh-timeline-track" tabIndex={0} aria-label="Trajectory timeline. Drag to select a range; use the mouse wheel to zoom." data-dragging={drag !== null || undefined} onKeyDown={event => { if (event.key === 'Escape') { setDrag(null); onRange(null) } }} onWheel={wheel} onPointerDown={event => {
    if (event.target !== event.currentTarget) return
    const value = point(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ anchor: value, current: value, clientX: event.clientX, pointerId: event.pointerId })
  }} onPointerMove={event => { if (drag?.pointerId === event.pointerId) setDrag({ ...drag, current: point(event) }) }} onPointerUp={event => {
    if (drag?.pointerId !== event.pointerId) return
    const current = point(event)
    const moved = Math.abs(event.clientX - drag.clientX) >= 3
    setDrag(null)
    if (moved) onRange({ start: Math.min(drag.anchor, current), end: Math.max(drag.anchor, current) })
    else focusNearest(current)
  }} onPointerCancel={() => setDrag(null)} onDoubleClick={() => onRange(null)}>{visibleRange !== null && <span className="dsh-timeline-range" style={{ '--timeline-range-left': `${(visibleRange.start - viewport.start) / viewportWidth * 100}%`, '--timeline-range-width': `${(visibleRange.end - visibleRange.start) / viewportWidth * 100}%` } as CSSProperties} />}{spans.map((item, index) => {
    const globalStart = item.start
    const globalEnd = Math.max(item.end, globalStart + 1 / Math.max(1, spans.length))
    if (globalEnd < viewport.start || globalStart > viewport.end) return null
    const leftFraction = (Math.max(globalStart, viewport.start) - viewport.start) / viewportWidth
    const widthFraction = Math.max(0, (Math.min(globalEnd, viewport.end) - Math.max(globalStart, viewport.start)) / viewportWidth)
    const widthPercent = widthFraction * 100
    const style = {
      '--timeline-left': `${leftFraction * 100}%`,
      '--timeline-width': `${widthPercent}%`,
      '--timeline-gap': `min(${widthPercent * 0.08}%, 1px)`,
    } as CSSProperties
    const row = item.span.row
    const timing = `${new Date(row.startedAt).toLocaleTimeString()}${row.completedAt === row.startedAt ? '' : ` → ${new Date(row.completedAt).toLocaleTimeString()} · ${formatDuration(row.completedAt - row.startedAt)}`}`
    return <button type="button" key={row.index} className={`dsh-timeline-span dsh-timeline-${row.kind} ${selected === row.index ? 'selected' : ''} ${searchMatches?.has(row.index) === true ? 'search-match' : ''}`} style={style} onPointerDown={event => event.stopPropagation()} onClick={() => onSelect(row.index)} aria-label={`${LABELS[row.kind]} ${row.index}`} title={`${LABELS[row.kind]}\n${timing}`} data-timeline-position={index} />
  })}</div></div>
}

interface LedgerStepGroup { step: number; rows: LedgerRow[] }
interface LedgerTurnGroup { turn: number; groups: LedgerStepGroup[] }
type LedgerVirtualRow =
  | { key: string; height: number; type: 'turn'; turn: LedgerTurnGroup }
  | { key: string; height: number; type: 'step'; turn: LedgerTurnGroup; group: LedgerStepGroup }
  | { key: string; height: number; type: 'record'; turn: LedgerTurnGroup; group: LedgerStepGroup; row: LedgerRow }

export function groupLedgerRows(rows: readonly LedgerRow[]): LedgerTurnGroup[] {
  const turns: LedgerTurnGroup[] = []
  for (const row of rows) {
    let turn = turns.at(-1)
    if (turn?.turn !== row.turn) {
      turn = { turn: row.turn, groups: [] }
      turns.push(turn)
    }
    let group = turn.groups.at(-1)
    if (group?.step !== row.step) {
      group = { step: row.step, rows: [] }
      turn.groups.push(group)
    }
    group.rows.push(row)
  }
  return turns
}

export function projectLedgerVirtualRows(rows: readonly LedgerRow[]): LedgerVirtualRow[] {
  return groupLedgerRows(rows).flatMap((turn, turnIndex) => [
    { key: `turn:${turn.turn}:${turnIndex}`, height: 28, type: 'turn' as const, turn },
    ...turn.groups.flatMap((group, groupIndex) => [
      { key: `step:${turn.turn}:${turnIndex}:${group.step}:${groupIndex}`, height: 24, type: 'step' as const, turn, group },
      ...group.rows.map(row => ({ key: `row:${row.index}:${row.collapsedSummaryKind ?? 'record'}`, height: row.collapsedSummary === undefined ? 30 : 20, type: 'record' as const, turn, group, row })),
    ]),
  ])
}

function useStableVirtualRowStructure(rows: readonly LedgerVirtualRow[]) {
  const cache = useRef<{ rows: readonly LedgerVirtualRow[]; structure: readonly { key: string; height: number }[] }>({ rows: [], structure: [] })
  if (cache.current.rows === rows) return cache.current.structure
  const structure = cache.current.structure.length === rows.length && rows.every((row, index) => {
    const previous = cache.current.structure[index]
    return previous?.key === row.key && previous.height === row.height
  }) ? cache.current.structure : rows.map(row => ({ key: row.key, height: row.height }))
  cache.current = { rows, structure }
  return structure
}

function LedgerRecord({ row, selected, onSelect, onToggleTurn, onToggleAssistant }: { row: LedgerRow; selected: number | null; onSelect: (index: number) => void; onToggleTurn: (turn: number) => void; onToggleAssistant: (index: number) => void }) {
  const summary = row.collapsedSummary !== undefined
  const toggle = () => {
    if (row.collapsedSummaryKind === 'turn') onToggleTurn(row.collapsedTarget ?? row.turn)
    else if (row.collapsedSummaryKind === 'assistant') onToggleAssistant(row.collapsedTarget ?? row.index)
    else onSelect(row.index)
  }
  return <tr tabIndex={0} data-kind={row.kind} data-record-index={summary ? undefined : row.index} data-selected={!summary && selected === row.index || undefined} data-collapsed-summary={row.collapsedSummaryKind} onClick={toggle}><td className="dsh-ledger-event">{row.turn > 0 && <span className="dsh-ledger-turn-rail" />}{!summary && selected === row.index && <span className="dsh-ledger-selection-rail" />}<div>{!summary && <span className={`dsh-ledger-kind dsh-ledger-${row.kind}`}>{LABELS[row.kind]}</span>}</div></td><td className="dsh-ledger-content">{summary ? <span className="dsh-ledger-collapsed-summary"><i>…</i>{row.collapsedSummary}</span> : <span className={row.kind === 'tool' && row.result !== undefined ? 'dsh-ledger-tool-result' : 'dsh-ledger-text'}><span>{row.text}</span>{row.kind === 'tool' && row.result !== undefined && <span className={row.error ? 'error' : ''}><i>→</i>{row.result || 'No output'}</span>}</span>}</td></tr>
}

function LedgerTable({ rows, selected, scrollTarget, onSelect, onToggleTurn, onToggleAssistant }: { rows: LedgerRow[]; selected: number | null; scrollTarget: number | null; onSelect: (index: number) => void; onToggleTurn: (turn: number) => void; onToggleAssistant: (index: number) => void }) {
  const paneRef = useRef<HTMLDivElement>(null)
  const projected = useMemo(() => projectLedgerVirtualRows(rows), [rows])
  const structure = useStableVirtualRowStructure(projected)
  const virtualizationEnabled = rows.length > 100
  const getScrollElement = useCallback(() => paneRef.current, [])
  const estimateSize = useCallback((index: number) => structure[index]?.height ?? 30, [structure])
  const getItemKey = useCallback((index: number) => structure[index]?.key ?? index, [structure])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtualizationEnabled ? projected.length : 0,
    enabled: virtualizationEnabled,
    getScrollElement,
    estimateSize,
    getItemKey,
    overscan: 12,
  })
  const virtualItems = virtualizationEnabled ? virtualizer.getVirtualItems() : []
  const rendered = virtualizationEnabled ? virtualItems.map(item => projected[item.index]).filter((row): row is LedgerVirtualRow => row !== undefined) : projected
  const virtualTop = virtualizationEnabled ? virtualItems[0]?.start ?? 0 : 0
  const virtualBottom = virtualizationEnabled && virtualItems.length > 0 ? Math.max(0, virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0)) : 0
  const firstVisible = virtualizationEnabled ? projected[virtualItems.find(item => item.end >= (virtualizer.scrollOffset ?? 0))?.index ?? 0] : undefined

  useEffect(() => {
    if (scrollTarget === null) return
    const position = projected.findIndex(item => item.type === 'record' && item.row.index === scrollTarget && item.row.collapsedSummary === undefined)
    if (position === -1) return
    if (virtualizationEnabled) virtualizer.scrollToIndex(position, { align: 'center', behavior: 'smooth' })
    else paneRef.current?.querySelector<HTMLElement>(`tr[data-record-index="${scrollTarget}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [projected, scrollTarget, virtualizationEnabled, virtualizer])

  const renderRow = (item: LedgerVirtualRow) => {
    if (item.type === 'record') return <LedgerRecord key={item.key} row={item.row} selected={selected} onSelect={onSelect} onToggleTurn={onToggleTurn} onToggleAssistant={onToggleAssistant} />
    if (item.type === 'step') return <tr key={item.key} className="dsh-ledger-step-header"><th colSpan={2}>{item.group.step > 0 ? `Step ${item.group.step}` : 'Messages'}<span>{item.group.rows.length} records</span></th></tr>
    const records = item.turn.groups.flatMap(group => group.rows)
    const start = Math.min(...records.map(row => row.startedAt))
    const end = Math.max(...records.map(row => row.completedAt))
    return <tr key={item.key} className="dsh-ledger-turn-header"><th colSpan={2}><button type="button" onClick={() => { if (item.turn.turn > 0) onToggleTurn(item.turn.turn) }} disabled={item.turn.turn === 0}><strong>{item.turn.turn > 0 ? `Turn ${item.turn.turn}` : 'Session'}</strong><span>{records.length} records · {formatDuration(Math.max(0, end - start))}</span></button></th></tr>
  }

  return <div className="dsh-ledger-pane-shell">{virtualizationEnabled && firstVisible !== undefined && <div className="dsh-ledger-virtual-context"><strong>{firstVisible.turn.turn > 0 ? `Turn ${firstVisible.turn.turn}` : 'Session'}</strong><span>{firstVisible.type === 'turn' ? 'Messages' : firstVisible.group.step > 0 ? `Step ${firstVisible.group.step}` : 'Messages'}</span></div>}<div ref={paneRef} className="dsh-ledger-pane"><table className="dsh-ledger-table" aria-rowcount={rows.length}><colgroup><col className="dsh-ledger-event-col" /><col /></colgroup><tbody>{virtualTop > 0 && <tr className="dsh-ledger-virtual-spacer" aria-hidden="true"><td colSpan={2} style={{ height: virtualTop }} /></tr>}{rendered.map(renderRow)}{virtualBottom > 0 && <tr className="dsh-ledger-virtual-spacer" aria-hidden="true"><td colSpan={2} style={{ height: virtualBottom }} /></tr>}</tbody></table></div></div>
}

function hierarchyRows(rows: readonly LedgerRow[], row: LedgerRow): { label: string; row: LedgerRow }[] {
  const related: { label: string; row: LedgerRow }[] = []
  const add = (label: string, candidate: LedgerRow | undefined) => {
    if (candidate !== undefined && candidate.index !== row.index && !related.some(item => item.row.index === candidate.index)) related.push({ label, row: candidate })
  }
  if (row.requestNumber !== undefined && row.kind !== 'request') add('Request', rows.find(candidate => candidate.kind === 'request' && candidate.requestNumber === row.requestNumber))
  if (row.kind === 'tool') {
    add('Assistant', rows.find(candidate => candidate.kind === 'message' && candidate.turn === row.turn && candidate.callIds?.includes(row.parentCallId ?? row.callId ?? '') === true))
    if (row.parentCallId !== undefined) add('Parent tool', rows.find(candidate => candidate.kind === 'tool' && candidate.callId === row.parentCallId))
  }
  if (row.kind === 'message') {
    for (const callId of row.callIds ?? []) add('Tool call', rows.find(candidate => candidate.kind === 'tool' && candidate.callId === callId))
  }
  if (row.kind === 'tool' && row.callId !== undefined) {
    for (const child of rows.filter(candidate => candidate.parentCallId === row.callId)) add('Subtool', child)
  }
  return related
}

function Details({ row, rows, tab, onTab, onClose, onNavigate }: { row: LedgerRow; rows: LedgerRow[]; tab: DetailTab; onTab: (tab: DetailTab) => void; onClose: () => void; onNavigate: (index: number) => void }) {
  const [width, setWidth] = useState<number | null>(null)
  const resize = useRef<{ pointerId: number; startX: number; startWidth: number; splitWidth: number } | null>(null)
  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    ...row.content !== undefined || row.reasoning !== undefined || row.result !== undefined ? [{ id: 'preview' as const, label: 'Preview' }] : [],
    ...row.source !== undefined ? [{ id: 'source' as const, label: 'Source' }] : [],
    ...row.request !== undefined ? [{ id: 'input' as const, label: 'Input' }] : [],
    ...row.result !== undefined ? [{ id: 'output' as const, label: 'Output' }] : [],
    ...row.schema !== undefined ? [{ id: 'schema' as const, label: 'Schema' }] : [],
    ...row.options !== undefined ? [{ id: 'options' as const, label: 'Options' }] : [],
    ...row.tools !== undefined ? [{ id: 'tools' as const, label: 'Tools' }] : [],
    ...row.usage !== undefined ? [{ id: 'usage' as const, label: 'Usage' }] : [],
    ...row.kind === 'message' || row.completedAt !== row.startedAt ? [{ id: 'timing' as const, label: 'Timing' }] : [],
    ...row.previousContent !== undefined || row.previousTools !== undefined ? [{ id: 'diff' as const, label: 'Diff' }] : [],
    ...row.attempts !== undefined && row.attempts.length > 0 ? [{ id: 'attempts' as const, label: 'Attempts' }] : [],
    { id: 'raw', label: 'Raw' },
  ]
  const total = row.completedAt - row.startedAt
  const ttft = row.firstTokenAt === undefined ? undefined : row.firstTokenAt - row.startedAt
  const generation = row.firstTokenAt === undefined ? undefined : row.completedAt - row.firstTokenAt
  const throughput = generation !== undefined && generation > 0 && row.usage?.outputTokens !== undefined ? row.usage.outputTokens / (generation / 1000) : undefined
  const status = row.status === 'error' ? 'Failed' : row.status === 'running' ? 'Running' : row.status === 'interrupted' ? 'Interrupted' : 'Completed'
  const promptDiff = row.previousContent === undefined || row.content === undefined ? undefined
    : createTwoFilesPatch('previous', 'current', row.previousContent, row.content, '', '', { context: 3 })
  const hierarchy = hierarchyRows(rows, row)
  const body = tab === 'raw' ? <JsonBlock value={row.event} />
    : tab === 'source' ? <JsonBlock value={row.source} />
      : tab === 'input' ? <div className="dsh-details-preview"><pre>{row.request}</pre></div>
        : tab === 'output' ? <div className="dsh-details-preview"><pre className={row.error ? 'error' : ''}>{row.result || 'No output'}</pre></div>
          : tab === 'schema' ? <JsonBlock value={row.schema} />
            : tab === 'options' ? <JsonBlock value={row.options} />
      : tab === 'tools' ? <JsonBlock value={row.tools} />
        : tab === 'usage' ? <div className="dsh-details-summary"><h4>This request</h4><JsonBlock value={row.usage} />{row.cumulativeUsage !== undefined && <><h4>Session cumulative</h4><JsonBlock value={row.cumulativeUsage} /></>}</div>
          : tab === 'timing' ? <div className="dsh-details-summary"><dl>
            <div><dt>Started</dt><dd>{new Date(row.startedAt).toLocaleString()}</dd></div>
            <div><dt>Completed</dt><dd>{new Date(row.completedAt).toLocaleString()}</dd></div>
            <div><dt>Duration</dt><dd>{formatDuration(total)}</dd></div>
            {ttft !== undefined && <div><dt>TTFT</dt><dd>{formatDuration(ttft)}</dd></div>}
            {generation !== undefined && <div><dt>Generation</dt><dd>{formatDuration(generation)}</dd></div>}
            {throughput !== undefined && <div><dt>Throughput</dt><dd>{throughput.toFixed(1)} tok/s</dd></div>}
          </dl></div>
            : tab === 'diff' ? <div className="dsh-details-preview">{promptDiff !== undefined && <pre className="dsh-prompt-diff">{promptDiff}</pre>}{row.previousTools !== undefined && <><h4>Previous tools</h4><JsonBlock value={row.previousTools} /><h4>Current tools</h4><JsonBlock value={row.tools} /></>}</div>
              : tab === 'attempts' ? <div className="dsh-details-attempts">{row.attempts?.map(attempt => <section key={attempt.seq}><header><strong>Attempt at seq {attempt.seq}</strong><time>{new Date(attempt.time).toLocaleTimeString()}</time></header>{attempt.error && <p className="error">{attempt.error}{attempt.errorCode ? ` (${attempt.errorCode})` : ''}</p>}{attempt.reasoning && <details><summary>Thinking</summary><pre>{attempt.reasoning}</pre></details>}{attempt.content && <pre>{attempt.content}</pre>}</section>)}</div>
                : tab === 'preview' ? <div className="dsh-details-preview">{row.reasoning && <details><summary>Thinking</summary><p>{row.reasoning}</p></details>}{row.content && <p>{row.content}</p>}{row.request && (row.kind === 'tool' || row.kind === 'command') && <pre>{row.request}</pre>}{row.result !== undefined && <pre className={row.error ? 'error' : ''}>{row.result || 'No output'}</pre>}</div>
                  : <div className="dsh-details-summary"><dl><div><dt>Status</dt><dd>{status}</dd></div><div><dt>Duration</dt><dd>{formatDuration(total)}</dd></div>{row.requestNumber !== undefined && <div><dt>Request</dt><dd>#{row.requestNumber}</dd></div>}{row.requestReason && <div><dt>Reason</dt><dd>{row.requestReason}</dd></div>}{row.provider && <div><dt>Provider</dt><dd>{row.provider}</dd></div>}{row.model && <div><dt>Model</dt><dd>{row.model}</dd></div>}{rec(row.requestContext)?.contextWindow !== undefined && <div><dt>Context</dt><dd>{String(rec(row.requestContext)?.contextWindow)} tokens</dd></div>}{row.callId && <div><dt>Call</dt><dd>{row.callId}</dd></div>}{row.parentCallId && <div><dt>Parent call</dt><dd>{row.parentCallId}</dd></div>}{row.replacementSeq !== undefined && <div><dt>Checkpoint</dt><dd>seq {row.replacementSeq}</dd></div>}{row.shadowedItemCount !== undefined && <div><dt>Compacted</dt><dd>{row.shadowedItemCount} items</dd></div>}{row.shadowedTokenCount !== undefined && <div><dt>Shadowed</dt><dd>{row.shadowedTokenCount} tokens</dd></div>}</dl>{hierarchy.length > 0 && <nav className="dsh-details-hierarchy" aria-label="Related records">{hierarchy.map(item => <button type="button" key={`${item.label}:${item.row.index}`} onClick={() => onNavigate(item.row.index)}><span>{item.label}</span><strong>{LABELS[item.row.kind]} #{item.row.index}</strong><ChevronRight size={13} /></button>)}</nav>}{row.kind === 'message' && row.usage !== undefined && <dl><div><dt>Tokens</dt><dd>{row.usage.totalTokens ?? (row.usage.inputTokens ?? 0) + (row.usage.outputTokens ?? 0)} tok</dd></div><div className="indent"><dt>Reasoning</dt><dd>{row.usage.reasoningTokens ?? 0} tok</dd></div><div className="indent"><dt>Content</dt><dd>{row.usage.outputTokens ?? 0} tok</dd></div></dl>}{row.kind === 'tool' && <dl><div><dt>Input</dt><dd>{row.request?.length ?? 0} chars</dd></div><div><dt>Output</dt><dd>{row.result?.length ?? 0} chars</dd></div></dl>}<div className="dsh-summary-copy">{row.content || row.result || row.text}</div></div>
  const clampWidth = (next: number, splitWidth: number) => Math.min(Math.max(280, splitWidth - 280), Math.max(280, next))
  return <aside className="dsh-ledger-details" style={width === null ? undefined : { width }}><div className="dsh-details-resize" role="separator" tabIndex={0} aria-label="Resize event details" aria-orientation="vertical" title="Drag to resize. Double-click to reset." onDoubleClick={() => setWidth(null)} onPointerDown={event => {
    if (event.button !== 0) return
    const details = event.currentTarget.parentElement
    const split = details?.parentElement
    if (details === null || details === undefined || split === null || split === undefined) return
    resize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: details.getBoundingClientRect().width, splitWidth: split.getBoundingClientRect().width }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }} onPointerMove={event => {
    const drag = resize.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    setWidth(clampWidth(drag.startWidth + drag.startX - event.clientX, drag.splitWidth))
  }} onPointerUp={event => {
    if (resize.current?.pointerId !== event.pointerId) return
    resize.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }} onPointerCancel={() => { resize.current = null }} onKeyDown={event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const details = event.currentTarget.parentElement
    const split = details?.parentElement
    if (details === null || details === undefined || split === null || split === undefined) return
    setWidth(clampWidth(details.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 16 : -16), split.getBoundingClientRect().width))
    event.preventDefault()
  }} /><div className="dsh-details-header"><div><span className={`dsh-ledger-kind dsh-ledger-${row.kind}`}>{LABELS[row.kind]}</span><span>{row.turn > 0 ? `Turn ${row.turn} · Step ${row.step}` : row.text}</span></div><button type="button" onClick={onClose} aria-label="Close details"><X size={14} /></button></div><div className="dsh-details-tabs" role="tablist">{tabs.map(item => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => onTab(item.id)}>{item.label}</button>)}</div><div className="dsh-details-body">{body}</div></aside>
}

export function TimelineView({ events, query, onQueryChange }: { events: DshEvent[]; query: string; onQueryChange?: (value: string) => void }) {
  const rows = useMemo(() => deriveRows(events), [events])
  const [selected, setSelected] = useState<number | null>(null)
  const [scrollTarget, setScrollTarget] = useState<number | null>(null)
  const [tab, setTab] = useState<DetailTab>('summary')
  const [duration, setDuration] = useState(false)
  const [viewport, setViewport] = useState<FractionRange>({ start: 0, end: 1 })
  const [range, setRange] = useState<FractionRange | null>(null)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<number>>(new Set())
  const normalized = query.trim().toLowerCase()
  const searchMatches = useMemo(() => normalized === '' ? null : new Set(rows.filter(row => JSON.stringify(row).toLowerCase().includes(normalized)).map(row => row.index)), [normalized, rows])
  const rangeMatches = useMemo(() => range === null ? null : new Set(timelineFractions(rows, duration).filter(item => item.end >= range.start && item.start <= range.end).map(item => item.span.row.index)), [duration, range, rows])
  const filtered = rows.filter(row => (searchMatches === null || searchMatches.has(row.index)) && (rangeMatches === null || rangeMatches.has(row.index)))
  const collapsibleTurnIds = useMemo(() => [...new Set(rows.filter(row => row.turn > 0).map(row => row.turn).filter(turn => rows.filter(row => row.turn === turn).length > 1))], [rows])
  const collapsibleAssistantIds = useMemo(() => rows.flatMap((row, index) => row.kind === 'message' && rows[index + 1]?.kind === 'tool' ? [row.index] : []), [rows])
  const allTurnsCollapsed = collapsibleTurnIds.length > 0 && collapsibleTurnIds.every(turn => collapsedTurns.has(turn))
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0 && collapsibleAssistantIds.every(index => collapsedAssistants.has(index))
  const visible = collapseAssistantRows(collapseTurnRows(filtered, collapsedTurns), collapsedAssistants)
  const toggleAllTurns = () => setCollapsedTurns(current => new Set(allTurnsCollapsed ? [] : collapsibleTurnIds))
  const toggleAllAssistants = () => setCollapsedAssistants(current => new Set(allAssistantsCollapsed ? [] : collapsibleAssistantIds))
  const selectedRow = rows.find(row => row.index === selected)
  const select = (index: number, focus = false) => { setSelected(index); setTab('summary'); setScrollTarget(focus ? index : null) }
  const navigate = (index: number) => {
    const target = rows.find(row => row.index === index)
    if (target?.turn !== undefined) setCollapsedTurns(current => { const next = new Set(current); next.delete(target.turn); return next })
    if (target?.kind === 'tool') {
      const parent = rows.find(row => row.kind === 'message' && row.turn === target.turn && row.callIds?.includes(target.parentCallId ?? target.callId ?? '') === true)
      if (parent !== undefined) setCollapsedAssistants(current => { const next = new Set(current); next.delete(parent.index); return next })
    }
    select(index, true)
  }
  const changeZoom = (factor: number) => setViewport(current => {
    const width = Math.min(1, Math.max(.05, (current.end - current.start) * factor))
    const center = (current.start + current.end) / 2
    const start = Math.min(1 - width, Math.max(0, center - width / 2))
    return { start, end: start + width }
  })
  const pan = (direction: -1 | 1) => setViewport(current => {
    const width = current.end - current.start
    const start = Math.min(1 - width, Math.max(0, current.start + direction * width * .25))
    return { start, end: start + width }
  })
  const toggleDuration = () => { setDuration(value => !value); setRange(null); setViewport({ start: 0, end: 1 }) }
  return <div className="dsh-trajectory-root"><div className="dsh-trajectory-toolbar"><div className="dsh-trajectory-actions"><button type="button" aria-pressed={duration} onClick={toggleDuration}><Clock3 size={12} />Duration</button><button type="button" aria-pressed={allTurnsCollapsed} aria-label={allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'} title={allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'} onClick={toggleAllTurns}><span className="dsh-toolbar-glyph">{allTurnsCollapsed ? '⊞' : '⊟'}</span>Turns</button><button type="button" aria-pressed={allAssistantsCollapsed} aria-label={allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'} title={allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'} onClick={toggleAllAssistants}><span className="dsh-toolbar-glyph">{allAssistantsCollapsed ? '⊞' : '⊟'}</span>Calls</button><span className="dsh-toolbar-divider" /><button type="button" aria-label="Pan timeline left" title="Pan left" onClick={() => pan(-1)}><ChevronLeft size={13} /></button><button type="button" aria-label="Pan timeline right" title="Pan right" onClick={() => pan(1)}><ChevronRight size={13} /></button><button type="button" aria-label="Zoom timeline in" title="Zoom in" onClick={() => changeZoom(.7)}><ZoomIn size={13} /></button><button type="button" aria-label="Zoom timeline out" title="Zoom out" onClick={() => changeZoom(1.4)}><ZoomOut size={13} /></button><button type="button" aria-label="Reset timeline viewport" title="Reset view" onClick={() => { setViewport({ start: 0, end: 1 }); setRange(null) }}><Maximize2 size={13} /></button>{range !== null && <button type="button" aria-label="Clear timeline range" title="Clear selection" onClick={() => setRange(null)}><X size={13} /></button>}</div><label className="dsh-trajectory-search"><Search size={11} /><input type="search" value={query} onChange={event => onQueryChange?.(event.target.value)} placeholder="Search" /></label></div><TimelineOverview rows={rows} duration={duration} selected={selected} searchMatches={searchMatches} viewport={viewport} range={range} onViewport={setViewport} onRange={setRange} onSelect={index => select(index, true)} onFocus={index => select(index, true)} /><div className="dsh-ledger-split"><LedgerTable rows={visible} selected={selected} scrollTarget={scrollTarget} onSelect={index => select(index)} onToggleTurn={turn => setCollapsedTurns(current => { const next = new Set(current); next.has(turn) ? next.delete(turn) : next.add(turn); return next })} onToggleAssistant={index => setCollapsedAssistants(current => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next })} />{selectedRow && <Details row={selectedRow} rows={rows} tab={tab} onTab={setTab} onClose={() => setSelected(null)} onNavigate={navigate} />}</div></div>
}
