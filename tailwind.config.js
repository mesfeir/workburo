/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sidebar: 'var(--app)',
        canvas: 'var(--app)',
        panel: 'var(--raised)',
        pill: 'var(--raised-3)',
        bubble: 'var(--raised-3)',
        hair: 'var(--rule)',
        ink: 'var(--text)',
        muted: 'var(--text-mid)',
        faint: 'var(--text-dim)',
        accent: 'var(--accent)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
        display: "'Archivo Black', 'Inter', system-ui, sans-serif",
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        blink: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.15' } },
      },
      animation: {
        'fade-up': 'fade-up .22s ease-out both',
        blink: 'blink 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
