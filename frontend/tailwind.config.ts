/** @type {import('tailwindcss').Config} */
const content = [
  './src/**/*.{js,jsx,ts,tsx}',
  './public/**/*.{html,js}',
];

export default {
  content,
  theme: {
    extend: {
      colors: {
        background: "#f2f0ee",
        foreground: "#515152",
        border:     "#cfcdcc",
        muted:      "#939291",
        accent:     "#ecf150",
        card:       "#fafafa",
        highlight:  "#000000"
      }
    }
  },
  plugins: [],
};

//  --background: #0a0a0f;
//  --foreground: #e2e8f0;
//  --muted: #64748b;
//  --accent: #ffd56b;
//  --border: #1e293b;
//  --card: #0f172a;