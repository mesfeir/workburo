/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paper blueprint: unbleached paper, carbon ink, one hazard red.
        sidebar: '#EAE8E1',
        canvas: '#F4F4F0',
        panel: '#EFEDE7',
        pill: '#DDD9D0',
        bubble: '#E4E1D9',
        hair: '#C9C5BA',
        ink: '#111111',
        muted: '#4A463D',
        faint: '#6E6A60',
        accent: '#E61919',
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Mono', 'Consolas', 'monospace'],
        display: ['Archivo Black', 'Inter', 'system-ui', 'sans-serif'],
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
