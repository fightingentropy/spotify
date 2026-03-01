import type { Metadata } from "next";
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

export const runtime = "nodejs";

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
  description: "Waveform — minimal music player",
  icons: {
    icon: "/waveform.svg?v=2",
  },
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
          ["--wf-left-sidebar-width" as any]: leftSidebarCollapsed ? "4rem" : "16rem",
        }}
      >
        <Providers>
          <header className="fixed top-0 inset-x-0 z-50 border-b border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
              <Link href="/" className="font-semibold inline-flex items-center gap-2">
                <Image src="/waveform.svg" alt="Waveform" width={24} height={24} className="h-6 w-6" priority />
                <span>Waveform</span>
              </Link>
              <nav className="flex items-center gap-6">
                <Link href="/" className="opacity-80 hover:opacity-100">Home</Link>
                <Link href="/upload" className="opacity-80 hover:opacity-100">Upload</Link>
                <AuthButtons />
              </nav>
            </div>
          </header>
          <LibrarySidebar initialCollapsed={leftSidebarCollapsed} />
          <NowPlayingSidebar />
          <main className="wf-main pt-14">{children}</main>
          <PlayerBar />
        </Providers>
      </body>
    </html>
  );
}
