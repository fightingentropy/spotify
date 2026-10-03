import { Component, lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import { ChevronLeft } from "lucide-react";
import { AuthProvider, useAuth } from "@/client/auth";
import { AuthButtons } from "@/components/AuthButtons";
import EmailVerificationBanner from "@/components/EmailVerificationBanner";
import { HomeSearchCommandPalette } from "@/components/HomeSearchCommandPalette";
import LibrarySidebarClient from "@/components/LibrarySidebarClient";
import MobileNav from "@/components/MobileNav";
import NowPlayingSidebar from "@/components/NowPlayingSidebar";
import { PlayerBar } from "@/components/PlayerBar";
import { LikeFeedback } from "@/components/LikeFeedback";
import { DiscoverQueueStager } from "@/client/DiscoverQueueStager";
import LegacyServiceWorkerCleanup from "@/components/LegacyServiceWorkerCleanup";
import { PageHeader, PageLayout } from "@/components/PageLayout";
import HomePage from "@/client/pages/HomePage";
import { usePlayerStore } from "@/store/player";

const loadSearchPage = () => import("@/client/pages/SearchPage");
const loadLibraryPage = () => import("@/client/pages/LibraryPage");
const loadSongsPage = () => import("@/client/pages/SongsPage");
const loadLikedPage = () => import("@/client/pages/LikedPage");
const loadLyricsPage = () => import("@/client/pages/LyricsPage");
const loadRadioPage = () => import("@/client/pages/RadioPage");
const loadPodcastsPage = () => import("@/client/pages/PodcastsPage");
const loadEventsPage = () => import("@/client/pages/EventsPage");
const loadPlaylistPage = () => import("@/client/pages/PlaylistPage");
const loadAlbumPage = () => import("@/client/pages/AlbumPage");
const AlbumPage = lazy(loadAlbumPage);
const loadProfilePage = () => import("@/client/pages/ProfilePage");
const ProfilePage = lazy(loadProfilePage);
const loadUploadPage = () => import("@/client/pages/UploadPage");
const loadSettingsPage = () => import("@/client/pages/SettingsPage");
const loadListeningStatsPage = () => import("@/client/pages/ListeningStatsPage");
const loadSignInPage = () => import("@/client/pages/SignInPage");
type RoutePrefetcher = () => Promise<unknown>;
const ROUTE_PREFETCHERS: Record<string, RoutePrefetcher> = {
  "/search": loadSearchPage,
  "/library": loadLibraryPage,
  "/playlists": loadLibraryPage,
  "/songs": loadSongsPage,
  "/liked": loadLikedPage,
  "/radio": loadRadioPage,
  "/podcasts": loadPodcastsPage,
  "/events": loadEventsPage,
  "/upload": loadUploadPage,
  "/settings": loadSettingsPage,
  "/listening-stats": loadListeningStatsPage,
  "/profile": loadProfilePage,
  "/signin": loadSignInPage,
};
const prefetchedRouteModules = new Set<RoutePrefetcher>();

const SearchPage = lazy(loadSearchPage);
const LibraryPage = lazy(loadLibraryPage);
const SongsPage = lazy(loadSongsPage);
const LikedPage = lazy(loadLikedPage);
const LyricsPage = lazy(loadLyricsPage);
const RadioPage = lazy(loadRadioPage);
const PodcastsPage = lazy(loadPodcastsPage);
const EventsPage = lazy(loadEventsPage);
const PlaylistPage = lazy(loadPlaylistPage);
const UploadPage = lazy(loadUploadPage);
const SettingsPage = lazy(loadSettingsPage);
const ListeningStatsPage = lazy(loadListeningStatsPage);
const SignInPage = lazy(loadSignInPage);

function RouteLoading({ label = "Loading..." }: { label?: string }) {
  return (
    <PageLayout>
      <div>
        <div className="mb-6 text-sm">{label}</div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {[0, 1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="space-y-3">
              <div className="wf-skeleton aspect-square rounded-lg" />
              <div className="wf-skeleton h-4 rounded-full" />
              <div className="wf-skeleton h-3 w-2/3 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </PageLayout>
  );
}

function RouteUnavailable() {
  return (
    <PageLayout>
      <PageHeader title="Something went wrong" />
      <p className="mt-2 max-w-md text-sm text-white/[0.62]">
        This page failed to load. Try reloading, or come back in a moment.
      </p>
    </PageLayout>
  );
}

class RouteErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Route failed to render", error);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function lazyRoute(element: ReactNode, label?: string) {
  return (
    <RouteErrorBoundary fallback={<RouteUnavailable />}>
      <Suspense fallback={<RouteLoading label={label} />}>{element}</Suspense>
    </RouteErrorBoundary>
  );
}

function shouldSkipRoutePrefetch(): boolean {
  if (navigator.onLine === false) return true;
  const connection = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  return Boolean(
    connection?.saveData ||
      connection?.effectiveType === "slow-2g" ||
      connection?.effectiveType === "2g",
  );
}

// Warm the page the user is heading towards instead of downloading every
// route (including uploads and sign-in) during the initial artwork requests.
function useIntentRoutePrefetch() {
  useEffect(() => {
    const prefetch = (event: Event) => {
      if (shouldSkipRoutePrefetch() || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.origin !== location.origin) return;
      const path = link.pathname;
      const load = ROUTE_PREFETCHERS[path]
        ?? (path.startsWith("/playlist/") ? loadPlaylistPage : undefined)
        ?? (path.startsWith("/search/album/") ? loadAlbumPage : undefined);
      if (!load || prefetchedRouteModules.has(load)) return;
      prefetchedRouteModules.add(load);
      void load().catch(() => prefetchedRouteModules.delete(load));
    };
    document.addEventListener("pointerover", prefetch, { passive: true });
    document.addEventListener("focusin", prefetch);
    document.addEventListener("touchstart", prefetch, { passive: true });
    return () => {
      document.removeEventListener("pointerover", prefetch);
      document.removeEventListener("focusin", prefetch);
      document.removeEventListener("touchstart", prefetch);
    };
  }, []);
}

const AUTH_PUBLIC_PATHS = new Set(["/signin"]);

function ResponsiveLibraryRoute() {
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 1024px)").matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktopQuery = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(desktopQuery.matches);
    update();
    desktopQuery.addEventListener("change", update);
    return () => desktopQuery.removeEventListener("change", update);
  }, []);

  return isDesktop ? <Navigate to="/playlists" replace /> : <LibraryPage />;
}

