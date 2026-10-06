import type { ToolActivity } from '../types'

/**
 * What a turn's tool calls should put on screen.
 *
 * Written as a plain function rather than left inside the component so the rule can be tested
 * without rendering anything.
 *
 * The rule: while a turn is running, only the tool in hand is shown. It is the only one that is
 * changing, and a line per call meant an agent turn that used forty tools became a forty-line block
 * that filled the window and re-rendered on every streamed token. The ones already finished are
 * counted, not listed, and the count opens on a click.
 *
 * Once the turn stops, the whole run folds to a single line — the tool's own label when there was
 * one call, otherwise how many there were.
 */
export function toolLabel(t: ToolActivity): string {
  if (t.server) return 'Searched the web'
  return t.label || t.name
}

export interface ToolView {
  empty: boolean
  /** The tool being used right now, or the last one when the turn has stopped. */
  current: ToolActivity | null
  /** Everything else, in the order it ran. */
  done: ToolActivity[]
  /** The single line shown when the turn is over. */
  summary: string
  /** Whether the caller said the turn is still running. */
  live: boolean
}

export function toolView(tools: ToolActivity[] | undefined, streaming?: boolean): ToolView {
  const list = tools || []
  if (!list.length) {
    return { empty: true, current: null, done: [], summary: '', live: false }
  }

  const running = [...list].reverse().find((t) => t.status === 'running')
  const current = running || list[list.length - 1]
  const done = list.filter((t) => t.id !== current.id)

  return {
    empty: false,
    current,
    done,
    summary: list.length === 1 ? toolLabel(current) : `${list.length} tools used`,
    live: !!streaming,
  }
}
