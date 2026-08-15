/*
 * DSH source reference:
 * packages/client/ui-conversation/src/client/chat/MessageItem.tsx
 * packages/client/ui-conversation/src/client/chat/AssistantMarkdown.tsx
 * packages/client/ui-tool/src/client/tool/components/ToolRow.tsx
 *
 * MarkdownText is imported from the published primitives package. The chat
 * and tool renderers require the Cordis runtime, so only their JSONL event
 * projection and DOM structure are adapted locally below.
 */
import { Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  IconApiOutline14, IconBrowseOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconCodeOutline16, IconEditOutline16, IconInspectOutline12, IconSearchOutline16, IconSparkle16,
  MarkdownText, StateDot, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { asRecord, type DshEvent } from '../lib/dsh'
import { JsonBlock } from './JsonBlock'

type Block = Record<string, unknown>
export type ChatItem =
  | { kind: 'user'; key: string; seq: number; content: unknown[] }
  | { kind: 'assistant'; key: string; seq: number; content: unknown[] }
  | { kind: 'tool'; key: string; seq: number; name: string; callId: string; args: string; result?: unknown[]; error?: boolean; children: Extract<ChatItem, { kind: 'tool' }>[] }
  | { kind: 'context'; key: string; seq: number; content: unknown[] }
type ToolChatItem = Extract<ChatItem, { kind: 'tool' }>

function record(value: unknown): Block | undefined {
  return asRecord(value) as Block | undefined
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
    kind: 'tool', key: `tool-${callId}`, seq: event.seq,
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
  const finalized = new Set(events
    .filter(event => (event.type as string) === 'assistant/message' && isAppendSurfaceEvent(event))
    .map(event => stepKey(record(event.data))))

  for (const event of events) {
    const data = record(event.data)
    const eventType = event.type as string
    if (eventType === 'user/message' && isAppendSurfaceEvent(event)) {
      const source = record(data?.source)
      out.push({
        kind: source?.kind === 'user' ? 'user' : 'context',
        key: `${source?.kind === 'user' ? 'user' : 'context'}-${event.seq}`,
        seq: event.seq,
        content: blocks(data?.content),
      })
    } else if (eventType === 'assistant/message' && isAppendSurfaceEvent(event)) {
      const message = record(data?.message)
      out.push({ kind: 'assistant', key: `assistant-${stepKey(data)}`, seq: event.seq, content: blocks(message?.content) })
    } else if (eventType === 'assistant/chunk') {
      const chunk = record(data?.chunk)
      const key = stepKey(data)
      if (chunk !== undefined && !finalized.has(key)) {
        const state = partials.get(key) ?? { seq: event.seq, blocks: [] }
        updatePartial(state, chunk)
        partials.set(key, state)
      }
    } else if (eventType === 'tool/call') {
      const item = toolItem(event)
      calls.set(item.callId, item)
      out.push(item)
    } else if (eventType === 'tool/result' && isAppendSurfaceEvent(event)) {
      const result = toolResult(event)
      if (result !== undefined) {
        let item = calls.get(result.callId)
        if (item === undefined) {
          item = { kind: 'tool', key: `tool-${result.callId}`, seq: event.seq, name: '', callId: result.callId, args: '', children: [] }
          calls.set(result.callId, item)
          out.push(item)
        }
        item.result = result.content
        item.error = result.error
      }
    } else if (eventType === 'tool/code-dispatch-start' || eventType === 'tool/code-dispatch') {
      const parentCallId = typeof data?.parentCallId === 'string' ? data.parentCallId : ''
      const subCallId = typeof data?.subCallId === 'string' ? data.subCallId : ''
      const parent = calls.get(parentCallId)
      if (parent !== undefined && subCallId !== '') {
        let child = calls.get(subCallId)
        if (child === undefined) {
          child = {
            kind: 'tool', key: `tool-${subCallId}`, seq: event.seq,
            name: typeof data?.name === 'string' ? data.name : '', callId: subCallId,
            args: JSON.stringify(data?.arguments ?? {}), children: [],
          }
          calls.set(subCallId, child)
          parent.children.push(child)
        }
        if (eventType === 'tool/code-dispatch') {
          child.result = blocks(data?.content)
          child.error = data?.isError === true
        }
      }
    }
  }

  for (const [key, state] of partials) {
    const content = state.blocks.filter((block): block is unknown => block !== undefined)
    if (content.some(raw => record(raw)?.type !== 'tool-call')) {
      out.push({ kind: 'assistant', key: `assistant-${key}`, seq: state.seq, content })
    }
  }
  return out.sort((a, b) => a.seq - b.seq || a.key.localeCompare(b.key))
}

function Markdown({ text }: { text: string }) {
  return <div className="dsh-markdown"><MarkdownText text={text} codeLabels={{ copyLabel: 'Copy', copiedLabel: 'Copied' }} /></div>
}

function AssistantBlocks({ content }: { content: unknown[] }) {
  return <div className="dsh-assistant-markdown">
    {content.map((raw, index) => {
      const block = record(raw)
      if (block?.type === 'text' && typeof block.text === 'string') return <Markdown key={index} text={block.text} />
      if (block?.type === 'reasoning' && typeof block.text === 'string') return <Reasoning key={index} text={block.text} />
      if (block?.type === 'tool-call') return null
      return <JsonBlock key={index} value={raw} />
    })}
  </div>
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

function UserBubble({ content }: { content: unknown[] }) {
  const text = textOf(content)
  return <div className="dsh-user-row"><div className="dsh-user-stack"><div className="dsh-user-bubble">{text || content.map((item, index) => <JsonBlock key={index} value={item} />)}</div></div><div className="dsh-message-actions"><button type="button" title="Copy"><Copy size={13} /></button></div></div>
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
      ? <TerminalBlock command={terminal.command} cwd={terminal.cwd} output={item.result === undefined ? undefined : terminal.body} exitCode={terminal.exitCode} signal={terminal.signal} running={item.result === undefined} maxLines={Infinity} className="dsh-bash-terminal" labels={{ running: 'Running', failed: 'Failed', done: 'Done', copy: 'Copy', copied: 'Copied', noOutput: 'No output', signal: value => `Signal ${value}`, exitCode: value => `Exit code ${value}` }} />
      : <div className="dsh-tool-body">{item.args !== '' && <div className="dsh-io-section"><span>IN</span><pre>{prettyArgs}</pre></div>}{item.result !== undefined && <>{item.args !== '' && <div className="dsh-io-divider" />}<div className="dsh-io-section"><span>OUT</span><pre>{output}</pre></div></>}</div>}
      {onInspect !== undefined && <button type="button" className="dsh-tool-inspect" onClick={() => onInspect(item.callId)}><IconInspectOutline12 />Inspect</button>}
    </div>}
    {item.children.length > 0 && <div className="dsh-tool-subcalls">{item.children.map(child => <ToolRow key={child.callId} item={child} cwd={cwd} onInspect={onInspect} />)}</div>}
  </div>
}

export function ConversationView({ events, query, cwd, onInspect }: { events: DshEvent[]; query: string; cwd?: string; onInspect?: (callId: string) => void }) {
  const items = useMemo(() => { const normalized = query.trim().toLowerCase(); return projectChatItems(events).filter(item => !normalized || JSON.stringify(item).toLowerCase().includes(normalized)) }, [events, query])
  if (items.length === 0) return <div className="empty-state"><strong>No matching conversation entries</strong></div>
  return <div className="dsh-chat-root"><div className="dsh-chat-scroll"><div className="dsh-chat-column">{items.map(item => <div className="dsh-chat-flow-item" data-chat-anchor-key={item.key} key={item.key}>{item.kind === 'user' ? <UserBubble content={item.content} /> : item.kind === 'assistant' ? <AssistantBlocks content={item.content} /> : item.kind === 'tool' ? <ToolRow item={item} cwd={cwd} onInspect={onInspect} /> : <div className="dsh-context-row"><JsonBlock value={item.content} /></div>}</div>)}</div></div></div>
}
