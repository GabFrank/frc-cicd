import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0b0f17",
          surface: "#131a26",
          raised: "#1a2332",
        },
        border: {
          subtle: "#1f2a3a",
          default: "#2a3749",
        },
        text: {
          primary: "#e6edf7",
          secondary: "#9aa7bd",
          muted: "#6b7a91",
        },
        status: {
          ok: "#22c55e",
          warn: "#eab308",
          err: "#ef4444",
          info: "#3b82f6",
          neutral: "#64748b",
        },
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
