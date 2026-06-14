// Design-system tokens for non-className contexts (icon colors, gradients, RNTP,
// reanimated). Mirror of tailwind.config.js + styles.css. See §4 of the port brief
// and docs/port-notes/styles-design.md for provenance.

export const colors = {
  background: "#0a0a0a",
  surface: "#121212",
  foreground: "#ededed",
  muted: "#b3b3b3",
  dim: "rgba(255,255,255,0.46)",
  // Two greens by surface: Spotify-green (Home scrollers) vs emerald (grid/transport).
  green: "#1ed760",
  emerald: "#10b981", // rgb(16,185,129)
  emeraldDarkCheck: "#04140d",
  card: "rgba(255,255,255,0.08)",
  cardHover: "rgba(255,255,255,0.09)",
  cardActive: "rgba(255,255,255,0.12)",
  line: "rgba(255,255,255,0.10)",
  iconIdle: "rgba(255,255,255,0.70)",
  backdrop: "rgba(0,0,0,0.60)",
  skeletonBase: "rgba(255,255,255,0.08)",
  skeletonShimmer: "rgba(255,255,255,0.13)",
  white: "#ffffff",
} as const;

export const layout = {
  mobileNavHeight: 52, // bottom tab bar
  mobilePlayerHeight: 68, // mini player
  cardWidthSm: 144, // w-36
  cardWidthMd: 160, // w-40 (>=sm)
  listRowMinHeight: 64,
} as const;

// Easing curves (cubic-bezier control points) for Reanimated `Easing.bezier(...)`.
export const motion = {
  routeEnter: { ms: 220, bezier: [0.16, 1, 0.3, 1] as const },
  coverSettle: { ms: 520, bezier: [0.16, 1, 0.3, 1] as const },
  skeleton: { ms: 1250 },
  pressScale: { ms: 160, scale: 0.985 },
  cardPress: { ms: 220, scale: 0.985, bezier: [0.2, 0.8, 0.2, 1] as const },
  listRow: { ms: 170 },
  sheetBackdrop: { ms: 280 },
  npOpen: { ms: 360, bezier: [0.16, 1, 0.3, 1] as const, opacityMs: 260 },
  npClose: { ms: 360, bezier: [0.4, 0, 1, 1] as const, opacityMs: 260, opacityDelayMs: 120 },
  marquee: { ms: 9000, startDelayMs: 1500, edgeFadePx: 14 },
} as const;
