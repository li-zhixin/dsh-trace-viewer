import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { prettyJson } from '../lib/format'

export function JsonBlock({ value, className = '' }: { value: unknown; className?: string }) {
  const [copied, setCopied] = useState(false)
  const text = prettyJson(value)

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <div className={`json-block ${className}`}>
      <button type="button" className="json-copy" onClick={copy} aria-label="Copy JSON" title="Copy JSON">
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
      <pre>{text}</pre>
    </div>
  )
}
