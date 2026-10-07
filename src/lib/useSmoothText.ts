import { useEffect, useRef, useState } from 'react'
import { revealStep } from './smoothText'

/**
 * The visible portion of a streaming string.
 *
 * Grows toward the full text on an animation frame, and snaps to the whole of it the moment the
 * stream ends — a finished message must never be left mid-sentence because the animation was behind.
 * The rules it follows live in smoothText.ts, which plain Node tests.
 */

/** Renders per second while streaming. Half of 60: the markdown tree is re-read on every paint. */
const PAINT_HZ = 30

export default function useSmoothText(text: string, streaming?: boolean): string {
  const full = String(text || '')
  const [shown, setShown] = useState(streaming ? 0 : full.length)
  const target = useRef(full)
  target.current = full

  useEffect(() => {
    if (!streaming) {
      setShown(target.current.length)
      return
    }
    let alive = true
    let raf = 0
    let last = performance.now()
    let painted = last
    // when the text last grew, so the rule can spread a backlog over the window rather than decaying
    let grew = last
    let seen = target.current.length

    const tick = (now: number) => {
      if (!alive) return
      const dt = now - last
      last = now
      if (target.current.length !== seen) {
        seen = target.current.length
        grew = now
      }
      if (now - painted >= 1000 / PAINT_HZ) {
        painted = now
        setShown((s) => {
          const total = target.current.length
          // a shorter string means a different message, or a new turn: follow it rather than sticking
          // on a count that no longer means anything
          if (s > total) return total
          if (s >= total) return s
          return Math.min(total, s + revealStep(s, total, dt, now - grew))
        })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [streaming])

  if (!streaming) return full
  return full.slice(0, Math.min(shown, full.length))
}
