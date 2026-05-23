import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import Image from "next/image";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { AuthButtons } from "@/components/AuthButtons";
import { PlayerBar } from "@/components/PlayerBar";
import LibrarySidebar from "@/components/LibrarySidebar";
import NowPlayingSidebar from "@/components/NowPlayingSidebar";
import MobileNav from "@/components/MobileNav";
import PwaRegister from "@/components/PwaRegister";
import InstallPrompt from "@/components/InstallPrompt";


const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
  preload: true,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
  preload: true,
});

export const metadata: Metadata = {
  title: "Waveform",
  description: "Local-first music player for your library",
  applicationName: "Waveform",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Waveform",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
    shortcut: [{ url: "/favicon.ico", sizes: "48x48" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(max-width: 1023px)", color: "#121212" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const leftSidebarCollapsed =
    cookieStore.get("wf_left_sidebar_collapsed")?.value === "1";

  return (
    <html lang="en">
      <body
        suppressHydrationWarning
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
        style={{
          ["--wf-left-sidebar-width" as string]: leftSidebarCollapsed ? "4rem" : "16rem",
        }}
      >
        <Providers>
          <PwaRegister />
          <InstallPrompt />
          <header className="fixed top-0 inset-x-0 z-50 border-b border-black/10 dark:border-white/10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85 pt-[env(safe-area-inset-top)]">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
              <Link href="/" className="font-semibold inline-flex items-center gap-2 touch-manipulation">
                <Image
                  src="/apple-icon.png"
                  alt="Waveform"
                  width={24}
                  height={24}
                  className="h-6 w-6 rounded-md lg:hidden"
                  priority
                />
                <Image
                  src="/waveform.svg"
                  alt="Waveform"
                  width={24}
                  height={24}
                  className="h-6 w-6 hidden lg:block"
                  priority
                />
                <span className="hidden sm:inline">Waveform</span>
              </Link>
              <nav className="hidden lg:flex items-center gap-6">
                <Link href="/" className="opacity-80 hover:opacity-100">Home</Link>
                <Link href="/search" className="opacity-80 hover:opacity-100">Search</Link>
                <Link href="/library" className="opacity-80 hover:opacity-100">Library</Link>
                <Link href="/upload" className="opacity-80 hover:opacity-100">Upload</Link>
                <AuthButtons />
              </nav>
              <div className="lg:hidden">
                <AuthButtons />
              </div>
            </div>
          </header>
          <LibrarySidebar initialCollapsed={leftSidebarCollapsed} />
          <NowPlayingSidebar />
          <main className="wf-main pt-[calc(3.5rem+env(safe-area-inset-top))]">{children}</main>
          <PlayerBar />
          <MobileNav />
        </Providers>
      </body>
    </html>
  );
}
