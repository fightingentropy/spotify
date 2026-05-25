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
import SearchPage from "@/client/pages/SearchPage";
import LibraryPage from "@/client/pages/LibraryPage";
import LikedPage from "@/client/pages/LikedPage";
import PlaylistPage from "@/client/pages/PlaylistPage";
import UploadPage from "@/client/pages/UploadPage";
import SettingsPage from "@/client/pages/SettingsPage";
import ProfilePage from "@/client/pages/ProfilePage";
import SignInPage from "@/client/pages/SignInPage";
import RegisterPage from "@/client/pages/RegisterPage";
import { useApiData, type LibraryPayload } from "@/client/api";

function Shell() {
  const { user, status } = useAuth();
  const { data: library } = useApiData<LibraryPayload>(
    `/api/library?auth=${encodeURIComponent(user?.id ?? status)}`,
    {
      playlists: [],
      userId: null,
    },
  );

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
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/liked" element={<LikedPage />} />
          <Route path="/playlist/:id" element={<PlaylistPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
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
      <Shell />
    </AuthProvider>
  );
}
