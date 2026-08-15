/* Direct port of DSH TrajectoryToolbar, TrajectoryTimeline and the primary
 * TrajectoryTable split-pane presentation. The local code only projects
 * session.jsonl events into the records consumed by that presentation. */
import { Clock3, Search, X } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import { asRecord, type DshEvent } from '../lib/dsh'
import { formatDuration } from '../lib/format'
import { JsonBlock } from './JsonBlock'

type Kind = 'system' | 'user' | 'context' | 'message' | 'tool'
type DetailTab = 'summary' | 'preview' | 'raw'

interface Usage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
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

function assistantParts(value: unknown): { content: string; reasoning: string; tools: string[] } {
  const content: string[] = []
  const reasoning: string[] = []
  const tools: string[] = []
  for (const raw of array(value)) {
    const block = rec(raw)
    if (block?.type === 'text' && typeof block.text === 'string') content.push(block.text)
    else if (block?.type === 'reasoning' && typeof block.text === 'string') reasoning.push(block.text)
    else if (block?.type === 'tool-call') tools.push(`${String(block.name ?? 'tool')} ${String(block.arguments ?? '')}`)
  }
  return { content: content.join('\n\n'), reasoning: reasoning.join('\n\n'), tools }
}

function hasError(value: unknown): boolean {
  return array(value).some(item => { const block = rec(item); return block?.isError === true || hasError(block?.content) })
}

function requestSummary(name: string, args: string): string {
  return `${name} ${args}`.trim()
}

function deriveRows(events: DshEvent[]): LedgerRow[] {
  const rows: LedgerRow[] = []
  const calls = new Map<string, { event: DshEvent; name: string; args: string; turn: number; step: number }>()
  const settledCalls = new Set<string>()
  const stepStarts = new Map<string, number>()
  const firstTokens = new Map<string, number>()
  let currentTurn = 1
  let requestNumber = 0
  let index = 0

  for (const event of events) {
    const data = rec(event.data)
    if (event.type === 'turn/start' && typeof data?.turn === 'number') currentTurn = data.turn
    if (event.type === 'step/start') {
      const turn = typeof data?.turn === 'number' ? data.turn : currentTurn
      const step = typeof data?.step === 'number' ? data.step : 0
      stepStarts.set(`${turn}:${step}`, event.time)
      continue
    }
    const turn = typeof data?.turn === 'number' ? data.turn : currentTurn
    const step = typeof data?.step === 'number' ? data.step : 0

    if (event.type === 'assistant/chunk') {
      const key = `${turn}:${step}`
      if (!firstTokens.has(key)) firstTokens.set(key, event.time)
    } else if (event.type === 'request/header') {
      const header = rec(data?.header)
      const prompt = typeof header?.system === 'string' ? header.system : ''
      if (!rows.some(row => row.kind === 'system')) rows.push({ index: ++index, kind: 'system', text: 'Initial System Prompt', event, turn: 0, step: 0, startedAt: event.time, completedAt: event.time, content: prompt })
    } else if (event.type === 'user/message') {
      const source = rec(data?.source)
      const injected = (source !== undefined && source.kind !== 'user') || data?.provenance !== undefined || data?.synthetic === true
      rows.push({ index: ++index, kind: injected ? 'context' : 'user', text: contentText(data?.content, true), event, turn, step, startedAt: event.time, completedAt: event.time, content: contentText(data?.content) })
    } else if (event.type === 'assistant/message') {
      const message = rec(data?.message)
      const parts = assistantParts(message?.content)
      const usage = rec(data?.usage ?? message?.usage) as Usage | undefined
      requestNumber += 1
      rows.push({
        index: ++index,
        kind: 'message',
        text: parts.content || parts.reasoning || parts.tools[0] || 'Assistant response',
        event,
        turn,
        step,
        startedAt: stepStarts.get(`${turn}:${step}`) ?? event.time,
        completedAt: event.time,
        firstTokenAt: firstTokens.get(`${turn}:${step}`),
        content: parts.content,
        reasoning: parts.reasoning,
        request: `Request #${requestNumber}`,
        usage,
      })
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
      })
    }
  }

  for (const [callId, call] of calls) {
    if (settledCalls.has(callId)) continue
    rows.push({ index: ++index, kind: 'tool', text: requestSummary(call.name, call.args), event: call.event, turn: call.turn, step: call.step, startedAt: call.event.time, completedAt: call.event.time, request: call.args })
  }

  rows.sort((left, right) => {
    if (left.kind === 'system' && right.kind !== 'system') return -1
    if (right.kind === 'system' && left.kind !== 'system') return 1
    return left.startedAt - right.startedAt || left.index - right.index
  })
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

