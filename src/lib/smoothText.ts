/**
 * Showing a stream at a steady pace, and showing a thought in one line.
 *
 * The model does not write at an even rate: it hands over a burst of words, then thinks, then another
 * burst. Rendering each burst as it arrives is why an answer appears in blocks even though every word
 * already fades in — the fade is per word, but forty words arrive in the same frame.
 *
 * So the reveal is paced by time instead of by arrival: whatever has arrived is shown at a rate that
 * drains the backlog within a fraction of a second. A small burst reads as a quick even run, a large
 * one still finishes fast, and the text never falls behind the model by more than DRAIN_MS. This is a
 * rendering decision only — it can never invent text the model has not sent, so a stall is still a
 * stall.
 */

/** Clear whatever is waiting within this long. Also the most the view may lag the model. */
export const DRAIN_MS = 180
/** Renders per second while streaming. Half of 60: the markdown tree is re-read on every paint. */
const PAINT_HZ = 30

/**
 * How many characters to add on this tick.
 *
 * Spread over the time the backlog has left, not over a fixed share that decays: dividing by a
 * constant each frame is geometric, so the last few words of a burst crawl and a thousand characters
 * take half a second instead of the window. Taking elapsed into account makes the window a real
 * bound — a burst is gone within DRAIN_MS however large it was.
 *
 * While text keeps arriving, elapsed stays near zero and the reveal settles into whatever rate keeps
 * up with it, so a live stream sits a frame or two behind rather than accumulating.
 */
export function revealStep(shown: number, total: number, dtMs: number, elapsedMs = 0): number {
  const backlog = Math.max(0, total - shown)
  if (backlog === 0) return 0
  const left = Math.max(1, DRAIN_MS - Math.max(0, elapsedMs))
  const step = Math.ceil((backlog * Math.max(0, dtMs)) / left)
  return Math.max(1, Math.min(backlog, step))
}

/**
 * What a thought is doing, in one word.
 *
 * The reasoning stream of a capable model is thousands of words of scratchpad. Drawing it — and
 * especially animating it — is what made the app heavy during a turn, and none of it is worth reading
 * live. One word says as much as the reader needs while it works.
 *
 * The word is taken from the thought itself rather than cycled on a timer: a rotating list would be
 * inventing a status. Nothing matching means the plain word, never a guess.
 */
export const THINKING_WORDS: Array<[RegExp, string]> = [
  // "list" alone is not writing: it appears in "verify this against the list" and would win there
  [/\b(write|writing|draft|drafting|phrasing|wording|rephrase|rephrasing|sentence|sentences)\b/i, 'Writing'],
  [/\b(count|counting|calculate|calculating|compute|computing|arithmetic|summing)\b/i, 'Counting'],
  [/\b(check|checking|verify|verifying|confirm|confirming|make sure)\b/i, 'Checking'],
  [/\b(search|searching|looking up|look up|finding|find)\b/i, 'Searching'],
  [/\b(plan|planning|outline|outlining|approach|structure|structuring)\b/i, 'Planning'],
  [/\b(compare|comparing|weighing|difference between)\b/i, 'Comparing'],
  [/\b(read|reading|parse|parsing|understand|understanding|figure out)\b/i, 'Reading'],
]

export function thinkingStatus(text: string): string {
  const whole = String(text || '').trim()
  if (!whole) return 'Thinking'
  // the tail first: what it is on now, rather than what it opened with
  const tail = whole.slice(-240)
  for (const [re, word] of THINKING_WORDS) if (re.test(tail)) return word
  for (const [re, word] of THINKING_WORDS) if (re.test(whole)) return word
  return 'Thinking'
}