const MOBILE_STACK_ROUTES = [
  { match: (path: string) => path.startsWith("/playlist/"), label: "Playlist", fallback: "/library" },
  { match: (path: string) => path === "/liked", label: "Liked Songs", fallback: "/library" },
  { match: (path: string) => path === "/songs", label: "All Songs", fallback: "/library" },
  { match: (path: string) => path === "/radio", label: "Radio", fallback: "/library" },
  { match: (path: string) => path === "/podcasts", label: "Podcasts", fallback: "/library" },
  { match: (path: string) => path === "/events", label: "Live events", fallback: "/library" },
  { match: (path: string) => path === "/upload", label: "Add music", fallback: "/library" },
  { match: (path: string) => path === "/settings", label: "Settings", fallback: "/" },
  { match: (path: string) => path === "/listening-stats", label: "Listening stats", fallback: "/profile" },
  { match: (path: string) => path === "/profile", label: "Profile", fallback: "/" },
] as const;

function MobileStackHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const route = MOBILE_STACK_ROUTES.find(({ match }) => match(location.pathname));

  if (!route) return null;

  return (
    <div className="sticky top-0 z-30 grid h-11 grid-cols-[44px_minmax(0,1fr)_44px] items-center border-b border-white/[0.06] bg-black px-1 text-white lg:hidden">
      <button
        type="button"
        aria-label="Back"
        onClick={() => {
          if (location.key === "default") {
            navigate(route.fallback, { replace: true });
            return;
          }
          navigate(-1);
        }}
        className="wf-control-button grid h-11 w-11 place-items-center rounded-full text-[#f2f2f2] active:bg-white/[0.06]"
      >
        <ChevronLeft size={26} strokeWidth={2.1} />
      </button>
      <div className="truncate text-center text-[15px] font-semibold text-[#f2f2f2]">{route.label}</div>
      <div aria-hidden className="h-11 w-11" />
    </div>
  );
}

