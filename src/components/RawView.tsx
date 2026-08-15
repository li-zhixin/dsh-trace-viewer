import { useVirtualizer } from '@tanstack/react-virtual'
import { SearchX } from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { ParsedSession } from '../lib/dsh'
import { prettyJson } from '../lib/format'

export function RawView({ session, query }: { session: ParsedSession; query: string }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => {
    const all = [
      { line: 1, value: session.header },
      ...session.events.map((event, index) => ({ line: session.sourceLines[index] ?? index + 2, value: event })),
    ]
    const normalized = query.trim().toLowerCase()
    return normalized ? all.filter(row => JSON.stringify(row.value).toLowerCase().includes(normalized)) : all
  }, [session, query])
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 42, overscan: 15 })

  if (rows.length === 0) return <div className="empty-state"><SearchX size={28} /><strong>No matching records</strong><span>Try a different search.</span></div>
  return (
    <div className="raw-scroll" ref={parentRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map(row => {
          const item = rows[row.index]!
          return (
            <div className="raw-row" key={`${item.line}-${row.index}`} style={{ transform: `translateY(${row.start}px)` }}>
              <span>{item.line}</span><code>{prettyJson(item.value).replace(/\n\s*/g, ' ')}</code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
