/*
 * DSH source reference:
 * packages/client/ui-chat/src/client/chat/MessageItem.tsx
 * packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx
 * packages/client/ui-chat/src/client/chat/SystemPromptRow.tsx
 * packages/client/ui-chat/src/client/chat/CompactionItem.tsx
 * packages/client/ui-tool/src/client/tool/components/ToolRow.tsx
 *
 * MarkdownText is imported from the published primitives package. The chat
 * and tool renderers require the Cordis runtime, so only their JSONL event
 * projection and DOM structure are adapted locally below.
 */
import { AlertCircle, Archive, Clock3, Command, Copy, Database, FileText, Image, Info, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ConversationPromptSnapshot, SystemPromptNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  IconApiOutline14, IconBrowseOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCodeOutline16, IconEditOutline16, IconInspectOutline12, IconSearchOutline16, IconSparkle16,
  MarkdownText, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { asRecord, eventAssistantStream, type DshEvent } from '../lib/dsh'
import { formatDuration, formatMessageClock } from '../lib/format'
import { JsonBlock } from './JsonBlock'

type Block = Record<string, unknown>
interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
interface TurnStats {
  usage?: Usage
  runMs?: number
  ttftMs?: number
  tokensPerSecond?: number
}
export type ChatItem =
  | { kind: 'user'; key: string; seq: number; time: number; content: unknown[] }
  | { kind: 'assistant'; key: string; seq: number; time: number; turn: number; content: unknown[]; interrupted?: boolean; turnTail?: true; stats?: TurnStats }
  | { kind: 'tool'; key: string; seq: number; turn: number; name: string; callId: string; args: string; result?: unknown[]; error?: boolean; children: Extract<ChatItem, { kind: 'tool' }>[] }
  | { kind: 'context'; key: string; seq: number; content: unknown[]; label?: string; source?: Block }
  | { kind: 'system'; key: string; seq: number; text: string; update: boolean }
  | { kind: 'process'; key: string; seq: number; title: string; detail?: string; tone: 'info' | 'retry' | 'compaction' | 'warning' | 'error'; retryState?: 'scheduled' | 'started' | 'cancelled'; turn?: number; retry?: number; maxRetries?: number; delayMs?: number }
  | { kind: 'command'; key: string; seq: number; name: string; args?: string; outcome?: 'success' | 'error'; result?: string }
type ToolChatItem = Extract<ChatItem, { kind: 'tool' }>

function record(value: unknown): Block | undefined {
  return asRecord(value) as Block | undefined
}

function isAppendEvent(event: DshEvent): boolean {
  // The viewer deliberately keeps a forward-compatible event envelope, while
  // the session helper accepts the stricter known-event union.
  return isAppendSurfaceEvent(event as unknown as SessionEvent)
}

function blocks(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value]
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  return blocks(value).map(item => {
    const block = record(item)
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (block?.type === 'tool-result') return textOf(block.content)
    return ''
  }).join('')
}

function sourceLabel(value: unknown): string | undefined {
  const source = record(value)
  if (source === undefined) return undefined
  if (source.kind === 'plugin' && typeof source.plugin === 'string') return source.plugin
  if (source.kind === 'skill-invocation' && typeof source.name === 'string') return source.name
  if (source.kind === 'session-reference') return 'Session reference'
  return typeof source.kind === 'string' ? source.kind : undefined
}

function failureText(value: unknown, fallback = 'Model request failed'): string {
  const failure = record(value)
  if (typeof failure?.message === 'string') return failure.message
  return typeof value === 'string' && value !== '' ? value : fallback
}

function usageOf(value: unknown): Usage | undefined {
  const raw = record(value)
  if (raw === undefined) return undefined
  const usage: Usage = {}
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (typeof raw[key] === 'number') usage[key] = raw[key]
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (next === undefined) return total
  const result = { ...total }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (next[key] !== undefined) result[key] = (result[key] ?? 0) + next[key]
  }
  return result
}

/** Pure request inspection ported from ui-conversation. The published client
 * bundle touches window at module load, so this viewer reuses its public types
 * while keeping JSONL projection usable in Node tests. */
function inspectPromptSnapshot(previous: ConversationPromptSnapshot | undefined, event: DshEvent, system: SystemPromptNode | undefined) {
  const data = record(event.data)
  const header = record(data?.header)
  const prompt = {
    config: record(header?.config) ?? {},
    system: system?.text ?? '',
    tools: Array.isArray(header?.tools) ? header.tools : [],
  } as unknown as ConversationPromptSnapshot
  if (previous === undefined && data?.reason !== 'initial') return { prompt }
  const systemChanged = previous !== undefined && previous.system !== prompt.system && system?.update !== true
  const toolsChanged = previous !== undefined && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools)
  if (previous !== undefined && !systemChanged && !toolsChanged) return { prompt }
  return {
    prompt,
    change: {
      kind: previous === undefined ? 'initial' as const : systemChanged && toolsChanged ? 'system-and-tools' as const : systemChanged ? 'system' as const : 'tools' as const,
    },
  }
}

function attemptFailure(event: DshEvent): string | undefined {
  const finish = [...eventAssistantStream(event)].reverse()
    .map(member => record(member.chunk))
    .find(chunk => chunk?.type === 'finish')
  const reason = record(finish?.reason)
  if (reason?.kind === 'error') {
    const error = record(reason.error)
    return typeof error?.message === 'string' ? error.message : 'Model request failed'
  }
  return typeof reason?.kind === 'string' ? `Attempt ended: ${reason.kind}` : undefined
}

function toolResult(event: DshEvent): { callId: string; content: unknown[]; error: boolean } | undefined {
  const data = record(event.data)
  const message = record(data?.message)
  const source = record(message?.source)
  const envelope = record(blocks(message?.content)[0])
  if (typeof source?.callId !== 'string') return undefined
  return {
    callId: source.callId,
    content: envelope?.type === 'tool-result' ? blocks(envelope.content) : blocks(message?.content),
    error: envelope?.isError === true || data?.error !== undefined,
  }
}