function Shell() {
  const { user, status } = useAuth();
  const location = useLocation();
  const currentSong = usePlayerStore((state) => state.currentSong);
  const [initialSidebarCollapsed] = useState(
    () => localStorage.getItem("spotify_left_sidebar_collapsed") === "1",
  );
  const isAuthPublicPath = AUTH_PUBLIC_PATHS.has(location.pathname);
  useIntentRoutePrefetch();
  useLayoutEffect(() => {
    document.querySelector(".wf-main")?.scrollTo(0, 0);
  }, [location.pathname, location.search]);
  useEffect(() => {
    document.body.classList.toggle("wf-has-mobile-player", Boolean(currentSong));
    return () => {
      document.body.classList.remove("wf-has-mobile-player");
    };
  }, [currentSong]);
  if (status === "loading") {
    return (
      <div className="min-h-dvh bg-background px-4 py-16 text-center text-white/[0.7]">
        Checking session...
      </div>
    );
  }

  if (!user && !isAuthPublicPath) {
    return (
      <Navigate to="/signin" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }

  if (user && isAuthPublicPath) {
    return <Navigate to="/" replace />;
  }

  if (!user) {
    return (
      <main className="wf-main wf-main-auth min-h-dvh bg-background pt-[env(safe-area-inset-top)]">
        <div key={location.pathname} className="wf-route-surface">
          <Routes location={location}>
            <Route path="/signin" element={lazyRoute(<SignInPage />, "Loading sign in...")} />
          </Routes>
        </div>
      </main>
    );
  }

  return (
    <>
      <LegacyServiceWorkerCleanup />
      <header className="wf-app-header fixed top-0 inset-x-0 z-50 hidden border-b border-white/[0.08] bg-black text-white pt-[env(safe-area-inset-top)] lg:block">
        <div className="mx-auto flex h-14 w-screen max-w-none min-w-0 items-center justify-between px-4 sm:px-6 lg:grid lg:max-w-7xl lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          {/* Keep the desktop logo aligned with the Library heading's inset. */}
          <Link
            to="/"
            className="font-semibold inline-flex shrink-0 items-center touch-manipulation lg:absolute lg:left-6 lg:top-1/2 lg:-translate-y-1/2"
          >
            <img src="/icon.svg" alt="Music" width={40} height={40} className="h-10 w-10 lg:h-7 lg:w-7" />
          </Link>
          <HomeSearchCommandPalette
            className="hidden w-[22rem] lg:col-start-2 lg:block lg:justify-self-center xl:w-[30rem]"
          />
          <nav className="hidden lg:col-start-3 lg:flex items-center gap-4 xl:gap-6 lg:justify-self-end">
            <Link to="/" className="text-white/[0.68] transition hover:text-white">Home</Link>
            <Link to="/upload" className="text-white/[0.68] transition hover:text-white">Upload</Link>
            <AuthButtons />
          </nav>
          <div className="ml-auto flex min-w-0 justify-end overflow-hidden lg:hidden">
            <AuthButtons compact />
          </div>
        </div>
      </header>
      <LibrarySidebarClient initialCollapsed={initialSidebarCollapsed} />
      <NowPlayingSidebar />
      <main className={`wf-main bg-background${location.pathname === "/lyrics" ? " wf-main-lyrics" : ""}`}>
        <MobileStackHeader />
        <EmailVerificationBanner />
        <div key={location.pathname} className="wf-route-surface">
        <Routes location={location}>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={lazyRoute(<SearchPage />, "Loading search...")} />
          <Route
            path="/library"
            element={lazyRoute(<ResponsiveLibraryRoute />, "Loading library...")}
          />
          <Route
            path="/playlists"
            element={lazyRoute(<LibraryPage playlistOnly />, "Loading playlists...")}
          />
          <Route path="/songs" element={lazyRoute(<SongsPage />, "Loading songs...")} />
          <Route path="/liked" element={lazyRoute(<LikedPage />, "Loading liked songs...")} />
          <Route path="/lyrics" element={lazyRoute(<LyricsPage />, "Loading lyrics...")} />
          <Route path="/radio" element={lazyRoute(<RadioPage />, "Loading radio stations...")} />
          <Route path="/podcasts" element={lazyRoute(<PodcastsPage />, "Loading podcasts...")} />
          <Route path="/events" element={lazyRoute(<EventsPage />, "Loading events...")} />
          <Route path="/playlist/:id" element={lazyRoute(<PlaylistPage />, "Loading playlist...")} />
          <Route path="/search/album/:source/:id" element={lazyRoute(<AlbumPage />, "Loading album...")} />
          <Route path="/upload" element={lazyRoute(<UploadPage />, "Loading upload...")} />
          <Route path="/settings" element={lazyRoute(<SettingsPage />, "Loading settings...")} />
          <Route
            path="/listening-stats"
            element={lazyRoute(<ListeningStatsPage />, "Loading listening stats...")}
          />
          <Route path="/profile" element={lazyRoute(<ProfilePage />, "Loading profile...")} />
          <Route path="/signin" element={lazyRoute(<SignInPage />, "Loading sign in...")} />
          <Route path="/register" element={<Navigate to="/signin" replace />} />
          <Route
            path="*"
            element={
              <PageLayout>
                <PageHeader title="Page not found" />
                <Link to="/" className="wf-button">Back home</Link>
              </PageLayout>
            }
          />
        </Routes>
        </div>
      </main>
      <PlayerBar />
      <LikeFeedback />
      <DiscoverQueueStager />
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
