import { Link, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/client/auth";
import { AuthButtons } from "@/components/AuthButtons";
import { BrowserLocalLibraryHydrator } from "@/components/BrowserLocalLibraryHydrator";
import InstallPrompt from "@/components/InstallPrompt";
import LibrarySidebarClient from "@/components/LibrarySidebarClient";
import MobileNav from "@/components/MobileNav";
import NowPlayingSidebar from "@/components/NowPlayingSidebar";
import { PlayerBar } from "@/components/PlayerBar";
import PwaRegister from "@/components/PwaRegister";
import { SpotifyIcon } from "@/components/icons/SpotifyIcon";
import HomePage from "@/client/pages/HomePage";
import SearchPage from "@/client/pages/SearchPage";
import LibraryPage from "@/client/pages/LibraryPage";
import LikedPage from "@/client/pages/LikedPage";
import PlaylistPage from "@/client/pages/PlaylistPage";
import UploadPage from "@/client/pages/UploadPage";
import SettingsPage from "@/client/pages/SettingsPage";
import SignInPage from "@/client/pages/SignInPage";
import RegisterPage from "@/client/pages/RegisterPage";
import { useApiData, type LibraryPayload } from "@/client/api";

function Shell() {
  const { data: library } = useApiData<LibraryPayload>("/api/library", {
    playlists: [],
    userId: null,
  });

  return (
    <>
      <PwaRegister />
      <InstallPrompt />
      <header className="fixed top-0 inset-x-0 z-50 border-b border-black/10 dark:border-white/10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85 pt-[env(safe-area-inset-top)]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <Link to="/" className="font-semibold inline-flex items-center gap-2 touch-manipulation">
            <SpotifyIcon size={24} className="h-6 w-6 rounded-md" />
            <span className="hidden sm:inline">Spotify</span>
          </Link>
          <nav className="hidden lg:flex items-center gap-6">
            <Link to="/" className="opacity-80 hover:opacity-100">Home</Link>
            <Link to="/search" className="opacity-80 hover:opacity-100">Search</Link>
            <Link to="/library" className="opacity-80 hover:opacity-100">Library</Link>
            <Link to="/upload" className="opacity-80 hover:opacity-100">Upload</Link>
            <AuthButtons />
          </nav>
          <div className="lg:hidden">
            <AuthButtons />
          </div>
        </div>
      </header>
      <LibrarySidebarClient
        userId={library.userId}
        playlists={library.playlists}
        initialCollapsed={localStorage.getItem("spotify_left_sidebar_collapsed") === "1"}
      />
      <NowPlayingSidebar />
      <main className="wf-main pt-[calc(3.5rem+env(safe-area-inset-top))]">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/liked" element={<LikedPage />} />
          <Route path="/playlist/:id" element={<PlaylistPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/signin" element={<SignInPage />} />
          <Route path="/register" element={<RegisterPage />} />
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
      <BrowserLocalLibraryHydrator />
      <Shell />
    </AuthProvider>
  );
}
