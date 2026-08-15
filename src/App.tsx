import { AlertCircle, CheckCircle2, FileJson2, Github, Menu, MessageSquarePlus, Moon, PanelLeftClose, Sun, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ConversationView } from './components/ConversationView'
import { FileDrop } from './components/FileDrop'
import { Sidebar } from './components/Sidebar'
import { TimelineView } from './components/TimelineView'
import { DshFish } from './components/DshFish'
import { getSessionStats, parseDshJsonl, sessionTitle, type ParsedSession } from './lib/dsh'

type View = 'chat' | 'trajectory'
type Theme = 'light' | 'dark'

function initialTheme(): Theme {
  const stored = localStorage.getItem('dsh-trace-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function App() {
  const [session, setSession] = useState<ParsedSession>()
  const [file, setFile] = useState<File>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<View>('chat')
  const [query, setQuery] = useState('')
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [globalDrag, setGlobalDrag] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('dsh-trace-theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#151517' : '#ffffff')
  }, [theme])

  const openFile = useCallback(async (nextFile: File) => {
    setLoading(true)
    setError(undefined)
    try {
      const parsed = parseDshJsonl(await nextFile.text())
      setSession(parsed)
      setFile(nextFile)
      setView('chat')
      setQuery('')
      setSidebarOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to parse this file')
    } finally {
      setLoading(false)
    }
  }, [])

  const stats = useMemo(() => session ? getSessionStats(session) : undefined, [session])
  const title = session ? sessionTitle(session) : undefined

  const dragProps = session ? {
    onDragEnter: (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current += 1
      setGlobalDrag(true)
    },
    onDragOver: (event: React.DragEvent) => event.preventDefault(),
    onDragLeave: (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current -= 1
      if (dragDepth.current <= 0) setGlobalDrag(false)
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      dragDepth.current = 0
      setGlobalDrag(false)
      const next = event.dataTransfer.files[0]
      if (next) void openFile(next)
    },
  } : {}

  if (!session || !file || !stats) {
    return (
      <main className="welcome-shell">
        <header className="welcome-header">
          <span />
          <div className="header-actions">
            <a className="icon-button" href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer" aria-label="DeepSeek Harness on GitHub" title="DeepSeek Harness on GitHub"><Github size={18} /></a>
            <ThemeButton theme={theme} onChange={setTheme} />
          </div>
        </header>
        <div className="welcome-frame">
          <aside className="welcome-sidebar">
            <div className="sidebar-brand"><span className="sidebar-fish"><DshFish size={23} /></span><strong>deepseek-official <em>HARNESS</em></strong><button type="button" aria-label="Collapse sidebar">‹</button></div>
            <button className="new-session-button" type="button" onClick={() => document.querySelector<HTMLInputElement>('.welcome-file-input')?.click()}><MessageSquarePlus size={15} /><span>New session</span></button>
            <div className="sidebar-group-label">Sessions</div>
          </aside>
          <section className="welcome-content">
          <div className="welcome-title">
            <span className="eyebrow">DeepSeek Harness session inspector</span>
            <h1>Read the whole run,<br />event by event.</h1>
            <p>A focused local viewer for DSH session traces.</p>
          </div>
          <FileDrop onFile={openFile} disabled={loading} />
          {loading && <div className="toast"><span className="spinner" /> Parsing session…</div>}
            {error && <div className="error-banner"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label="Dismiss"><X size={15} /></button></div>}
          </section>
        </div>
        <input className="visually-hidden welcome-file-input" type="file" accept=".jsonl,application/json,text/plain" onChange={event => { const next = event.target.files?.[0]; if (next) void openFile(next) }} />
        <footer className="welcome-footer"><span>DSH format-aware</span><span>Nothing is uploaded</span><span>No account required</span></footer>
      </main>
    )
  }

  return (
    <main className="app-shell" {...dragProps}>
      {globalDrag && <div className="global-drop"><FileJson2 size={34} /><strong>Drop to replace trace</strong></div>}
      <header className="app-header">
        <button className="mobile-menu icon-button" type="button" onClick={() => setSidebarOpen(value => !value)} aria-label="Toggle session details"><Menu size={19} /></button>
        <Brand />
        <div className="trace-heading">
          <span>{title ?? file.name.replace(/\.jsonl$/i, '')}</span>
          <small>{file.name}</small>
        </div>
        <div className="header-actions">
          <div className="format-status"><CheckCircle2 size={14} /> DSH v{session.header.version}</div>
          <FileDrop compact onFile={openFile} disabled={loading} />
          <ThemeButton theme={theme} onChange={setTheme} />
        </div>
      </header>

      <div className={`app-body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label="Close session details" onClick={() => setSidebarOpen(false)} />}
        <div className={`sidebar-wrap ${sidebarOpen ? 'open' : ''}`}>
          <button className="sidebar-close icon-button" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close session details"><PanelLeftClose size={18} /></button>
          <Sidebar session={session} stats={stats} file={file} onFile={openFile} collapsed={sidebarCollapsed} onToggleCollapse={() => setSidebarCollapsed(value => !value)} />
        </div>
        <section className={`workspace is-${view}`}>
          <div className="workspace-toolbar">
            <div className="conversation-title-block">
              <strong>{title ?? file.name.replace(/\.jsonl$/i, '')}</strong>
            </div>
            <div className="workspace-toolbar-bottom">
              <nav className="view-tabs" role="tablist" aria-label="Trace views">
                {(['chat', 'trajectory'] as const).map(tab => (
                  <button type="button" role="tab" aria-selected={view === tab} className={view === tab ? 'active' : ''} key={tab} onClick={() => setView(tab)}>{tab[0]?.toUpperCase()}{tab.slice(1)}</button>
                ))}
              </nav>
            </div>
          </div>
          <div className={`workspace-content view-${view}`}>
            {view === 'chat' && <ConversationView events={session.events} query={query} cwd={session.header.cwd} onInspect={callId => { setQuery(callId); setView('trajectory') }} />}
            {view === 'trajectory' && <TimelineView events={session.events} query={query} onQueryChange={setQuery} />}
          </div>
        </section>
      </div>
      {error && <div className="error-banner floating"><AlertCircle size={17} /><span>{error}</span><button type="button" onClick={() => setError(undefined)} aria-label="Dismiss"><X size={15} /></button></div>}
    </main>
  )
}

function Brand() {
  return <div className="brand"><span className="brand-mark"><i /><i /><i /></span><strong>DSH</strong><span>Trace</span></div>
}

function ThemeButton({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return <button className="icon-button" type="button" onClick={() => onChange(theme === 'light' ? 'dark' : 'light')} aria-label={`Use ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Use ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</button>
}