interface PartialAssistant {
  seq: number
  time: number
  blocks: (unknown | undefined)[]
}

function stepKey(data: Block | undefined): string {
  return `${String(data?.turn ?? 0)}:${String(data?.step ?? 0)}`
}

function updatePartial(state: PartialAssistant, chunk: Block): void {
  const index = typeof chunk.index === 'number' ? chunk.index : state.blocks.length
  if (chunk.type === 'block-start') {
    state.blocks[index] = chunk.blockType === 'tool-call'
      ? { type: 'tool-call', id: '', name: '', arguments: '' }
      : { type: chunk.blockType, text: '' }
    return
  }
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
    const previous = record(state.blocks[index])
    state.blocks[index] = { type, text: `${previous?.type === type ? String(previous.text ?? '') : ''}${String(chunk.text ?? '')}` }
    return
  }
  if (chunk.type === 'tool-call-delta') {
    const previous = record(state.blocks[index])
    state.blocks[index] = {
      type: 'tool-call',
      id: String(previous?.id ?? chunk.id ?? ''),
      name: String(chunk.name ?? previous?.name ?? ''),
      arguments: `${String(previous?.arguments ?? '')}${String(chunk.argumentsDelta ?? '')}`,
    }
    return
  }
  if (chunk.type === 'block-end') state.blocks[index] = chunk.block
}

function toolItem(event: DshEvent): ToolChatItem {
  const data = record(event.data)
  const callId = typeof data?.callId === 'string' ? data.callId : `call-${event.seq}`
  return {
    kind: 'tool', key: `tool-${callId}`, seq: event.seq, turn: typeof data?.turn === 'number' ? data.turn : 0,
    name: typeof data?.name === 'string' ? data.name : '', callId,
    args: typeof data?.arguments === 'string' ? data.arguments : JSON.stringify(data?.arguments ?? {}),
    children: [],
  }
}

