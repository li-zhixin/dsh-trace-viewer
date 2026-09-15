import { describe, expect, it } from 'vitest'
import type { DshEvent } from '../lib/dsh'
import { deriveRows, groupLedgerRows, projectLedgerVirtualRows } from './TimelineView'

function event(type: string, seq: number, time: number, data: Record<string, unknown>, surfaceOp?: 'append'): DshEvent {
  return { type, seq, time, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) }
}

describe('deriveRows', () => {
  it('projects v3 stream timing and lifecycle records', () => {
    const rows = deriveRows([
      event('turn/start', 0, 100, { turn: 1 }),
      event('step/start', 1, 110, { turn: 1, step: 1 }),
      event('system/message', 2, 111, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'System' }] } }, 'append'),
      event('assistant/message', 3, 150, {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'Hello' }], source: { provider: 'deepseek', model: 'chat' } },
        usage: { inputTokens: 10, outputTokens: 2 },
        stream: [{ type: 'text-chunks', time0: 125, index: 0, dt: [], texts: ['Hello'] }],
      }, 'append'),
      event('compaction/start', 4, 160, { compactionId: 'c1', turn: 1 }),
      event('compaction/summary', 5, 170, { compactionId: 'c1', turn: 1, summary: [{ type: 'text', text: 'Short history' }] }),
      event('compaction/end', 6, 175, { compactionId: 'c1', turn: 1 }),
    ])

    expect(rows.map(row => row.kind)).toEqual(['system', 'message', 'compaction'])
    expect(rows[1]).toMatchObject({ firstTokenAt: 125, provider: 'deepseek', model: 'chat', status: 'complete' })
    expect(rows[2]).toMatchObject({ text: 'Conversation compacted', content: 'Short history', completedAt: 175 })
  })

  it('keeps request metadata and correlated lifecycle rows at their log position', () => {
    const rows = deriveRows([
      event('turn/start', 0, 100, { turn: 1 }),
      event('step/start', 1, 110, { turn: 1, step: 1 }),
      event('system/message', 2, 111, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'System' }] } }, 'append'),
      event('request/header', 3, 112, { header: { config: { provider: 'deepseek', model: 'chat', maxTokens: 100 }, tools: [{ name: 'read' }] }, reason: 'initial' }),
      event('llm/retry', 4, 120, { retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', retry: 1, failure: { message: 'Busy' } }),
      event('llm/retry-started', 5, 130, { retryId: 'r1', turn: 1, step: 1, retry: 1 }),
      event('command/run', 6, 140, { commandId: 'c1', name: 'help', args: ' topic' }),
      event('command/done', 7, 150, { commandId: 'c1', kind: 'success', text: 'Help text' }),
      event('turn/end', 8, 160, { turn: 1, reason: { kind: 'error', error: { message: 'Failed' } } }),
    ])

    expect(rows.map(row => row.kind)).toEqual(['system', 'request', 'retry', 'command', 'notice'])
    expect(rows[1]).toMatchObject({ turn: 1, step: 1, requestNumber: 1, provider: 'deepseek', model: 'chat', requestReason: 'initial', options: { provider: 'deepseek', model: 'chat', maxTokens: 100 }, tools: [{ name: 'read' }], status: 'error', result: 'Failed' })
    expect(rows[2]).toMatchObject({ text: 'Model retry 1 started', status: 'complete', content: 'Busy' })
    expect(rows[3]).toMatchObject({ text: '/help topic', result: 'Help text', status: 'complete' })
    expect(rows[4]).toMatchObject({ text: 'Turn failed', result: 'Failed', status: 'error' })
  })

  it('absorbs failed attempts into request retry and request-only assistant rows', () => {
    const rows = deriveRows([
      event('turn/start', 0, 100, { turn: 1 }),
      event('step/start', 1, 110, { turn: 1, step: 1 }),
      event('request/header', 2, 112, { header: { config: { provider: 'deepseek', model: 'chat' } } }),
      event('assistant/attempt', 3, 120, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 119, chunk: { type: 'finish', reason: { kind: 'error', error: { code: 'BUSY', message: 'Overloaded' } } } }] }),
      event('llm/retry', 4, 125, { retryId: 'retry-1', turn: 1, step: 1, retry: 1, failure: { message: 'Overloaded' } }),
      event('step/end', 5, 140, { turn: 1, step: 1 }),
    ])

    expect(rows.map(row => row.kind)).toEqual(['request', 'retry', 'message'])
    expect(rows[1]).toMatchObject({ requestNumber: 1, attempts: [{ seq: 3, error: 'Overloaded', errorCode: 'BUSY' }] })
    expect(rows[2]).toMatchObject({ requestOnly: true, status: 'error', requestNumber: 1, attempts: [{ seq: 3 }] })
  })

  it('tracks prompt/tool updates, request context, and cumulative usage', () => {
    const rows = deriveRows([
      event('turn/start', 0, 100, { turn: 1 }),
      event('step/start', 1, 110, { turn: 1, step: 1 }),
      event('request/header', 2, 112, { header: { system: 'Prompt one', config: { provider: 'deepseek', model: 'v3' }, tools: [{ name: 'read', inputSchema: { type: 'object' } }] } }),
      event('request/context', 3, 113, { provider: 'openrouter', model: 'v3.1', contextWindow: 128000 }),
      event('assistant/message', 4, 150, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'First' }] }, usage: { inputTokens: 10, outputTokens: 2 } }, 'append'),
      event('step/start', 5, 160, { turn: 1, step: 2 }),
      event('request/header', 6, 162, { header: { system: 'Prompt two', config: { provider: 'deepseek', model: 'v3' }, tools: [{ name: 'write' }] } }),
      event('assistant/message', 7, 190, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Second' }] }, usage: { inputTokens: 12, outputTokens: 3 } }, 'append'),
    ])

    expect(rows[0]).toMatchObject({ kind: 'system', content: 'Prompt one' })
    expect(rows[1]).toMatchObject({ kind: 'request', provider: 'openrouter', model: 'v3.1', requestContext: { contextWindow: 128000 }, status: 'complete', usage: { inputTokens: 10, outputTokens: 2 }, cumulativeUsage: { inputTokens: 10, outputTokens: 2 } })
    expect(rows[3]).toMatchObject({ kind: 'system', previousContent: 'Prompt one', content: 'Prompt two' })
    expect(rows[4]).toMatchObject({ kind: 'request', previousTools: [{ name: 'read', inputSchema: { type: 'object' } }], tools: [{ name: 'write' }] })
    expect(rows[4]).toMatchObject({ kind: 'request', status: 'complete', usage: { inputTokens: 12, outputTokens: 3 }, cumulativeUsage: { inputTokens: 22, outputTokens: 5 } })
    expect(rows[5]).toMatchObject({ kind: 'message', requestNumber: 2, cumulativeUsage: { inputTokens: 22, outputTokens: 5 } })
  })

  it('settles compaction checkpoints and keeps the end-seed boundary in sequence', () => {
    const rows = deriveRows([
      event('compaction/start', 1, 100, { compactionId: 'compact-1', turn: 1 }),
      event('compaction/summary', 2, 120, { compactionId: 'compact-1', turn: 1, summary: [{ type: 'text', text: 'Summary' }], shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900 }),
      event('compaction/end', 3, 130, { compactionId: 'compact-1', turn: 1 }),
      event('user/message', 4, 131, { content: [{ type: 'text', text: 'Summary' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' } }, 'append'),
      event('session/end-seed', 5, 140, {}),
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'compaction', replacementSeq: 4, shadowedItemCount: 3, shadowedTokenCount: 900 })
    expect(rows[1]).toMatchObject({ kind: 'boundary', text: 'End of seeded history' })
  })

  it('projects stable Turn, Step, and record rows for virtualization', () => {
    const rows = deriveRows([
      event('turn/start', 0, 100, { turn: 1 }),
      event('user/message', 1, 110, { turn: 1, step: 0, content: [{ type: 'text', text: 'Question' }] }, 'append'),
      event('step/start', 2, 120, { turn: 1, step: 1 }),
      event('assistant/message', 3, 150, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Answer' }] } }, 'append'),
    ])

    expect(groupLedgerRows(rows)).toMatchObject([{ turn: 1, groups: [{ step: 0 }, { step: 1 }] }])
    expect(projectLedgerVirtualRows(rows).map(row => row.type)).toEqual(['turn', 'step', 'record', 'step', 'record'])
    expect(projectLedgerVirtualRows(rows).map(row => row.height)).toEqual([28, 24, 30, 24, 30])
  })
})
