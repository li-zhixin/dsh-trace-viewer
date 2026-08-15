import { FileJson2, FolderOpen, LockKeyhole } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'

interface FileDropProps {
  onFile: (file: File) => void
  compact?: boolean
  disabled?: boolean
}

export function FileDrop({ onFile, compact = false, disabled = false }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)

  const accept = useCallback((files: FileList | null) => {
    const file = files?.[0]
    if (file) onFile(file)
  }, [onFile])

  if (compact) {
    return (
      <>
        <button className="icon-button" type="button" disabled={disabled} onClick={() => inputRef.current?.click()} aria-label="Open another JSONL file" title="Open file">
          <FolderOpen size={18} />
        </button>
        <input ref={inputRef} className="visually-hidden" type="file" accept=".jsonl,application/json,text/plain" onChange={event => accept(event.target.files)} />
      </>
    )
  }

  return (
    <div
      className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
      onDragEnter={event => {
        event.preventDefault()
        depth.current += 1
        setDragging(true)
      }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => {
        event.preventDefault()
        depth.current -= 1
        if (depth.current <= 0) setDragging(false)
      }}
      onDrop={event => {
        event.preventDefault()
        depth.current = 0
        setDragging(false)
        accept(event.dataTransfer.files)
      }}
    >
      <div className="drop-icon"><FileJson2 size={27} strokeWidth={1.7} /></div>
      <div className="drop-copy">
        <h2>{dragging ? 'Drop to inspect' : 'Open a session trace'}</h2>
        <p>Drag a DSH <code>session.jsonl</code> here</p>
      </div>
      <button className="primary-button" type="button" disabled={disabled} onClick={() => inputRef.current?.click()}>
        <FolderOpen size={17} />
        Choose file
      </button>
      <div className="privacy-note"><LockKeyhole size={14} /> Processed locally in this browser</div>
      <input ref={inputRef} className="visually-hidden" type="file" accept=".jsonl,application/json,text/plain" onChange={event => accept(event.target.files)} />
    </div>
  )
}