/** Browser-only projection of DSH's message, assistant-step, and tool-call definitions. */
export function projectChatItems(events: DshEvent[]): ChatItem[] {
  const calls = new Map<string, ToolChatItem>()
  const out: ChatItem[] = []
  const partials = new Map<string, PartialAssistant>()
  const compactions = new Map<string, Extract<ChatItem, { kind: 'process' }>>()
  const compactionCommands = new Map<string, Extract<ChatItem, { kind: 'command' }>>()
  const retries = new Map<string, Extract<ChatItem, { kind: 'process' }>>()
  const commands = new Map<string, Extract<ChatItem, { kind: 'command' }>>()
  const closingAssistants = new Map<number, Extract<ChatItem, { kind: 'assistant' }>>()
  const turnStarts = new Map<number, number>()
  const turnStartSeqs = new Map<number, number>()
  const stepStarts = new Map<string, number>()
  const turnUsage = new Map<number, Usage>()
  const turnFirstTokens = new Map<number, number>()
  let effectiveSystem = ''
  let effectiveSystemNode: SystemPromptNode | undefined
  let introducedSystemNode: SystemPromptNode | undefined
  let introducedSystemWasAppend = false
  let previousPrompt: ConversationPromptSnapshot | undefined
  const finalized = new Set(events
    .filter(event => (event.type as string) === 'assistant/message' && isAppendEvent(event))
    .map(event => stepKey(record(event.data))))

  for (const event of events) {
    const data = record(event.data)
    const eventType = event.type as string
    if (eventType === 'turn/start' && typeof data?.turn === 'number') {
      turnStarts.set(data.turn, event.time)
      turnStartSeqs.set(data.turn, event.seq)
    } else if (eventType === 'step/start') {
      stepStarts.set(stepKey(data), event.seq)
    } else if (eventType === 'system/message') {
      const message = record(data?.message)
      const text = textOf(message?.content)
      const update = effectiveSystem !== '' && text !== effectiveSystem && isAppendEvent(event)
      introducedSystemNode = {
        seq: event.seq,
        time: event.time,
        turn: typeof data?.turn === 'number' ? data.turn : 0,
        step: typeof data?.step === 'number' ? data.step : 0,
        text,
        update,
      }
      introducedSystemWasAppend = isAppendEvent(event)
      effectiveSystemNode = introducedSystemNode
      effectiveSystem = text
      if (text !== '' && isAppendEvent(event)) {
        const turn = introducedSystemNode.turn
        const key = `${turn}:${introducedSystemNode.step}`
        const anchor = update ? event.seq : introducedSystemNode.step === 1
          ? turnStartSeqs.get(turn) ?? stepStarts.get(key) ?? event.seq
          : stepStarts.get(key) ?? event.seq
        out.push({ kind: 'system', key: `system-${event.seq}`, seq: anchor, text, update })
      }
    } else if (eventType === 'request/header') {
      const header = record(data?.header)
      const legacySystem = typeof header?.system === 'string' ? header.system : undefined
      const system = effectiveSystemNode ?? (legacySystem === undefined ? undefined : {
        seq: event.seq,
        time: event.time,
        turn: typeof data?.turn === 'number' ? data.turn : 0,
        step: typeof data?.step === 'number' ? data.step : 0,
        text: legacySystem,
        update: effectiveSystem !== '' && legacySystem !== effectiveSystem,
      })
      const previous = previousPrompt
      const inspection = inspectPromptSnapshot(previous, event, system)
      previousPrompt = inspection.prompt
      const change = inspection.change?.kind
      const sameSystemAppend = introducedSystemNode !== undefined && introducedSystemWasAppend
        && introducedSystemNode.turn === data?.turn && introducedSystemNode.step === data?.step
        && (introducedSystemNode.update || previous === undefined)
      const showsPrompt = !sameSystemAppend && (previous === undefined
        || data?.reason !== 'change'
        || data?.startsSeries === true
        || change === 'system'
        || change === 'system-and-tools')
      const prompt = inspection.prompt.system || legacySystem || ''
      if (showsPrompt && prompt !== '') {
        const turn = typeof data?.turn === 'number' ? data.turn : 0
        const step = typeof data?.step === 'number' ? data.step : 0
        const key = `${turn}:${step}`
        const anchor = previous === undefined && data?.reason !== 'initial' ? event.seq : step === 1
          ? turnStartSeqs.get(turn) ?? stepStarts.get(key) ?? event.seq
          : stepStarts.get(key) ?? event.seq
        out.push({ kind: 'system', key: `request-prompt-${event.seq}`, seq: anchor, text: prompt, update: false })
        effectiveSystem = prompt
      }
    } else if (eventType === 'user/message' && isAppendEvent(event)) {
      const source = record(data?.source)
      out.push({
        kind: source?.kind === 'user' ? 'user' : 'context',
        key: `${source?.kind === 'user' ? 'user' : 'context'}-${event.seq}`,
        seq: event.seq,
        time: event.time,
        content: blocks(data?.content),
        ...(source?.kind === 'user' ? {} : { label: sourceLabel(source), source }),
      })
    } else if (eventType === 'assistant/message' && isAppendEvent(event)) {
      const message = record(data?.message)
      const turn = typeof data?.turn === 'number' ? data.turn : 0
      const item: Extract<ChatItem, { kind: 'assistant' }> = {
        kind: 'assistant', key: `assistant-${stepKey(data)}`, seq: event.seq,
        time: event.time, turn, content: blocks(message?.content), ...(data?.interrupted === true ? { interrupted: true } : {}),
      }
      out.push(item)
      if (textOf(item.content).trim() !== '') closingAssistants.set(turn, item)
      const usage = usageOf(data?.usage ?? message?.usage)
      const combined = addUsage(turnUsage.get(turn), usage)
      if (combined !== undefined) turnUsage.set(turn, combined)
      const firstToken = eventAssistantStream(event)[0]?.time
      if (typeof firstToken === 'number' && !turnFirstTokens.has(turn)) turnFirstTokens.set(turn, firstToken)
    } else if (eventType === 'assistant/attempt') {
      const detail = attemptFailure(event)
      if (!events.some(candidate => {
        if ((candidate.type as string) !== 'llm/retry') return false
        const retryData = record(candidate.data)
        return retryData?.turn === data?.turn && retryData?.step === data?.step && candidate.seq > event.seq
      })) out.push({ kind: 'process', key: `attempt-${event.seq}`, seq: event.seq, title: 'Model request failed', ...(detail === undefined ? {} : { detail }), tone: 'info', ...(typeof data?.turn === 'number' ? { turn: data.turn } : {}) })
    } else if (eventType === 'llm/retry') {
      const failure = record(data?.failure)
      const detail = typeof failure?.message === 'string' ? failure.message : undefined
      const retry = typeof data?.retry === 'number' ? data.retry : undefined
      const retryId = typeof data?.retryId === 'string' && data.retryId !== '' ? data.retryId : String(event.seq)
      const previous = retries.get(retryId)
      const item = previous ?? { kind: 'process' as const, key: `retry-${retryId}`, seq: event.seq, title: '', tone: 'retry' as const }
      if (typeof data?.turn === 'number') item.turn = data.turn
      item.retry = retry
      item.maxRetries = typeof data?.maxRetries === 'number' ? data.maxRetries : undefined
      item.delayMs = typeof data?.delayMs === 'number' ? data.delayMs : undefined
      item.title = retry === undefined ? 'Model retry scheduled' : `Model retry ${retry} scheduled`
      item.retryState = 'scheduled'
      item.detail = detail
      if (previous === undefined) {
        retries.set(retryId, item)
        out.push(item)
      }
    } else if (eventType === 'llm/retry-started') {
      const retryId = typeof data?.retryId === 'string' && data.retryId !== '' ? data.retryId : ''
      const item = retries.get(retryId)
      if (item !== undefined) {
        const retry = typeof data?.retry === 'number' ? data.retry : undefined
        item.title = retry === undefined ? 'Retrying model request' : `Model retry ${retry} started`
        item.retryState = 'started'
      }
    } else if (eventType === 'command/run') {
      const commandId = String(data?.commandId ?? event.seq)
      const item: Extract<ChatItem, { kind: 'command' }> = {
        kind: 'command', key: `command-${commandId}`, seq: event.seq,
        name: typeof data?.name === 'string' ? data.name : 'command',
        ...(typeof data?.args === 'string' ? { args: data.args } : {}),
      }
      commands.set(commandId, item)
      out.push(item)
    } else if (eventType === 'command/done') {
      const commandId = String(data?.commandId ?? event.seq)
      let item = commands.get(commandId)
      if (item === undefined) {
        item = { kind: 'command', key: `command-${commandId}`, seq: event.seq, name: 'command' }
        commands.set(commandId, item)
        out.push(item)
      }
      item.outcome = data?.kind === 'error' ? 'error' : 'success'
      item.result = typeof data?.text === 'string' ? data.text : undefined
    } else if (eventType === 'assistant/chunk') {
      const chunk = record(data?.chunk)
      const key = stepKey(data)
      if (chunk !== undefined && !finalized.has(key)) {
        const state = partials.get(key) ?? { seq: event.seq, time: event.time, blocks: [] }
        updatePartial(state, chunk)
        partials.set(key, state)
      }
    } else if (eventType === 'tool/call') {
      const item = toolItem(event)
      calls.set(item.callId, item)
      out.push(item)
    } else if (eventType === 'tool/result' && isAppendEvent(event)) {
      const result = toolResult(event)
      if (result !== undefined) {
        let item = calls.get(result.callId)
        if (item === undefined) {
          item = { kind: 'tool', key: `tool-${result.callId}`, seq: event.seq, turn: typeof data?.turn === 'number' ? data.turn : 0, name: '', callId: result.callId, args: '', children: [] }
          calls.set(result.callId, item)
          out.push(item)
        }
        item.result = result.content
        item.error = result.error
      }
    } else if (eventType === 'tool/code-dispatch-start' || eventType === 'tool/code-dispatch'
      || eventType === 'tool/ptc-dispatch-start' || eventType === 'tool/ptc-dispatch') {
      const parentCallId = typeof data?.parentCallId === 'string' ? data.parentCallId : ''
      const subCallId = typeof data?.subCallId === 'string' ? data.subCallId : ''
      const parent = calls.get(parentCallId)
      if (parent !== undefined && subCallId !== '') {
        let child = calls.get(subCallId)
        if (child === undefined) {
          child = {
            kind: 'tool', key: `tool-${subCallId}`, seq: event.seq, turn: parent.turn,
            name: typeof data?.name === 'string' ? data.name : '', callId: subCallId,
            args: JSON.stringify(data?.arguments ?? {}), children: [],
          }
          calls.set(subCallId, child)
          parent.children.push(child)
        }
        if (eventType === 'tool/code-dispatch' || eventType === 'tool/ptc-dispatch') {
          child.result = blocks(data?.content)
          child.error = data?.isError === true
        }
      }
    } else if (eventType === 'compaction/start') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : String(event.seq)
      const sourceCommandId = data?.sourceCommandId === undefined ? undefined : String(data.sourceCommandId)
      const command = sourceCommandId === undefined ? undefined : commands.get(sourceCommandId)
      if (command !== undefined) {
        compactionCommands.set(id, command)
        command.name = 'compact'
        continue
      }
      const item: Extract<ChatItem, { kind: 'process' }> = { kind: 'process', key: `compaction-${id}`, seq: event.seq, title: 'Compacting conversation', tone: 'compaction' }
      compactions.set(id, item)
      out.push(item)
    } else if (eventType === 'compaction/summary') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : ''
      const command = compactionCommands.get(id)
      if (command !== undefined) {
        const shadowed = Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs.length : undefined
        const tokens = typeof data?.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined
        command.result = [shadowed === undefined ? '' : `${shadowed} items`, tokens === undefined ? '' : `${tokens} tokens`].filter(Boolean).join(' · ') || 'Conversation history summarized'
      }
      const item = compactions.get(id)
      if (item !== undefined) item.detail = 'Conversation history summarized'
    } else if (eventType === 'compaction/end') {
      const id = typeof data?.compactionId === 'string' ? data.compactionId : ''
      const command = compactionCommands.get(id)
      if (command !== undefined) {
        command.outcome = data?.error === undefined ? 'success' : 'error'
        if (data?.error !== undefined) command.result = failureText(data.error, 'Conversation compaction failed')
      }
      const item = compactions.get(id)
      if (item !== undefined) {
        item.title = data?.error === undefined ? 'Conversation compacted' : 'Conversation compaction failed'
        item.detail = typeof data?.error === 'string' ? data.error : item.detail
      }
    } else if (eventType === 'turn/end') {
      const turn = typeof data?.turn === 'number' ? data.turn : undefined
      const closing = turn === undefined ? undefined : closingAssistants.get(turn)
      if (closing !== undefined && turn !== undefined) {
        closing.turnTail = true
        const startedAt = turnStarts.get(turn)
        const firstTokenAt = turnFirstTokens.get(turn)
        const runMs = startedAt === undefined ? undefined : Math.max(0, event.time - startedAt)
        const generationMs = firstTokenAt === undefined ? undefined : Math.max(0, event.time - firstTokenAt)
        const usage = turnUsage.get(turn)
        const outputTokens = usage?.outputTokens
        closing.stats = {
          ...(usage === undefined ? {} : { usage }),
          ...(runMs === undefined ? {} : { runMs }),
          ...(startedAt === undefined || firstTokenAt === undefined ? {} : { ttftMs: Math.max(0, firstTokenAt - startedAt) }),
          ...(generationMs === undefined || generationMs === 0 || outputTokens === undefined ? {} : { tokensPerSecond: outputTokens / (generationMs / 1000) }),
        }
      }
      const reason = record(data?.reason)
      if (reason?.kind === 'error') {
        const failure = record(reason.error)
        const code = typeof failure?.code === 'string' ? failure.code : undefined
        out.push({ kind: 'process', key: `turn-error-${event.seq}`, seq: event.seq, title: 'Turn failed', detail: `${failureText(reason.error)}${code === undefined ? '' : ` (${code})`}`, tone: 'error' })
      } else if (reason?.kind === 'max-tokens') {
        out.push({ kind: 'process', key: `turn-max-tokens-${event.seq}`, seq: event.seq, title: 'Maximum output tokens reached', detail: 'The response may be incomplete.', tone: 'warning' })
      }
      if (turn !== undefined) {
        for (const retry of retries.values()) {
          if (retry.turn === turn && retry.retryState === 'scheduled') {
            retry.retryState = 'cancelled'
            retry.title = retry.title.replace(' scheduled', ' cancelled')
          }
        }
      }
    }
  }

  for (const [key, state] of partials) {
    const content = state.blocks.filter((block): block is unknown => block !== undefined)
    if (content.some(raw => record(raw)?.type !== 'tool-call')) {
      const [turnText] = key.split(':')
      out.push({ kind: 'assistant', key: `assistant-${key}`, seq: state.seq, time: state.time, turn: Number(turnText), content })
    }
  }
  return out.sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))
}

