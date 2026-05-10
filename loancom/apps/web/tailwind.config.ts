import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      fontSize: {
        // Octogenarian-friendly scale: bigger than typical
        base: ['18px', '28px'],
        lg: ['22px', '32px'],
        xl: ['26px', '34px'],
        '2xl': ['30px', '38px'],
        '3xl': ['36px', '44px'],
      },
      colors: {
        ink: '#0B1F3A',
        paper: '#FAFAF7',
        accent: '#1F4FA0',
        denyAmber: '#A14B0A',
        urgencyRed: '#9B1B1B',
        urgencyOrange: '#B05A00',
        urgencyYellow: '#9C7400',
        urgencyGreen: '#256C2E',
      },
      ringWidth: {
        DEFAULT: '3px',
      },
    },
  },
  plugins: [],
};

export default config;
