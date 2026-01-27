module.exports = {
  content: ['./*.{html,tsx}', './components/**/*.tsx', './services/**/*.ts'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        cyber: {
          black: '#020617',
          dark: '#0f172a',
          slate: '#1e293b',
          primary: '#06b6d4',
          accent: '#eab308',
          danger: '#ef4444',
        }
      },
      animation: {
        'pulse-fast': 'pulse 1.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        glow: {
          '0%': { boxShadow: '0 0 5px #06b6d4' },
          '100%': { boxShadow: '0 0 20px #06b6d4, 0 0 10px #06b6d4' },
        }
      }
    },
  },
  plugins: [],
}