export interface TurnProcessItem {
  kind: 'turn-process'
  key: string
  turn: number
  items: ChatItem[]
  messageCount: number
  toolCallCount: number
  subagentCount: number
}

export type ChatPresentationItem = ChatItem | TurnProcessItem

function itemTurn(item: ChatItem): number | undefined {
  if (item.kind === 'assistant' || item.kind === 'tool') return item.turn
  return item.kind === 'process' ? item.turn : undefined
}

/** Local equivalent of ui-chat's turn-process projection. Independent rows
 * stay in place while intermediate assistant/tool/retry rows fold together. */
export function projectTurnProcesses(items: readonly ChatItem[]): ChatPresentationItem[] {
  const candidatesByTurn = new Map<number, ChatItem[]>()
  for (const closing of items) {
    if (closing.kind !== 'assistant' || closing.turnTail !== true) continue
    const candidates = items.filter(item => {
      if (item.seq >= closing.seq || itemTurn(item) !== closing.turn) return false
      if (item.kind === 'assistant' || item.kind === 'tool') return true
      return item.kind === 'process' && (item.tone === 'info' || item.tone === 'retry')
    })
    if (candidates.length > 0) candidatesByTurn.set(closing.turn, candidates)
  }
  const folded = new Set([...candidatesByTurn.values()].flatMap(group => group.map(item => item.key)))
  const emitted = new Set<number>()
  const output: ChatPresentationItem[] = []
  for (const item of items) {
    const turn = itemTurn(item)
    const group = turn === undefined ? undefined : candidatesByTurn.get(turn)
    if (!folded.has(item.key) || group === undefined || turn === undefined) {
      output.push(item)
      continue
    }
    if (emitted.has(turn)) continue
    emitted.add(turn)
    const tools = group.filter((candidate): candidate is ToolChatItem => candidate.kind === 'tool')
    const subagentCount = tools.filter(tool => tool.name === 'subagent' || tool.name.startsWith('subagent_')).length
    output.push({
      kind: 'turn-process', key: `turn-process-${turn}`, turn, items: group,
      messageCount: group.filter(candidate => candidate.kind === 'assistant' && textOf(candidate.content).trim() !== '').length,
      toolCallCount: tools.length - subagentCount,
      subagentCount,
    })
  }
  return output
}

