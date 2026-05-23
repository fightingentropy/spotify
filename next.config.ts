import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Covers served from /api/files/[...key] with an immutable cache header —
    // Next.js's image optimizer proxies them, emits AVIF/WebP variants, and
    // caches per requested size. This is the thumbnail variant: grid views
    // download a small format-optimized version instead of the full cover.
    localPatterns: [
      {
        pathname: "/api/files/**",
      },
      {
        pathname: "/api/artwork/**",
      },
      {
        pathname: "/apple-icon.png",
      },
      {
        pathname: "/icon.svg",
      },
      {
        pathname: "/icon-512.png",
      },
      {
        pathname: "/waveform-pwa-icon-180.png",
      },
      {
        pathname: "/waveform-pwa-icon-512.png",
      },
      {
        pathname: "/waveform.svg",
      },
    ],
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  serverExternalPackages: ["better-sqlite3", "music-metadata"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  poweredByHeader: false,
  compress: true,
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
          {
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, no-store, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

import('@opennextjs/cloudflare').then(m => m.initOpenNextCloudflareForDev());
