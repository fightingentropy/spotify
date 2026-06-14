/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        // Page / surfaces (design system §4 + styles.css tokens)
        background: "#0a0a0a", // near-black page bg
        surface: "#121212", // elevated / mini-player bg
        foreground: "#ededed", // primary text
        muted: "#b3b3b3", // secondary text
        dim: "rgba(255,255,255,0.46)", // captions
        // Two greens, by surface (see §4): Spotify-green for Home scrollers,
        // emerald for grid cards + Now Playing transport/sliders/likes.
        green: "#1ed760", // Spotify green
        emerald: "rgb(16,185,129)", // emerald-500 accent (#10b981)
        emeraldDarkCheck: "#04140d", // dark check inside filled "downloaded" badge
        card: "rgba(255,255,255,0.08)",
        cardHover: "rgba(255,255,255,0.09)",
        cardActive: "rgba(255,255,255,0.12)",
        line: "rgba(255,255,255,0.10)", // hairline border
        iconIdle: "rgba(255,255,255,0.70)",
        backdrop: "rgba(0,0,0,0.60)",
        // Section accents
        radio: "rgba(6,182,212,0.15)", // cyan-500/15
        podcast: "rgba(217,70,239,0.15)", // fuchsia-500/15
      },
      borderRadius: {
        card: "8px",
        row: "12px",
        art: "16px",
      },
    },
  },
  plugins: [],
};