const LABELS: Record<Kind, string> = { system: 'SYSTEM', user: 'USER', context: 'CONTEXT', message: 'ASSISTANT', tool: 'TOOL' }

interface TimelineProjection { row: LedgerRow; start: number; end: number }

/** DSH's two timeline projections: sequence slots versus recorded durations
 * with idle gaps removed. */
function projectTimeline(rows: LedgerRow[], duration: boolean): TimelineProjection[] {
  const timed = rows.filter(row => row.kind !== 'system')
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

function TimelineOverview({ rows, duration, selected, onSelect }: { rows: LedgerRow[]; duration: boolean; selected: number | null; onSelect: (index: number) => void }) {
  const spans = projectTimeline(rows, duration)
  const start = spans.length === 0 ? 0 : Math.min(...spans.map(span => span.start))
  const end = spans.length === 0 ? 1 : Math.max(...spans.map(span => span.end), start + 1)
  const domain = Math.max(1, end - start)
  return <div className="dsh-timeline-overview"><div className="dsh-timeline-labels"><span>Input</span><span>Model</span><span>Tools</span></div><div className="dsh-timeline-track">{spans.map((span, index) => {
    const leftFraction = (span.start - start) / domain
    const widthFraction = Math.max(0, (span.end - span.start) / domain)
    const widthPercent = duration ? widthFraction * 100 : 100 / Math.max(1, spans.length)
    const style = {
      '--timeline-left': `${leftFraction * 100}%`,
      '--timeline-width': `${widthPercent}%`,
      '--timeline-gap': `min(${widthPercent * 0.08}%, 1px)`,
    } as CSSProperties
    return <button type="button" key={span.row.index} className={`dsh-timeline-span dsh-timeline-${span.row.kind} ${selected === span.row.index ? 'selected' : ''}`} style={style} onClick={() => onSelect(span.row.index)} aria-label={`${LABELS[span.row.kind]} ${span.row.index}`} data-timeline-position={index} />
  })}</div></div>
}

function LedgerTable({ rows, selected, onSelect, onToggleTurn, onToggleAssistant }: { rows: LedgerRow[]; selected: number | null; onSelect: (index: number) => void; onToggleTurn: (turn: number) => void; onToggleAssistant: (index: number) => void }) {
  let previousTurn = 0
  return <div className="dsh-ledger-pane"><table className="dsh-ledger-table"><colgroup><col className="dsh-ledger-event-col" /><col /></colgroup><tbody>{rows.map(row => {
    const summary = row.collapsedSummary !== undefined
    const turnStart = !summary && row.turn > 0 && row.turn !== previousTurn
    if (row.turn > 0) previousTurn = row.turn
    const toggle = () => {
      if (row.collapsedSummaryKind === 'turn') onToggleTurn(row.collapsedTarget ?? row.turn)
      else if (row.collapsedSummaryKind === 'assistant') onToggleAssistant(row.collapsedTarget ?? row.index)
      else onSelect(row.index)
    }
    return <tr key={`${row.index}:${row.collapsedSummaryKind ?? 'record'}`} tabIndex={0} data-kind={row.kind} data-selected={!summary && selected === row.index || undefined} data-collapsed-summary={row.collapsedSummaryKind} data-turn-start={turnStart || undefined} onClick={toggle}><td className="dsh-ledger-event">{turnStart && <span className={`dsh-ledger-turn-label ${selected === row.index ? 'active' : ''}`}>Turn {row.turn}</span>}{row.turn > 0 && <span className="dsh-ledger-turn-rail" />}{!summary && selected === row.index && <span className="dsh-ledger-selection-rail" />}<div>{!summary && <span className={`dsh-ledger-kind dsh-ledger-${row.kind}`}>{LABELS[row.kind]}</span>}</div></td><td className="dsh-ledger-content">{summary ? <span className="dsh-ledger-collapsed-summary"><i>…</i>{row.collapsedSummary}</span> : <span className={row.kind === 'tool' && row.result !== undefined ? 'dsh-ledger-tool-result' : 'dsh-ledger-text'}><span>{row.text}</span>{row.kind === 'tool' && row.result !== undefined && <span className={row.error ? 'error' : ''}><i>→</i>{row.result || 'No output'}</span>}</span>}</td></tr>
  })}</tbody></table></div>
}

function Details({ row, tab, onTab, onClose }: { row: LedgerRow; tab: DetailTab; onTab: (tab: DetailTab) => void; onClose: () => void }) {
  const tabs: { id: DetailTab; label: string }[] = [{ id: 'summary', label: 'Summary' }, { id: 'preview', label: 'Preview' }, { id: 'raw', label: 'Raw' }]
  const total = row.completedAt - row.startedAt
  const ttft = row.firstTokenAt === undefined ? undefined : row.firstTokenAt - row.startedAt
  const generation = row.firstTokenAt === undefined ? undefined : row.completedAt - row.firstTokenAt
  const throughput = generation !== undefined && generation > 0 && row.usage?.outputTokens !== undefined ? row.usage.outputTokens / (generation / 1000) : undefined
  return <aside className="dsh-ledger-details"><div className="dsh-details-header"><div><span className={`dsh-ledger-kind dsh-ledger-${row.kind}`}>{LABELS[row.kind]}</span><span>{row.turn > 0 ? `Turn ${row.turn} · Step ${row.step}` : row.text}</span></div><button type="button" onClick={onClose} aria-label="Close details"><X size={14} /></button></div><div className="dsh-details-tabs" role="tablist">{tabs.map(item => <button type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} key={item.id} onClick={() => onTab(item.id)}>{item.label}</button>)}</div><div className="dsh-details-body">{tab === 'raw' ? <JsonBlock value={row.event} /> : tab === 'preview' ? <div className="dsh-details-preview">{row.reasoning && <details><summary>Thinking</summary><p>{row.reasoning}</p></details>}{row.content && <p>{row.content}</p>}{row.request && row.kind === 'tool' && <pre>{row.request}</pre>}{row.result !== undefined && <pre className={row.error ? 'error' : ''}>{row.result || 'No output'}</pre>}</div> : <div className="dsh-details-summary">{row.kind === 'message' && <dl><div><dt>Source</dt><dd>{row.request ?? 'Request'}</dd></div><div><dt>Status</dt><dd>Completed</dd></div><div><dt>Tokens</dt><dd>{(row.usage?.outputTokens ?? 0) + (row.usage?.reasoningTokens ?? 0)} tok</dd></div><div className="indent"><dt>Reasoning</dt><dd>{row.usage?.reasoningTokens ?? 0} tok</dd></div><div className="indent"><dt>Content</dt><dd>{row.usage?.outputTokens ?? 0} tok</dd></div></dl>}{row.kind === 'tool' && <dl><div><dt>Status</dt><dd>{row.error ? 'Failed' : row.result === undefined ? 'Running' : 'Completed'}</dd></div><div><dt>Duration</dt><dd>{formatDuration(total)}</dd></div><div><dt>Input</dt><dd>{row.request?.length ?? 0} chars</dd></div><div><dt>Output</dt><dd>{row.result?.length ?? 0} chars</dd></div></dl>}{(row.kind === 'user' || row.kind === 'context' || row.kind === 'system') && <div className="dsh-summary-copy">{row.content || row.text}</div>}{row.kind === 'message' && <><h4>Preview</h4>{row.reasoning && <details><summary>Thinking</summary><p>{row.reasoning}</p></details>}{row.content && <p>{row.content}</p>}<h4>Request Timing</h4><dl><div><dt>Started</dt><dd>{new Date(row.startedAt).toLocaleString()}</dd></div><div><dt>Total duration</dt><dd>{formatDuration(total)}</dd></div>{ttft !== undefined && <div><dt>TTFT</dt><dd>{formatDuration(ttft)}</dd></div>}{generation !== undefined && <div><dt>Generation</dt><dd>{formatDuration(generation)}</dd></div>}{throughput !== undefined && <div><dt>Throughput</dt><dd>{throughput.toFixed(1)} tok/s</dd></div>}</dl></>}</div>}</div></aside>
}

