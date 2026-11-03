/**
 * Theme colours are CSS variables holding hex values, which Tailwind v3 can't
 * apply an opacity modifier to (`bg-success/15` used to generate NOTHING —
 * the tint was silently transparent). A colour function fixes that: plain
 * classes stay `var(--x)`; `/NN` classes mix the variable with transparent.
 * Engines without color-mix() drop the declaration (= the old behaviour).
 */
// Plain classes get an opacity VARIABLE (`var(--tw-bg-opacity)`) — those must
// stay a bare var(), or every background would vanish where color-mix() isn't
// supported. Only a literal modifier (`/15` → '0.15') mixes.
const themed = (name) => ({ opacityValue }) =>
  opacityValue === undefined || opacityValue === '1' || String(opacityValue).startsWith('var(')
    ? `var(${name})`
    : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Theme colors using CSS variables
        crust: themed('--color-crust'),
        mantle: themed('--color-mantle'),
        base: themed('--color-base'),
        'surface-0': themed('--color-surface-0'),
        'surface-1': themed('--color-surface-1'),
        'surface-2': themed('--color-surface-2'),
        'overlay-0': themed('--color-overlay-0'),
        'overlay-1': themed('--color-overlay-1'),
        'overlay-2': themed('--color-overlay-2'),
        text: themed('--color-text'),
        'subtext-0': themed('--color-subtext-0'),
        'subtext-1': themed('--color-subtext-1'),
        'primary-text': themed('--color-primary-text'),
        primary: themed('--color-primary'),
        'primary-hover': themed('--color-primary-hover'),
        secondary: themed('--color-secondary'),
        success: themed('--color-success'),
        warning: themed('--color-warning'),
        error: themed('--color-error'),
        info: themed('--color-info'),
        low: themed('--color-low'),
        medium: themed('--color-medium'),
        high: themed('--color-high'),
        // Gilt (docs/dev/GILT.md): gold ornaments; gilt-a/-b are gold at ~30% / ~11%
        gold: themed('--color-gold'),
        'gilt-a': themed('--color-gilt-a'),
        'gilt-b': themed('--color-gilt-b'),
      },
      // Gilt's corners: existing rounded-* classes change shape with no edits.
      borderRadius: {
        sm: '2px',
        DEFAULT: '3px',
        md: '3px',
        lg: '3px',
        xl: '4px',
        '2xl': '5px',
      },
      fontFamily: {
        sans: ['Figtree', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica', 'Arial', 'sans-serif'],
        deco: ['"Josefin Sans"', 'Figtree', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
