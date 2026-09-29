import { Moon, Sun } from 'lucide-react'
import type { ThemeName } from '../types'

/** The palette switch: a pill with a sliding thumb, moon on dark and sun on paper.
 *
 *  Two things about it are deliberate. It drives the same config value the Settings pane does, so
 *  the two controls cannot disagree and the choice persists with everything else. And every colour
 *  comes from the theme variables, including the thumb: a hardcoded palette inside the control that
 *  exists to switch palettes would be the one element that does not change when it does.
 *
 *  Keyboard reachable, unlike a plain clickable div: Enter and Space both flip it.
 */
export default function ThemeToggle({
  theme,
  onTheme,
  className = '',
}: {
  theme?: ThemeName
  onTheme: (theme: ThemeName) => void
  className?: string
}) {
  const isDark = (theme || 'dark') === 'dark'
  const flip = () => onTheme(isDark ? 'paper' : 'dark')

  return (
    <button
      type="button"
      role="switch"
      aria-checked={!isDark}
      aria-label={isDark ? 'Switch to the paper theme' : 'Switch to the dark theme'}
      title={isDark ? 'Dark theme. Click for paper.' : 'Paper theme. Click for dark.'}
      data-theme-toggle
      onClick={flip}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          flip()
        }
      }}
      className={`relative flex h-7 w-12 shrink-0 items-center rounded-full border border-[var(--rule)] bg-[var(--raised-3)] p-1 transition-colors ${className}`}
    >
      {/* the thumb sits behind whichever glyph is active, and slides between the two slots */}
      <span
        aria-hidden
        className={`absolute h-5 w-5 rounded-full bg-[var(--accent)] transition-transform duration-300 ${
          isDark ? 'translate-x-0' : 'translate-x-full'
        }`}
      />
      <span className="relative z-10 grid h-5 w-5 place-items-center">
        <Moon
          size={12}
          strokeWidth={1.75}
          className={isDark ? 'text-[var(--text-solid)]' : 'text-[var(--text-dim)]'}
        />
      </span>
      <span className="relative z-10 grid h-5 w-5 place-items-center">
        <Sun
          size={12}
          strokeWidth={1.75}
          className={isDark ? 'text-[var(--text-dim)]' : 'text-[var(--text-solid)]'}
        />
      </span>
    </button>
  )
}