function Markdown({ text }: { text: string }) {
  return <div className="dsh-markdown"><MarkdownText text={text} labels={{ code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }} /></div>
}

function formatBytes(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function AttachmentBlock({ value }: { value: unknown }) {
  const block = record(value)
  const attachment = record(block?.attachment)
  if (block?.type !== 'image' && block?.type !== 'file') return null
  const image = block.type === 'image'
  const name = typeof attachment?.name === 'string' ? attachment.name : image ? 'Image attachment' : 'File attachment'
  const mediaType = typeof attachment?.mediaType === 'string' ? attachment.mediaType : typeof block.mimeType === 'string' ? block.mimeType : undefined
  const bytes = formatBytes(attachment?.bytes)
  const dimensions = typeof attachment?.width === 'number' && typeof attachment?.height === 'number' ? `${attachment.width} × ${attachment.height}` : undefined
  const inlineSource = image && typeof block.data === 'string' && mediaType?.startsWith('image/') === true
    ? `data:${mediaType};base64,${block.data}` : undefined
  return <figure className={`dsh-attachment ${image ? 'image' : 'file'}`}>
    {inlineSource !== undefined ? <img src={inlineSource} alt={name} /> : <span>{image ? <Image size={18} /> : <FileText size={18} />}</span>}
    <figcaption><strong>{name}</strong><small>{[mediaType, dimensions, bytes].filter(Boolean).join(' · ') || String(attachment?.attachmentId ?? 'Stored attachment')}</small></figcaption>
  </figure>
}

function Attachments({ content }: { content: unknown[] }) {
  const attachments = content.filter(raw => { const block = record(raw); return block?.type === 'image' || block?.type === 'file' })
  return attachments.length === 0 ? null : <div className="dsh-attachments">{attachments.map((raw, index) => <AttachmentBlock key={index} value={raw} />)}</div>
}

function AssistantBlocks({ content }: { content: unknown[] }) {
  return <div className="dsh-assistant-markdown">
    {content.map((raw, index) => {
      const block = record(raw)
      if (block?.type === 'text' && typeof block.text === 'string') return <Markdown key={index} text={block.text} />
      if (block?.type === 'reasoning' && typeof block.text === 'string') return <Reasoning key={index} text={block.text} />
      if (block?.type === 'tool-call') return null
      if (block?.type === 'image' || block?.type === 'file') return <AttachmentBlock key={index} value={raw} />
      return <JsonBlock key={index} value={raw} />
    })}
  </div>
}

function SystemPromptRow({ item }: { item: Extract<ChatItem, { kind: 'system' }> }) {
  const [open, setOpen] = useState(false)
  return <div className="dsh-system-prompt">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
      <Info size={14} /><span>{item.update ? 'System prompt updated' : 'System prompt'}</span>
      <IconChevronRightOutline14 className={open ? 'open' : ''} />
    </button>
    {open && <pre>{item.text}</pre>}
  </div>
}

function retrySeconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000))
}

function RetryProcessRow({ item }: { item: Extract<ChatItem, { kind: 'process' }> }) {
  const delayMs = item.delayMs ?? 0
  const deadline = useMemo(() => Date.now() + delayMs, [delayMs, item.seq])
  const [countdown, setCountdown] = useState(() => ({ deadline, seconds: retrySeconds(deadline - Date.now()) }))
  const active = item.retryState === 'scheduled' && delayMs > 0
  const seconds = countdown.deadline === deadline ? countdown.seconds : retrySeconds(deadline - Date.now())
  useEffect(() => {
    if (!active) return
    const update = () => {
      const next = retrySeconds(deadline - Date.now())
      setCountdown(current => current.deadline === deadline && current.seconds === next ? current : { deadline, seconds: next })
      return next
    }
    if (update() === 1) return
    const timer = window.setInterval(() => { if (update() === 1) window.clearInterval(timer) }, 250)
    return () => { window.clearInterval(timer) }
  }, [active, deadline])
  const ordinal = item.retry === undefined ? 'Retry' : `Retry ${item.retry}${item.maxRetries === undefined ? '' : `/${item.maxRetries}`}`
  const status = active ? `${ordinal} in ${seconds}s` : item.retryState === 'started' ? `${ordinal} started` : item.retryState === 'cancelled' ? `${ordinal} cancelled` : item.title
  const delay = delayMs > 0 ? `Delay ${Math.round(delayMs)} ms` : undefined
  return <div className="dsh-process-row retry" data-retry-state={item.retryState}><RotateCcw size={14} /><span role="status">{status}</span>{(item.detail || delay) && <><i /><small>{[delay, item.detail].filter(Boolean).join(' · ')}</small></>}</div>
}

function ProcessRow({ item }: { item: Extract<ChatItem, { kind: 'process' }> }) {
  if (item.tone === 'retry') return <RetryProcessRow item={item} />
  const Icon = item.tone === 'compaction' ? Archive : item.tone === 'error' || item.tone === 'warning' ? AlertCircle : Info
  return <div className={`dsh-process-row ${item.tone}`} data-retry-state={item.retryState}><Icon size={14} /><span>{item.title}</span>{item.detail && <><i /><small>{item.detail}</small></>}</div>
}

