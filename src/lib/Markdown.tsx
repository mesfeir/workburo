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
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted transition hover:bg-[var(--raised-2)] hover:text-ink"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">{children}</pre>
    </div>
  )
}

/** Wrap each word of prose in a span, so that a word arriving from the model can animate in as it
 *  appears rather than snapping into place.
 *
 *  This runs inside the markdown tree rather than over the raw text for two reasons: the answer is
 *  rendered as markdown *while* it streams, so splitting the source would break every table and list
 *  mid-word; and React reconciles these spans by position, so the words already on screen keep their
 *  nodes and only the newly arrived ones play the animation. Code is skipped outright — a span
 *  inside <pre> would break both the highlighting and the copy button's text.
 */
function rehypeWordSpans(options: { enabled: boolean }) {
  const SKIP = new Set(['pre', 'code', 'script', 'style'])
  return (tree: any) => {
    if (!options.enabled) return
    const walk = (node: any, insideCode: boolean) => {
      if (!node || !Array.isArray(node.children)) return
      const skip = insideCode || SKIP.has(node.tagName)
      const next: any[] = []
      for (const child of node.children) {
        if (child.type === 'text' && !skip) {
          for (const part of String(child.value).split(/(\s+)/)) {
            if (part === '') continue
            next.push(
              /^\s+$/.test(part)
                ? { type: 'text', value: part }
                : {
                    type: 'element',
                    tagName: 'span',
                    properties: { className: ['word-in'] },
                    children: [{ type: 'text', value: part }],
                  },
            )
          }
        } else {
          walk(child, skip)
          next.push(child)
        }
      }
      node.children = next
    }
    walk(tree, false)
  }
}

export default function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className="prose-zen">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          [rehypeWordSpans, { enabled: !!streaming }],
        ]}
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
