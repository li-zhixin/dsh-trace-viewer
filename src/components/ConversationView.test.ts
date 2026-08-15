import { describe, expect, it } from 'vitest'
import type { DshEvent } from '../lib/dsh'
import { projectChatItems } from './ConversationView'

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
})