function CommandRow({ item }: { item: Extract<ChatItem, { kind: 'command' }> }) {
  const [open, setOpen] = useState(false)
  const expandable = item.args !== undefined || item.result !== undefined
  const label = `/${item.name}${item.args ?? ''}`
  return <div className={`dsh-command-card ${item.outcome ?? 'running'}`}>
    <button type="button" disabled={!expandable} onClick={() => setOpen(value => !value)} aria-expanded={expandable ? open : undefined}>
      <Command size={14} /><span>{label}</span><i />
      <small>{item.outcome === 'error' ? 'Failed' : item.outcome === 'success' ? 'Completed' : 'Running'}</small>
      {expandable && <IconChevronRightOutline14 className={open ? 'open' : ''} />}
    </button>
    {open && <div>{item.args !== undefined && <pre>{item.args}</pre>}{item.result !== undefined && <pre className={item.outcome === 'error' ? 'error' : ''}>{item.result || 'No output'}</pre>}</div>}
  </div>
}

function contextFormBody(form: string | undefined, source: Block | undefined, content: unknown[]): ReactNode | undefined {
  if (form === 'instructions' && Array.isArray(source?.changes)) {
    const changes = source.changes.map(record)
    if (changes.every(change => typeof change?.path === 'string' && ['set', 'replace', 'remove'].includes(String(change.action)))) {
      const baseline = source.baseline === true
      return <><ul className="dsh-context-files">{changes.map((change, index) => <li key={index} title={typeof change?.digest === 'string' ? change.digest : undefined}><code>{String(change?.path)}</code><span>{change?.action === 'remove' ? 'Removed' : baseline ? 'Loaded' : change?.action === 'set' ? 'Added' : 'Updated'}</span></li>)}</ul>{textOf(content) && <pre>{textOf(content)}</pre>}<Attachments content={content} /></>
    }
  }
  if (form === 'catalog' && Array.isArray(source?.entries)) {
    const entries = source.entries.map(record)
    if (entries.every(entry => typeof entry?.name === 'string' && typeof entry?.description === 'string')) {
      return <>{source.update === true && <p className="dsh-context-notice">This catalog replaces the previous catalog.</p>}<ul className="dsh-context-entries">{entries.slice(0, 200).map((entry, index) => <li key={index}><code>{String(entry?.name)}</code><span>{String(entry?.description)}</span></li>)}</ul>{entries.length > 200 && <p className="dsh-context-notice">{entries.length - 200} more entries</p>}<Attachments content={content} /></>
    }
  }
  if (form === 'snapshot' && Array.isArray(source?.sections)) {
    const sections = source.sections.map(record)
    if (sections.every(section => typeof section?.name === 'string' && typeof section?.text === 'string')) {
      return <><p className="dsh-context-notice">This runtime snapshot supersedes earlier snapshots.</p><dl className="dsh-context-sections">{sections.map((section, index) => <div key={index}><dt>{String(section?.name)}</dt><dd>{String(section?.text)}</dd></div>)}</dl></>
    }
  }
  if (form === 'notice' && typeof source?.summary === 'string') return <>{textOf(content) && <pre>{textOf(content)}</pre>}<Attachments content={content} /></>
  if (form === 'relay' && typeof source?.senderSessionId === 'string' && source.senderSessionId !== '') return <><p className="dsh-context-notice">From session <code>{source.senderSessionId}</code></p>{textOf(content) && <pre>{textOf(content)}</pre>}<Attachments content={content} /></>
  if (form === 'recall' && Array.isArray(source?.references)) {
    const references = source.references.map(record)
    if (references.every(reference => typeof reference?.label === 'string' && typeof reference?.retainedMessages === 'number' && typeof reference?.omittedMessages === 'number' && typeof reference?.truncated === 'boolean')) {
      return <><ul className="dsh-context-recalls">{references.map((reference, index) => <li key={index}><strong>{String(reference?.label)}</strong><span>{String(reference?.retainedMessages)} retained · {String(reference?.omittedMessages)} omitted{reference?.truncated === true ? ' · truncated' : ''}</span></li>)}</ul>{textOf(content) && <pre>{textOf(content)}</pre>}<Attachments content={content} /></>
    }
  }
  return undefined
}

function ContextRow({ item }: { item: Extract<ChatItem, { kind: 'context' }> }) {
  const text = textOf(item.content)
  const form = typeof item.source?.form === 'string' ? item.source.form : undefined
  const title = form === 'instructions' ? 'Instructions' : form === 'catalog' ? 'Skill catalog'
    : form === 'snapshot' ? 'Runtime context' : form === 'notice' ? 'Notice'
      : form === 'relay' ? 'Relayed context' : form === 'recall' ? 'Session recall' : 'Context'
  const fields = Object.entries(item.source ?? {}).filter(([key]) => key !== 'kind' && key !== 'form' && key !== 'sections')
  const sections = Array.isArray(item.source?.sections) ? item.source.sections : []
  const body = contextFormBody(form, item.source, item.content)
  const summary = form === 'notice' && typeof item.source?.summary === 'string' ? item.source.summary : item.label
  return <details className="dsh-context-row" data-context-form={form}>
    <summary><Info size={13} /><span>{title}</span>{summary && <><i /><small>{summary}</small></>}</summary>
    <div>
      {body ?? <>{sections.length > 0 && <dl>{sections.map((raw, index) => { const section = record(raw); return <div key={index}><dt>{String(section?.name ?? `Section ${index + 1}`)}</dt><dd>{String(section?.text ?? '')}</dd></div> })}</dl>}{text ? <pre>{text}</pre> : item.content.some(raw => { const block = record(raw); return block?.type === 'image' || block?.type === 'file' }) ? null : <JsonBlock value={item.content} />}<Attachments content={item.content} />{fields.length > 0 && <dl>{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl>}</>}
    </div>
  </details>
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const summary = text.split('\n')[0] ?? text
  return <div className="dsh-think" data-state="ok">
    <button type="button" className="dsh-think-row" onClick={() => setOpen(value => !value)}>
      <IconChevronRightOutline14 className={open ? 'open' : ''} /><span className="dsh-think-title">Think</span><i /><span className="dsh-think-summary">{summary}</span>
    </button>
    {open && <div className="dsh-think-body">{text}</div>}
  </div>
}

function compactTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value)
}

