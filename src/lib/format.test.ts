import { describe, expect, it } from 'vitest'
import { formatMessageClock } from './format'

describe('formatMessageClock', () => {
  it('uses the same date-aware clock tiers as DSH Chat', () => {
    const now = new Date(2026, 8, 15, 18, 0).getTime()
    expect(formatMessageClock(new Date(2026, 8, 15, 9, 5).getTime(), now)).toBe('09:05')
    expect(formatMessageClock(new Date(2026, 7, 2, 9, 5).getTime(), now)).toBe('8/2 09:05')
    expect(formatMessageClock(new Date(2025, 7, 2, 9, 5).getTime(), now)).toBe('2025-8-2 09:05')
  })
})
