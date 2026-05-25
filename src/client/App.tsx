import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "@/client/auth";
import { AuthButtons } from "@/components/AuthButtons";
import InstallPrompt from "@/components/InstallPrompt";
import LibrarySidebarClient from "@/components/LibrarySidebarClient";
import MobileNav from "@/components/MobileNav";
import NowPlayingSidebar from "@/components/NowPlayingSidebar";
import { PlayerBar } from "@/components/PlayerBar";
import PwaRegister from "@/components/PwaRegister";
import { SpotifyIcon } from "@/components/icons/SpotifyIcon";
import HomePage from "@/client/pages/HomePage";
import { useApiData, type LibraryPayload } from "@/client/api";

const loadSearchPage = () => import("@/client/pages/SearchPage");
const loadLibraryPage = () => import("@/client/pages/LibraryPage");
const loadLikedPage = () => import("@/client/pages/LikedPage");
const loadPlaylistPage = () => import("@/client/pages/PlaylistPage");
const loadUploadPage = () => import("@/client/pages/UploadPage");
const loadSettingsPage = () => import("@/client/pages/SettingsPage");
const loadProfilePage = () => import("@/client/pages/ProfilePage");
const loadSignInPage = () => import("@/client/pages/SignInPage");
const loadRegisterPage = () => import("@/client/pages/RegisterPage");

const SearchPage = lazy(loadSearchPage);
const LibraryPage = lazy(loadLibraryPage);
const LikedPage = lazy(loadLikedPage);
const PlaylistPage = lazy(loadPlaylistPage);
const UploadPage = lazy(loadUploadPage);
const SettingsPage = lazy(loadSettingsPage);
const ProfilePage = lazy(loadProfilePage);
const SignInPage = lazy(loadSignInPage);
const RegisterPage = lazy(loadRegisterPage);

function RouteLoading({ label = "Loading..." }: { label?: string }) {
  return (
    <div className="min-h-[calc(100dvh-3.5rem)] px-4 py-8 text-white/[0.7] sm:px-6">
      {label}
    </div>
  );
}

function lazyRoute(element: ReactNode, label?: string) {
  return <Suspense fallback={<RouteLoading label={label} />}>{element}</Suspense>;
}

function useIdleRoutePrefetch(status: "loading" | "authenticated" | "unauthenticated") {
  useEffect(() => {
    const prefetch = () => {
      void loadSearchPage();
      void loadLibraryPage();
      void loadLikedPage();
      void loadProfilePage();
      void loadSettingsPage();
      if (status === "unauthenticated") {
        void loadSignInPage();
        void loadRegisterPage();
      }
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const id = idleWindow.requestIdleCallback(prefetch, { timeout: 5_000 });
      return () => idleWindow.cancelIdleCallback?.(id);
    }

    const id = window.setTimeout(prefetch, 2_000);
    return () => window.clearTimeout(id);
  }, [status]);
}

function Shell() {
  const { user, status } = useAuth();
  const { data: library } = useApiData<LibraryPayload>(
    `/api/library?auth=${encodeURIComponent(user?.id ?? status)}`,
    {
      playlists: [],
      userId: null,
    },
  );
  useIdleRoutePrefetch(status);

  return (
    <>
      <PwaRegister />
      <InstallPrompt />
      <header className="fixed top-0 inset-x-0 z-50 border-b border-white/[0.12] bg-background text-white pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 w-screen max-w-none min-w-0 items-center justify-between px-4 sm:px-6 lg:max-w-7xl">
          <Link to="/" className="font-semibold inline-flex shrink-0 items-center gap-2 touch-manipulation">
            <SpotifyIcon size={24} className="h-6 w-6 rounded-md" />
            <span className="hidden sm:inline">Spotify</span>
          </Link>
          <nav className="hidden lg:flex items-center gap-6">
            <Link to="/" className="text-white/[0.68] transition hover:text-white">Home</Link>
            <Link to="/search" className="text-white/[0.68] transition hover:text-white">Search</Link>
            <Link to="/library" className="text-white/[0.68] transition hover:text-white">Library</Link>
            <Link to="/upload" className="text-white/[0.68] transition hover:text-white">Upload</Link>
            <AuthButtons />
          </nav>
          <div className="ml-auto flex min-w-0 justify-end overflow-hidden lg:hidden">
            <AuthButtons compact />
          </div>
        </div>
      </header>
      <LibrarySidebarClient
        userId={status === "loading" ? library.userId : user?.id ?? null}
        playlists={library.playlists}
        initialCollapsed={localStorage.getItem("spotify_left_sidebar_collapsed") === "1"}
      />
      <NowPlayingSidebar />
      <main className="wf-main pt-[calc(3.5rem+env(safe-area-inset-top))]">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={lazyRoute(<SearchPage />, "Loading search...")} />
          <Route path="/library" element={lazyRoute(<LibraryPage />, "Loading library...")} />
          <Route path="/liked" element={lazyRoute(<LikedPage />, "Loading liked songs...")} />
          <Route path="/playlist/:id" element={lazyRoute(<PlaylistPage />, "Loading playlist...")} />
          <Route path="/upload" element={lazyRoute(<UploadPage />, "Loading upload...")} />
          <Route path="/settings" element={lazyRoute(<SettingsPage />, "Loading settings...")} />
          <Route path="/profile" element={lazyRoute(<ProfilePage />, "Loading profile...")} />
          <Route path="/signin" element={lazyRoute(<SignInPage />, "Loading sign in...")} />
          <Route path="/register" element={lazyRoute(<RegisterPage />, "Loading registration...")} />
          <Route
            path="*"
            element={
              <div className="px-4 sm:px-6 py-10 max-w-3xl mx-auto">
                <h1 className="text-2xl font-semibold mb-2">Not found</h1>
                <Link to="/" className="underline">Back home</Link>
              </div>
            }
          />
        </Routes>
      </main>
      <PlayerBar />
      <MobileNav />
    </>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