function UsageAction({ usage }: { usage: Usage }) {
  const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0)
  return <details className="dsh-turn-stat"><summary><Database size={13} />{compactTokens(total)} tokens</summary><dl>
    <div><dt>Total</dt><dd>{total}</dd></div>
    <div><dt>Input</dt><dd>{usage.inputTokens ?? 0}</dd></div>
    {usage.cacheReadTokens !== undefined && <div><dt>Cache read</dt><dd>{usage.cacheReadTokens}</dd></div>}
    {usage.cacheWriteTokens !== undefined && <div><dt>Cache write</dt><dd>{usage.cacheWriteTokens}</dd></div>}
    <div><dt>Output</dt><dd>{usage.outputTokens ?? 0}</dd></div>
    {usage.reasoningTokens !== undefined && <div><dt>Reasoning</dt><dd>{usage.reasoningTokens}</dd></div>}
  </dl></details>
}

function TimeAction({ stats }: { stats: TurnStats & { runMs: number } }) {
  return <details className="dsh-turn-stat"><summary><Clock3 size={13} />{formatDuration(stats.runMs)}</summary><dl>
    <div><dt>Duration</dt><dd>{formatDuration(stats.runMs)}</dd></div>
    {stats.ttftMs !== undefined && <div><dt>TTFT</dt><dd>{formatDuration(stats.ttftMs)}</dd></div>}
    {stats.tokensPerSecond !== undefined && <div><dt>Speed</dt><dd>{stats.tokensPerSecond.toFixed(1)} tok/s</dd></div>}
  </dl></details>
}

function MessageActions({ text, time, clock, stats }: { text: string; time: number; clock: 'start' | 'end'; stats?: TurnStats }) {
  const timeElement = <time dateTime={new Date(time).toISOString()}>{formatMessageClock(time)}</time>
  return <div className={`dsh-message-actions ${clock === 'end' ? 'assistant' : ''}`}>
    {clock === 'start' && timeElement}
    <button type="button" title="Copy" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(text) }}><Copy size={13} /></button>
    {stats?.usage !== undefined && <UsageAction usage={stats.usage} />}
    {stats?.runMs !== undefined && <TimeAction stats={{ ...stats, runMs: stats.runMs }} />}
    {clock === 'end' && timeElement}
  </div>
}

function UserBubble({ content, time }: { content: unknown[]; time: number }) {
  const text = textOf(content)
  return <div className="dsh-user-row"><div className="dsh-user-stack"><div className="dsh-user-bubble">{text || (content.some(raw => { const block = record(raw); return block?.type === 'image' || block?.type === 'file' }) ? null : content.map((item, index) => <JsonBlock key={index} value={item} />))}<Attachments content={content} /></div></div><MessageActions text={text} time={time} clock="start" /></div>
}

function parseExitStatus(text: string): { body: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}

