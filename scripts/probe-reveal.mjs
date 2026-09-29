// Runs the word-wrapping plugin over real markdown outside the app, so "is the plugin wrong" can be
// answered in seconds instead of a ten-minute build-and-self-test cycle.
//
//   node scripts/probe-reveal.mjs

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'

// verbatim from src/lib/Markdown.tsx
function rehypeWordSpans(options) {
  const SKIP = new Set(['pre', 'code', 'script', 'style'])
  return (tree) => {
    if (!options.enabled) return
    const walk = (node, insideCode) => {
      if (!node || !Array.isArray(node.children)) return
      const skip = insideCode || SKIP.has(node.tagName)
      const next = []
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

function count(node, out = { spans: 0, text: 0, tags: [] }) {
  if (!node) return out
  if (node.type === 'text') out.text += String(node.value || '').length
  if (node.type === 'element') {
    const cls = [].concat(node.properties?.className || [])
    if (cls.includes('word-in')) out.spans += 1
    out.tags.push(node.tagName)
  }
  for (const c of node.children || []) count(c, out)
  return out
}

const cases = {
  'plain one-liner': 'one two three four five',
  'streaming, half written': 'The quick brown fox',
  'with a code block': 'Here:\n\n```js\nconst a = 1\n```\n\nand after',
  'list and bold': '- first item\n- second **item**',
}

for (const [name, md] of Object.entries(cases)) {
  for (const enabled of [true, false]) {
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).parse(md)
    const transformed = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeWordSpans, { enabled })
      .run(await unified().use(remarkParse).use(remarkGfm).use(remarkRehype).parse(md))
    const c = count(transformed)
    console.log(
      `   ${name.padEnd(24)} enabled=${String(enabled).padEnd(5)} spans=${String(c.spans).padStart(3)}  text=${String(c.text).padStart(3)}  tags=${[...new Set(c.tags)].join(',')}`,
    )
    void tree
  }
}
