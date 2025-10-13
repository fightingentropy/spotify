import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    unoptimized: true, // Disable optimization globally since we serve from API routes
    formats: ['image/avif', 'image/webp'], // Modern formats for better compression
  },
  // Enable React compiler optimizations
  experimental: {
    optimizePackageImports: ['lucide-react'], // Optimize icon imports
  },
  // Production optimizations
  poweredByHeader: false, // Remove X-Powered-By header for security
  compress: true, // Enable gzip compression
};

export default nextConfig;
