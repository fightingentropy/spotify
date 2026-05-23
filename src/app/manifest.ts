import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/spotify-music-player/v2",
    name: "Spotify",
    short_name: "Spotify",
    description: "Local-first music player for your library",
    lang: "en",
    dir: "ltr",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "browser"],
    orientation: "portrait",
    background_color: "#121212",
    theme_color: "#121212",
    categories: ["music", "entertainment"],
    prefer_related_applications: false,
    shortcuts: [
      {
        name: "Library",
        short_name: "Library",
        url: "/library",
        icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      },
      {
        name: "Add Song",
        short_name: "Add",
        url: "/upload",
        icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
      },
    ],
    icons: [
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
