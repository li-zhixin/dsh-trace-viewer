import { Activity, Bot, CalendarClock, CircleGauge, FileJson2, FolderGit2, GitFork, MessageSquarePlus, TerminalSquare } from 'lucide-react'
import type { ParsedSession, SessionStats } from '../lib/dsh'
import { formatDate, formatDuration, formatNumber, truncateMiddle } from '../lib/format'
import { useRef } from 'react'
import { DshFish } from './DshFish'

interface SidebarProps {
  session: ParsedSession
  stats: SessionStats
  file: File
  onFile: (file: File) => void
  collapsed?: boolean
  onToggleCollapse?: () => void
}

export function Sidebar({ session, stats, file, onFile, collapsed = false, onToggleCollapse }: SidebarProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const header = session.header
  const topTypes = [...stats.eventTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxCount = topTypes[0]?.[1] ?? 1

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-fish"><DshFish size={23} /></span>
        <strong>deepseek-official <em>HARNESS</em></strong>
        <button type="button" onClick={onToggleCollapse} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}><span>{collapsed ? '›' : '‹'}</span></button>
      </div>
      <button className="new-session-button" type="button" onClick={() => inputRef.current?.click()}>
        <MessageSquarePlus size={15} />
        <span>New session</span>
      </button>
      <input ref={inputRef} className="visually-hidden" type="file" accept=".jsonl,application/json,text/plain" onChange={event => { const next = event.target.files?.[0]; if (next) onFile(next) }} />
      <div className="sidebar-group-label">Sessions</div>
      <div className="session-row active">
        <FileJson2 size={15} />
        <span title={file.name}>{file.name}</span>
        <i />
      </div>
      <section className="sidebar-section session-identity">
        <span className="section-label">Session details</span>
        <strong title={String(header.id)}>{truncateMiddle(String(header.id), 34)}</strong>
        <span>{file.name} · {formatNumber(file.size)} bytes</span>
      </section>

      <section className="sidebar-section facts">
        <div><CalendarClock size={15} /><span>Created</span><strong>{formatDate(Number(header.createdAt))}</strong></div>
        <div><CircleGauge size={15} /><span>Duration</span><strong>{formatDuration(stats.duration)}</strong></div>
        {header.cwd && <div><FolderGit2 size={15} /><span>Working dir</span><strong title={header.cwd}>{truncateMiddle(header.cwd, 24)}</strong></div>}
        {header.agentPreset && <div><Bot size={15} /><span>Preset</span><strong>{header.agentPreset}</strong></div>}
        {header.parentSession && <div><GitFork size={15} /><span>Parent</span><strong title={header.parentSession}>{truncateMiddle(header.parentSession, 18)}</strong></div>}
      </section>

      <section className="sidebar-section metric-grid">
        <div><strong>{formatNumber(session.events.length)}</strong><span>events</span></div>
        <div><strong>{formatNumber(stats.turns)}</strong><span>turns</span></div>
        <div><strong>{formatNumber(stats.toolCalls)}</strong><span>tools</span></div>
        <div><strong>{formatNumber(stats.inputTokens + stats.outputTokens)}</strong><span>tokens</span></div>
      </section>

      <section className="sidebar-section event-profile">
        <div className="section-heading"><span className="section-label">Event profile</span><Activity size={14} /></div>
        {topTypes.map(([type, count]) => (
          <div className="profile-row" key={type}>
            <div><span title={type}>{type}</span><strong>{count}</strong></div>
            <i style={{ width: `${Math.max(4, count / maxCount * 100)}%` }} />
          </div>
        ))}
      </section>

      {session.issues.length > 0 && (
        <section className="sidebar-section issue-box">
          <TerminalSquare size={16} />
          <div><strong>{session.issues.length} sequence issue{session.issues.length === 1 ? '' : 's'}</strong><span>Trace remains viewable</span></div>
        </section>
      )}
    </aside>
  )
}
