import { describe, expect, it } from 'vitest'
import { getSessionStats, parseDshJsonl } from './dsh'

const header = JSON.stringify({
  type: 'session', version: 0, id: 'session-1', createdAt: 1_700_000_000_000, delegationDepth: 0,
})

describe('parseDshJsonl', () => {
  it('parses a session and reports sequence gaps without hiding events', () => {
    const source = [
      header,
      JSON.stringify({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: 200, data: { turn: 1 } }),
    ].join('\n')
    const result = parseDshJsonl(source)
    expect(result.header.id).toBe('session-1')
    expect(result.events).toHaveLength(2)
    expect(result.issues).toEqual([{ line: 3, message: 'Expected seq 1, found 2' }])
  })

  it('expands packed DSH chunk rows losslessly', () => {
    const source = [
      header,
      JSON.stringify({
        type: 'text-chunks', seq0: 0, time0: 100,
        data: { turn: 1, step: 1, index: 0, dt: [3, 4], texts: ['Deep', 'Seek', '!'] },
      }),
    ].join('\n')
    const result = parseDshJsonl(source)
    expect(result.events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(result.events.map(event => event.time)).toEqual([100, 103, 107])
    expect(result.events.map(event => (event.data as { chunk: { text: string } }).chunk.text).join('')).toBe('DeepSeek!')
  })

  it('derives stats from tool and assistant events', () => {
    const source = [
      header,
      JSON.stringify({ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }),
      JSON.stringify({ type: 'assistant/message', seq: 1, time: 140, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 12, outputTokens: 8 } } }),
      JSON.stringify({ type: 'tool/call', seq: 2, time: 150, data: { turn: 1, step: 1, name: 'bash' } }),
    ].join('\n')
    expect(getSessionStats(parseDshJsonl(source))).toMatchObject({
      turns: 1, steps: 1, toolCalls: 1, inputTokens: 12, outputTokens: 8,
    })
  })

  it('includes the source line in malformed input errors', () => {
    expect(() => parseDshJsonl(`${header}\n{"type":`)).toThrow('Line 2: invalid JSON')
  })
})
