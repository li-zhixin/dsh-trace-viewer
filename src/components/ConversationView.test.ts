import { describe, expect, it } from 'vitest'
import type { DshEvent } from '../lib/dsh'
import { projectChatItems, projectTurnProcesses } from './ConversationView'

function event(type: string, seq: number, data: Record<string, unknown>, surfaceOp?: 'append'): DshEvent {
  return { type, seq, time: 1_000 + seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) } as DshEvent
}

describe('projectChatItems', () => {
  it('matches DSH finalized assistant and tool lifecycle projection', () => {
    const events = [
      event('user/message', 0, { content: [{ type: 'text', text: 'Prompt' }], source: { kind: 'user' } }, 'append'),
      event('request/context', 1, { provider: 'deepseek', model: 'test' }),
      event('assistant/chunk', 2, { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'streamed duplicate' } }),
      event('assistant/message', 3, { turn: 1, step: 1, message: { content: [
        { type: 'reasoning', text: 'final reasoning' },
        { type: 'tool-call', id: 'call-a', name: 'bash', arguments: '{"command":"pwd"}' },
        { type: 'tool-call', id: 'call-b', name: 'read', arguments: '{"path":"README.md"}' },
      ] } }, 'append'),
      event('tool/call', 4, { turn: 1, step: 1, callId: 'call-a', name: 'bash', arguments: '{"command":"pwd"}' }),
      event('tool/result', 5, { message: { source: { kind: 'tool', callId: 'call-a' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '/repo' }] }] } }, 'append'),
      event('tool/call', 6, { turn: 1, step: 1, callId: 'call-b', name: 'read', arguments: '{"path":"README.md"}' }),
      event('tool/result', 7, { message: { source: { kind: 'tool', callId: 'call-b' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '# Repo' }] }] } }, 'append'),
    ]

    const items = projectChatItems(events)
    expect(items.map(item => item.kind)).toEqual(['user', 'assistant', 'tool', 'tool'])
    expect(items.filter(item => item.kind === 'assistant')).toHaveLength(1)
    expect(items.filter(item => item.kind === 'tool').map(item => item.callId)).toEqual(['call-a', 'call-b'])
  })

  it('keeps unfinished assistant chunks and nests code-dispatch calls', () => {
    const events = [
      event('assistant/chunk', 0, { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }),
      event('assistant/chunk', 1, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'partial' } }),
      event('tool/call', 2, { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{"code":"run()"}' }),
      event('tool/code-dispatch-start', 3, { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { path: 'a.ts' } }),
      event('tool/code-dispatch', 4, { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { path: 'a.ts' }, content: [{ type: 'text', text: 'source' }], isError: false }),
    ]

    const items = projectChatItems(events)
    expect(items.map(item => item.kind)).toEqual(['assistant', 'tool'])
    const root = items.find((item): item is Extract<typeof item, { kind: 'tool' }> => item.kind === 'tool')
    expect(root?.children).toHaveLength(1)
    expect(root?.children[0]).toMatchObject({ callId: 'child', name: 'read', error: false })
  })

  it('projects v3 system, attempt, compaction, and PTC events', () => {
    const events = [
      event('system/message', 0, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Be concise' }] } }, 'append'),
      event('assistant/attempt', 1, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1_001, chunk: { type: 'finish', reason: { kind: 'error', error: { message: 'Overloaded' } } } }] }),
      event('llm/retry', 2, { turn: 1, step: 1, retry: 1, delayMs: 100, failure: { message: 'Overloaded' } }),
      event('tool/call', 3, { turn: 1, step: 1, callId: 'root', name: 'run_code', arguments: '{}' }),
      event('tool/ptc-dispatch-start', 4, { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { path: 'a.ts' } }),
      event('tool/ptc-dispatch', 5, { rootCallId: 'root', parentCallId: 'root', subCallId: 'child', name: 'read', arguments: { path: 'a.ts' }, content: [{ type: 'text', text: 'source' }], isError: false }),
      event('compaction/start', 6, { compactionId: 'compact-1', turn: 1 }),
      event('compaction/summary', 7, { compactionId: 'compact-1', turn: 1, summary: [{ type: 'text', text: 'summary' }] }),
      event('compaction/end', 8, { compactionId: 'compact-1', turn: 1 }),
    ]

    const items = projectChatItems(events)
    expect(items.map(item => item.kind)).toEqual(['system', 'process', 'tool', 'process'])
    expect(items.find(item => item.kind === 'tool')?.children[0]).toMatchObject({ callId: 'child', result: [{ type: 'text', text: 'source' }] })
    expect(items.at(-1)).toMatchObject({ title: 'Conversation compacted', detail: 'Conversation history summarized' })
  })

  it('marks only the final text assistant in a completed turn for time and actions', () => {
    const events = [
      event('turn/start', 0, { turn: 1 }),
      event('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'I will check.' }] } }, 'append'),
      event('assistant/message', 2, { turn: 1, step: 2, message: { content: [{ type: 'tool-call', id: 'call-a', name: 'read', arguments: '{}' }] } }, 'append'),
      event('assistant/message', 3, { turn: 1, step: 3, message: { content: [{ type: 'text', text: 'Done.' }] } }, 'append'),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
      event('turn/start', 5, { turn: 2 }),
      event('assistant/message', 6, { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'Still running' }] } }, 'append'),
    ]

    const assistants = projectChatItems(events).filter(
      (item): item is Extract<ReturnType<typeof projectChatItems>[number], { kind: 'assistant' }> => item.kind === 'assistant',
    )
    expect(assistants.map(item => item.turnTail === true)).toEqual([false, false, true, false])
  })

  it('correlates request, retry, command, turn outcome, and turn statistics', () => {
    const events = [
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('request/header', 2, { header: { system: 'Legacy prompt', config: { provider: 'test', model: 'm' } }, reason: 'initial' }),
      event('llm/retry', 3, { retryId: 'r1', turn: 1, step: 1, retry: 1, delayMs: 100, failure: { message: 'Busy' } }),
      event('llm/retry-started', 4, { retryId: 'r1', turn: 1, step: 1, retry: 1 }),
      event('assistant/message', 5, {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'Partial answer' }] },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 1 },
        stream: [{ type: 'chunk', time: 1_003, chunk: { type: 'text-delta', index: 0, text: 'Partial' } }],
      }, 'append'),
      event('turn/end', 6, { turn: 1, reason: { kind: 'max-tokens' } }),
      event('command/run', 7, { commandId: 'c1', name: 'help', args: ' topic', source: { kind: 'user' } }),
      event('command/done', 8, { commandId: 'c1', kind: 'success', text: 'Help text' }),
      event('turn/end', 9, { turn: 2, reason: { kind: 'error', error: { message: 'No key', code: 'AUTH' } } }),
    ]

    const items = projectChatItems(events)
    expect(items.filter(item => item.kind === 'system')).toEqual([
      expect.objectContaining({ text: 'Legacy prompt', update: false }),
    ])
    expect(items.filter(item => item.kind === 'process')).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'retry-r1', title: 'Model retry 1 started', retryState: 'started', retry: 1, delayMs: 100 }),
      expect.objectContaining({ title: 'Maximum output tokens reached', tone: 'warning' }),
      expect.objectContaining({ title: 'Turn failed', detail: 'No key (AUTH)', tone: 'error' }),
    ]))
    expect(items.find(item => item.kind === 'command')).toMatchObject({ name: 'help', args: ' topic', outcome: 'success', result: 'Help text' })
    expect(items.find(item => item.kind === 'assistant')).toMatchObject({
      turnTail: true,
      stats: { usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, reasoningTokens: 1 } },
    })
  })

  it('folds intermediate messages and tools into a turn process', () => {
    const items = projectChatItems([
      event('turn/start', 0, { turn: 1 }),
      event('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Checking' }] } }, 'append'),
      event('tool/call', 2, { turn: 1, step: 1, callId: 'a', name: 'read', arguments: '{}' }),
      event('assistant/message', 3, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Done' }] } }, 'append'),
      event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
    ])
    const presentation = projectTurnProcesses(items)
    expect(presentation.map(item => item.kind)).toEqual(['turn-process', 'assistant'])
    expect(presentation[0]).toMatchObject({ messageCount: 1, toolCallCount: 1, subagentCount: 0 })
  })

  it('absorbs retried attempts and merges a manual compact command', () => {
    const items = projectChatItems([
      event('command/run', 0, { commandId: 'compact-1', name: 'compact', source: { kind: 'user' } }),
      event('assistant/attempt', 1, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1_001, chunk: { type: 'finish', reason: { kind: 'error', error: { message: 'Busy' } } } }] }),
      event('llm/retry', 2, { retryId: 'r1', turn: 1, step: 1, retry: 1, failure: { message: 'Busy' } }),
      event('compaction/start', 3, { compactionId: 'cp1', turn: 1, sourceCommandId: 'compact-1' }),
      event('compaction/summary', 4, { compactionId: 'cp1', shadowedSeqs: [1, 2], shadowedTokenCount: 123 }),
      event('compaction/end', 5, { compactionId: 'cp1' }),
    ])
    expect(items.filter(item => item.kind === 'process')).toHaveLength(1)
    expect(items.find(item => item.kind === 'command')).toMatchObject({ name: 'compact', outcome: 'success', result: '2 items · 123 tokens' })
  })

  it('uses upstream prompt snapshot rules and keeps prompt updates at their actual position', () => {
    const items = projectChatItems([
      event('turn/start', 0, { turn: 1 }),
      event('step/start', 1, { turn: 1, step: 1 }),
      event('system/message', 2, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Prompt one' }] } }, 'append'),
      event('request/header', 3, { turn: 1, step: 1, reason: 'initial', header: { config: { provider: 'test', model: 'm' }, tools: [{ name: 'read' }] } }),
      event('step/start', 4, { turn: 1, step: 2 }),
      event('request/header', 5, { turn: 1, step: 2, reason: 'change', header: { config: { provider: 'test', model: 'm' }, tools: [{ name: 'write' }] } }),
      event('system/message', 6, { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'Prompt two' }] } }, 'append'),
      event('request/header', 7, { turn: 1, step: 2, reason: 'change', header: { config: { provider: 'test', model: 'm' }, tools: [{ name: 'write' }] } }),
    ])

    expect(items.filter(item => item.kind === 'system')).toEqual([
      expect.objectContaining({ key: 'system-2', seq: 0, text: 'Prompt one', update: false }),
      expect.objectContaining({ key: 'system-6', seq: 6, text: 'Prompt two', update: true }),
    ])
  })
})
