import { useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Check, Copy } from 'lucide-react'

function CodeBlock({ children }: { children?: any }) {
  const [copied, setCopied] = useState(false)
  const holder = useCallback((node: HTMLDivElement | null) => {
    if (node) node.dataset.raw = node.querySelector('code')?.textContent ?? ''
  }, [])

  const copy = async () => {
    const node = document.querySelector<HTMLDivElement>('[data-raw]:focus-within')
    const text =
      (node?.dataset.raw as string) ||
      (children?.props?.children ? String(children.props.children) : '')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  const lang =
    (Array.isArray(children?.props?.className)
      ? children.props.className.join(' ')
      : children?.props?.className || ''
    ).match(/language-([\w+-]+)/)?.[1] || ''

  return (
    <div className="group relative" ref={holder}>
      <div className="flex items-center justify-between rounded-t-xl border border-b-0 border-hair bg-[var(--app)] px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-faint">{lang || 'code'}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-white/10 hover:text-ink"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">{children}</pre>
    </div>
  )
}

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-zen">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
