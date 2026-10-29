import daisyui from 'daisyui';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,ts}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['Figtree', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [daisyui],
  daisyui: {
    // Daftar ini harus sama dengan opsi `theme` di public/admin/config.yml dan src/content/config.ts
    themes: ['light', 'dark', 'cupcake', 'corporate', 'emerald', 'forest', 'synthwave', 'retro'],
    logs: false,
  },
};
