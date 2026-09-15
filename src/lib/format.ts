export function formatDate(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'Unknown'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(value)
}

export function formatTime(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '--:--:--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }).format(value)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** Match DSH Chat's compact, date-aware local message clock. */
export function formatMessageClock(time: number, now: number = Date.now()): string {
  const date = new Date(time)
  const reference = new Date(now)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate()) return clock
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`
  return date.getFullYear() === reference.getFullYear()
    ? `${monthDay} ${clock}`
    : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${clock}`
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(milliseconds / 60_000)
  const seconds = Math.round((milliseconds % 60_000) / 1_000)
  return `${minutes}m ${seconds}s`
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value)
}

export function truncateMiddle(value: string, max = 32): string {
  if (value.length <= max) return value
  const side = Math.floor((max - 1) / 2)
  return `${value.slice(0, side)}…${value.slice(-side)}`
}

export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  return JSON.stringify(value, null, 2)
}