export function TimelineView({ events, query, onQueryChange }: { events: DshEvent[]; query: string; onQueryChange?: (value: string) => void }) {
  const rows = useMemo(() => deriveRows(events), [events])
  const [selected, setSelected] = useState<number | null>(null)
  const [tab, setTab] = useState<DetailTab>('summary')
  const [duration, setDuration] = useState(false)
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<number>>(new Set())
  const normalized = query.trim().toLowerCase()
  const filtered = rows.filter(row => !normalized || JSON.stringify(row).toLowerCase().includes(normalized))
  const collapsibleTurnIds = useMemo(() => [...new Set(rows.filter(row => row.turn > 0).map(row => row.turn).filter(turn => rows.filter(row => row.turn === turn).length > 1))], [rows])
  const collapsibleAssistantIds = useMemo(() => rows.flatMap((row, index) => row.kind === 'message' && rows[index + 1]?.kind === 'tool' ? [row.index] : []), [rows])
  const allTurnsCollapsed = collapsibleTurnIds.length > 0 && collapsibleTurnIds.every(turn => collapsedTurns.has(turn))
  const allAssistantsCollapsed = collapsibleAssistantIds.length > 0 && collapsibleAssistantIds.every(index => collapsedAssistants.has(index))
  const visible = collapseAssistantRows(collapseTurnRows(filtered, collapsedTurns), collapsedAssistants)
  const toggleAllTurns = () => setCollapsedTurns(current => new Set(allTurnsCollapsed ? [] : collapsibleTurnIds))
  const toggleAllAssistants = () => setCollapsedAssistants(current => new Set(allAssistantsCollapsed ? [] : collapsibleAssistantIds))
  const selectedRow = rows.find(row => row.index === selected)
  const select = (index: number) => { setSelected(index); setTab('summary') }
  return <div className="dsh-trajectory-root"><div className="dsh-trajectory-toolbar"><div className="dsh-trajectory-actions"><button type="button" aria-pressed={duration} onClick={() => setDuration(value => !value)}><Clock3 size={12} />Duration</button><button type="button" aria-pressed={allTurnsCollapsed} aria-label={allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'} title={allTurnsCollapsed ? 'Expand turns' : 'Collapse turns'} onClick={toggleAllTurns}><span className="dsh-toolbar-glyph">{allTurnsCollapsed ? '⊞' : '⊟'}</span>Turns</button><button type="button" aria-pressed={allAssistantsCollapsed} aria-label={allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'} title={allAssistantsCollapsed ? 'Expand calls' : 'Collapse calls'} onClick={toggleAllAssistants}><span className="dsh-toolbar-glyph">{allAssistantsCollapsed ? '⊞' : '⊟'}</span>Calls</button></div><label className="dsh-trajectory-search"><Search size={11} /><input type="search" value={query} onChange={event => onQueryChange?.(event.target.value)} placeholder="Search" /></label></div><TimelineOverview rows={rows} duration={duration} selected={selected} onSelect={select} /><div className="dsh-ledger-split"><LedgerTable rows={visible} selected={selected} onSelect={select} onToggleTurn={turn => setCollapsedTurns(current => { const next = new Set(current); next.has(turn) ? next.delete(turn) : next.add(turn); return next })} onToggleAssistant={index => setCollapsedAssistants(current => { const next = new Set(current); next.has(index) ? next.delete(index) : next.add(index); return next })} />{selectedRow && <Details row={selectedRow} tab={tab} onTab={setTab} onClose={() => setSelected(null)} />}</div></div>
}
