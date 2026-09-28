/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sidebar: '#0d0d0d',
        canvas: '#000000',
        panel: '#191919',
        pill: '#2f2f2f',
        bubble: '#2f2f2f',
        hair: '#2a2a2a',
        ink: '#ececec',
        muted: '#a8a8a8',
        faint: '#6e6e6e',
        accent: '#2f6feb',
      },
      fontFamily: {
        sans: ['Segoe UI Variable Text', 'Segoe UI', 'system-ui', 'sans-serif'],
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
