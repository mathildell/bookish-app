/** @type {import('tailwindcss').Config} */
const content = [
  './src/**/*.{js,jsx,ts,tsx}',
  './public/**/*.{html,js}',
];

export default {
  content,
  theme: {
    extend: {
      background: "#c6c8c8",
      foreground: "#000000",
      muted:      "#c8c819",
      accent:     "#c81c16",
      border:     "#c816bc",
      card:       "#1839c8"
/*
  --background: #0a0a0f;
  --foreground: #e2e8f0;
  --muted: #64748b;
  --accent: #ffd56b;
  --border: #1e293b;
  --card: #0f172a;
*/
    }
  },
  plugins: [],
};