function terminalCwd(workdir: unknown, cwd: string | undefined): string | undefined {
  if (typeof workdir !== 'string' || workdir === '') return cwd
  if (/^(?:[/\\]|[A-Za-z]:[/\\])/.test(workdir) || cwd === undefined || cwd === '') return workdir
  const segments: string[] = []
  for (const segment of `${cwd.replace(/[/\\]+$/, '')}/${workdir}`.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `/${segments.join('/')}`
}

function ToolRow({ item, cwd, onInspect }: { item: ToolChatItem; cwd?: string; onInspect?: (callId: string) => void }) {
  const [open, setOpen] = useState(false)
  const parsed = (() => { try { return JSON.parse(item.args) as Record<string, unknown> } catch { return undefined } })()
  const variant = item.name === 'bash' || item.name === 'pwsh' ? 'bash'
    : ['read', 'web_fetch', 'cordis_package_inspect', 'cordis_runtime_inspect'].includes(item.name) ? 'read'
      : ['web_search', 'grep', 'glob'].includes(item.name) ? 'search'
        : ['write', 'edit'].includes(item.name) ? item.name
          : item.name === 'run_code' ? 'code' : 'other'
  const preferred = variant === 'bash' ? ['description', 'command']
    : variant === 'read' ? ['path', 'file_path', 'url']
      : variant === 'search' ? ['query', 'pattern', 'url']
        : variant === 'write' || variant === 'edit' ? ['path', 'file_path'] : ['description']
  const picked = preferred.map(key => parsed?.[key]).find(value => typeof value === 'string' && value !== '')
    ?? Object.values(parsed ?? {}).find(value => typeof value === 'string' && value !== '')
  const base = picked ?? (item.args || item.callId)
  const firstLine = String(base).split('\n')[0] ?? String(base)
  const output = item.result?.map(textOf).join('\n') ?? ''
  const summary = item.error && output ? output.split('\n')[0] ?? output
    : variant === 'other' && item.name ? `${item.name} · ${firstLine}` : firstLine
  const title = variant === 'bash' ? item.name === 'pwsh' ? 'Pwsh' : 'Bash'
    : variant === 'read' ? 'Read' : variant === 'search' ? 'Search'
      : variant === 'write' ? 'Write' : variant === 'edit' ? 'Edit' : variant === 'code' ? 'Code' : 'Tool call'
  const Icon = variant === 'bash' ? IconApiOutline14 : variant === 'read' ? IconBrowseOutline16 : variant === 'search' ? IconSearchOutline16 : variant === 'write' || variant === 'edit' ? IconEditOutline16 : variant === 'code' ? IconCodeOutline16 : IconSparkle16
  const expandable = item.args !== '' || item.result !== undefined
  const prettyArgs = parsed === undefined ? item.args : JSON.stringify(parsed, null, 2)
  const terminal = variant === 'bash' && parsed !== undefined
    && typeof parsed.command === 'string' && parsed.run_in_background !== true && !item.error
    ? { command: parsed.command, cwd: terminalCwd(parsed.workdir, cwd), ...parseExitStatus(output) }
    : undefined
  const terminalFailed = terminal !== undefined && (terminal.signal !== undefined || (terminal.exitCode ?? 0) !== 0)
  const rowSummary = terminal !== undefined && typeof parsed?.description === 'string' && parsed.description !== ''
    ? parsed.description : summary
  const state = item.error || terminalFailed ? 'error' : item.result ? 'ok' : 'running'
  return <div className="dsh-tool-root" data-state={state}>
    <div className="dsh-tool-row" role={expandable ? 'button' : undefined} tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined} onClick={expandable ? () => setOpen(value => !value) : undefined} onKeyDown={expandable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(value => !value) } } : undefined}>
      <span className="dsh-tool-leading"><span className="dsh-tool-icon">{variant === 'bash' && state === 'error' ? <StateDot state="error" className="dsh-tool-state-dot" /> : <Icon size={14} />}</span>{expandable && <IconChevronDownOutline14 className={`dsh-tool-chevron ${open ? 'open' : ''}`} />}</span>
      <span className="dsh-tool-title">{title}</span>{rowSummary !== '' && <><i className="dsh-tool-sep" /><span className={`dsh-tool-summary ${state === 'error' ? 'error' : ''}`}>{rowSummary}</span></>}
    </div>
    {open && <div className="dsh-tool-body-wrap">{terminal !== undefined
      ? <TerminalBlock command={terminal.command} cwd={terminal.cwd} output={item.result === undefined ? undefined : terminal.body} exitCode={terminal.exitCode} signal={terminal.signal} running={item.result === undefined} maxLines={Infinity} className="dsh-bash-terminal" labels={{ running: 'Running', failed: 'Failed', done: 'Done', copy: 'Copy', copied: 'Copied', noOutput: 'No output', signal: value => `Signal ${value}`, exitCode: value => `Exit code ${value}`, collapseAria: 'Collapse output', collapse: 'Collapse', expandAria: hidden => `Expand output (${hidden} lines)`, expand: hidden => `Expand (${hidden} lines)` }} />
      : <div className="dsh-tool-body">{item.args !== '' && <div className="dsh-io-section"><span>IN</span><pre>{prettyArgs}</pre></div>}{item.result !== undefined && <>{item.args !== '' && <div className="dsh-io-divider" />}<div className="dsh-io-section"><span>OUT</span>{output !== '' && <pre>{output}</pre>}<Attachments content={item.result} />{output === '' && !item.result.some(raw => { const block = record(raw); return block?.type === 'image' || block?.type === 'file' }) && <pre>No output</pre>}</div></>}</div>}
      {onInspect !== undefined && <button type="button" className="dsh-tool-inspect" onClick={() => onInspect(item.callId)}><IconInspectOutline12 />Inspect</button>}
    </div>}
    {item.children.length > 0 && <div className="dsh-tool-subcalls">{item.children.map(child => <ToolRow key={child.callId} item={child} cwd={cwd} onInspect={onInspect} />)}</div>}
  </div>
}

function ChatItemContent({ item, cwd, onInspect }: { item: ChatItem; cwd?: string; onInspect?: (callId: string) => void }) {
  if (item.kind === 'user') return <UserBubble content={item.content} time={item.time} />
  if (item.kind === 'assistant') return <><AssistantBlocks content={item.content} />{item.interrupted && <div className="dsh-interrupted">Response interrupted</div>}{item.turnTail && <MessageActions text={textOf(item.content)} time={item.time} clock="end" stats={item.stats} />}</>
  if (item.kind === 'tool') return <ToolRow item={item} cwd={cwd} onInspect={onInspect} />
  if (item.kind === 'system') return <SystemPromptRow item={item} />
  if (item.kind === 'process') return <ProcessRow item={item} />
  if (item.kind === 'command') return <CommandRow item={item} />
  return <ContextRow item={item} />
}

function TurnProcessRow({ item, cwd, onInspect }: { item: TurnProcessItem; cwd?: string; onInspect?: (callId: string) => void }) {
  const [open, setOpen] = useState(false)
  const labels = [
    item.toolCallCount > 0 ? `${item.toolCallCount} tool ${item.toolCallCount === 1 ? 'call' : 'calls'}` : undefined,
    item.messageCount > 0 ? `${item.messageCount} ${item.messageCount === 1 ? 'message' : 'messages'}` : undefined,
    item.subagentCount > 0 ? `${item.subagentCount} ${item.subagentCount === 1 ? 'subagent' : 'subagents'}` : undefined,
  ].filter((value): value is string => value !== undefined)
  return <div className="dsh-turn-process" data-turn-process={item.turn} data-open={open || undefined}>
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}><span>{labels.join(' · ') || 'Thought for a while'}</span><IconChevronDownOutline14 /></button>
    {open && <div>{item.items.map(child => <div className="dsh-chat-flow-item" key={child.key}><ChatItemContent item={child} cwd={cwd} onInspect={onInspect} /></div>)}</div>}
  </div>
}

export function ConversationView({ events, query, cwd, onInspect }: { events: DshEvent[]; query: string; cwd?: string; onInspect?: (callId: string) => void }) {
  const items = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const projected = projectTurnProcesses(projectChatItems(events))
    return projected.filter(item => !normalized || JSON.stringify(item).toLowerCase().includes(normalized))
  }, [events, query])
  if (items.length === 0) return <div className="empty-state"><strong>No matching conversation entries</strong></div>
  return <div className="dsh-chat-root"><div className="dsh-chat-scroll"><div className="dsh-chat-column">{items.map(item => <div className="dsh-chat-flow-item" data-chat-anchor-key={item.key} key={item.key}>{item.kind === 'turn-process' ? <TurnProcessRow item={item} cwd={cwd} onInspect={onInspect} /> : <ChatItemContent item={item} cwd={cwd} onInspect={onInspect} />}</div>)}</div></div></div>
}
