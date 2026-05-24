"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { CheckCircle2, Download, Loader2, Pause, Play, XCircle } from "lucide-react";
import { useAuth } from "@/client/auth";
import {
  DOWNLOAD_PROVIDER_KEY,
  DOWNLOAD_QUALITY_PROFILE_KEY,
  isDownloadProvider,
  type DownloadProvider,
} from "@/components/DownloadQualitySettings";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

type SpotifyTrack = {
  spotifyId: string;
  title: string;
  artist: string;
  album: string;
  releaseDate: string;
  totalPlays: number;
  durationMs: number;
  imageUrl: string;
  previewUrl: string;
};

type ActionStatus = "idle" | "loading" | "success" | "error";
type QualityProfile = "cd" | "hires48" | "max";
type PendingImportPayload = { lyricsToInclude: string };

function formatDuration(durationMs: number): string {
  if (!durationMs || !Number.isFinite(durationMs)) return "0:00";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatPlays(totalPlays: number): string {
  if (!totalPlays || !Number.isFinite(totalPlays)) return "N/A";
  return totalPlays.toLocaleString();
}

function ActionIcon({ status }: { status: ActionStatus }) {
  if (status === "success") return <CheckCircle2 size={16} className="text-green-500" />;
  if (status === "error") return <XCircle size={16} className="text-red-500" />;
  return null;
}

function filenameFromContentDisposition(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded).replaceAll('"', "").trim() || fallback;
    } catch {}
  }
  return value.match(/filename="([^"]+)"/i)?.[1]?.trim() || value.match(/filename=([^;]+)/i)?.[1]?.trim() || fallback;
}

function extensionFromContentType(type: string, fallback: string): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("flac")) return ".flac";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return ".mp3";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return ".m4a";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return ".jpg";
  return fallback;
}

export default function UploadPage() {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const localDirectoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const localFolderPickerKind = useBrowserLocalLibraryStore((state) => state.folderPickerKind);
  const localFolderWritable = useBrowserLocalLibraryStore((state) => state.writable);
  const localSongsCount = useBrowserLocalLibraryStore((state) => state.songs.length);
  const saveDownloadedTrack = useBrowserLocalLibraryStore((state) => state.saveDownloadedTrack);
  const [mode, setMode] = useState<"upload" | "spotify">("spotify");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [spotifyUrl, setSpotifyUrl] = useState("");
  const [region, setRegion] = useState("US");
  const [spotifyTrack, setSpotifyTrack] = useState<SpotifyTrack | null>(null);
  const [lyricsText, setLyricsText] = useState("");
  const [fetchStatus, setFetchStatus] = useState<ActionStatus>("idle");
  const [downloadStatus, setDownloadStatus] = useState<ActionStatus>("idle");
  const [qualityProfile, setQualityProfile] = useState<QualityProfile>("max");
  const [downloadProvider, setDownloadProvider] = useState<DownloadProvider>("auto");
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replaceModalMessage, setReplaceModalMessage] = useState("");
  const [pendingImportPayload, setPendingImportPayload] = useState<PendingImportPayload | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      if (previewAudioRef.current) previewAudioRef.current.currentTime = 0;
    };
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DOWNLOAD_QUALITY_PROFILE_KEY);
      if (stored === "cd" || stored === "hires48" || stored === "max") setQualityProfile(stored);
      const storedProvider = localStorage.getItem(DOWNLOAD_PROVIDER_KEY);
      if (storedProvider && isDownloadProvider(storedProvider)) setDownloadProvider(storedProvider);
    } catch {}
  }, []);

  if (status === "loading") return <div className="max-w-md mx-auto py-16 px-4">Loading...</div>;
  if (!user) {
    return (
      <div className="max-w-md mx-auto py-16 px-4">
        <p className="mb-4">You must be signed in to upload songs.</p>
        <Link className="underline" to="/signin">Sign in</Link>
      </div>
    );
  }

  async function onUploadSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title || !artist || !image || !audio) {
      setError("All upload fields are required");
      return;
    }
    setLoading(true);
    try {
      const form = new FormData();
      form.append("title", title);
      form.append("artist", artist);
      form.append("image", image);
      form.append("audio", audio);
      const res = await fetch("/api/songs", { method: "POST", body: form, credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Upload failed");
      }
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleFetchSpotify() {
    setError(null);
    setFetchStatus("loading");
    setDownloadStatus("idle");
    setSpotifyTrack(null);
    setLyricsText("");
    setShowReplaceModal(false);
    setReplaceModalMessage("");
    setPendingImportPayload(null);
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "fetch", spotifyUrl: spotifyUrl.trim(), region }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Failed to fetch Spotify track");
      setSpotifyTrack(data.track ?? null);
      setFetchStatus("success");
    } catch (err) {
      setFetchStatus("error");
      setError(err instanceof Error ? err.message : "Failed to fetch Spotify track");
    }
  }

  async function handlePreviewToggle() {
    if (!spotifyTrack) return;
    setError(null);
    if (isPreviewPlaying && previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.currentTime = 0;
      previewAudioRef.current = null;
      setIsPreviewPlaying(false);
      return;
    }
    if (!spotifyTrack.previewUrl) {
      setError("Preview not available for this track");
      return;
    }
    try {
      const audioEl = new Audio(spotifyTrack.previewUrl);
      previewAudioRef.current = audioEl;
      audioEl.addEventListener("ended", () => {
        setIsPreviewPlaying(false);
        previewAudioRef.current = null;
      });
      audioEl.addEventListener("error", () => {
        setIsPreviewPlaying(false);
        previewAudioRef.current = null;
      });
      await audioEl.play();
      setIsPreviewPlaying(true);
    } catch {
      setError("Failed to play preview");
    }
  }

  async function fetchLyricsForImport(): Promise<string> {
    if (!spotifyTrack) return "";
    if (lyricsText.trim()) return lyricsText.trim();
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: spotifyUrl.trim(),
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return "";
      const text = typeof data.lyrics === "string" ? data.lyrics.trim() : "";
      if (text) setLyricsText(text);
      return text;
    } catch {
      return "";
    }
  }

  async function submitSpotifyImport(lyricsToInclude: string, replaceExisting = false) {
    if (!spotifyTrack) return;
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: spotifyUrl.trim(),
      region,
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      album: spotifyTrack.album,
      imageUrl: spotifyTrack.imageUrl,
      qualityProfile,
    };
    if (downloadProvider !== "auto") payload.service = downloadProvider;
    if (lyricsToInclude) payload.lyricsText = lyricsToInclude;
    if (replaceExisting) payload.replaceExisting = "true";
    const res = await fetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.code === "DUPLICATE_SONG") {
      const duplicateMessage =
        typeof data?.existingSong?.title === "string" && typeof data?.existingSong?.artist === "string"
          ? `You already have "${data.existingSong.title}" by ${data.existingSong.artist}. Replace it?`
          : "You already have this song in your library. Replace it?";
      const duplicateError = new Error(duplicateMessage) as Error & { code?: string };
      duplicateError.code = "DUPLICATE_SONG";
      throw duplicateError;
    }
    if (!res.ok) throw new Error(data?.error ?? "Failed to add song from Spotify");
  }

  function shouldSaveToLocalFolder() {
    return localFolderPickerKind === "handle" && (localFolderWritable || Boolean(localDirectoryName) || localSongsCount > 0);
  }

  function hasReadOnlyPickedFolder() {
    return localFolderPickerKind !== "handle" && (Boolean(localDirectoryName) || localSongsCount > 0);
  }

  function spotifyDownloadPayload(lyricsToInclude = ""): Record<string, string> {
    if (!spotifyTrack) return {};
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: spotifyUrl.trim(),
      region,
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      album: spotifyTrack.album,
      imageUrl: spotifyTrack.imageUrl,
      qualityProfile,
    };
    if (downloadProvider !== "auto") payload.service = downloadProvider;
    if (lyricsToInclude) payload.lyricsText = lyricsToInclude;
    return payload;
  }

  async function fetchSpotifyAudioBlob(payload: Record<string, string>) {
    const res = await fetch("/api/songs/spotify/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? "Failed to download audio");
    }
    const blob = await res.blob();
    const fallback = `${spotifyTrack?.artist || "Unknown Artist"} - ${spotifyTrack?.title || "Track"}${extensionFromContentType(blob.type, ".flac")}`;
    return {
      blob,
      fileName: filenameFromContentDisposition(res.headers.get("content-disposition"), fallback),
    };
  }

  async function fetchSpotifyCoverBlob() {
    if (!spotifyTrack?.imageUrl) return null;
    const res = await fetch(
      `/api/songs/spotify/cover?url=${encodeURIComponent(spotifyTrack.imageUrl)}&filename=${encodeURIComponent(`${spotifyTrack.title} cover`)}`,
      { credentials: "include" },
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    return {
      blob,
      fileName: filenameFromContentDisposition(
        res.headers.get("content-disposition"),
        `cover${extensionFromContentType(blob.type, ".jpg")}`,
      ),
    };
  }

  async function saveSpotifyImportToLocalFolder(lyricsToInclude: string) {
    if (!spotifyTrack) return;
    const payload = spotifyDownloadPayload(lyricsToInclude);
    const [audio, cover] = await Promise.all([
      fetchSpotifyAudioBlob(payload),
      fetchSpotifyCoverBlob().catch(() => null),
    ]);
    await saveDownloadedTrack({
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      audioBlob: audio.blob,
      audioFileName: audio.fileName,
      coverBlob: cover?.blob ?? null,
      coverFileName: cover?.fileName,
      lyricsText: lyricsToInclude,
    });
  }

  function isDuplicateSongError(errorValue: unknown): errorValue is Error & { code: string } {
    return errorValue instanceof Error && (errorValue as Error & { code?: string }).code === "DUPLICATE_SONG";
  }

  async function handleConfirmReplaceSong() {
    if (!pendingImportPayload) return;
    setShowReplaceModal(false);
    setDownloadStatus("loading");
    setError(null);
    try {
      await submitSpotifyImport(pendingImportPayload.lyricsToInclude, true);
      setPendingImportPayload(null);
      setDownloadStatus("success");
      navigate("/");
    } catch (err) {
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to replace existing song");
    }
  }

  async function handleAddFromSpotify() {
    if (!spotifyTrack) {
      setError("Fetch a Spotify track first");
      return;
    }
    setError(null);
    setDownloadStatus("loading");
    let resolvedLyrics = "";
    try {
      resolvedLyrics = await fetchLyricsForImport();
      if (shouldSaveToLocalFolder()) {
        await saveSpotifyImportToLocalFolder(resolvedLyrics);
      } else if (hasReadOnlyPickedFolder()) {
        throw new Error("This browser only gave read access to the selected folder. Use a desktop browser with folder write access to save downloads there.");
      } else {
        await submitSpotifyImport(resolvedLyrics);
      }
      setDownloadStatus("success");
      navigate("/");
    } catch (err) {
      if (isDuplicateSongError(err)) {
        setPendingImportPayload({ lyricsToInclude: resolvedLyrics || lyricsText.trim() });
        setReplaceModalMessage(err.message);
        setShowReplaceModal(true);
        setDownloadStatus("idle");
        return;
      }
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to add song from Spotify");
    }
  }

  return (
    <div className="max-w-5xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-semibold mb-6">Add a song</h1>
      <div className="mb-8 inline-flex rounded-2xl border border-white/25 bg-white/[0.02] p-1.5">
        <button type="button" onClick={() => { setError(null); setMode("spotify"); }} className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${mode === "spotify" ? "bg-foreground text-background" : "text-foreground/80 hover:text-foreground"}`}>
          Spotify link
        </button>
        <button type="button" onClick={() => { setError(null); setMode("upload"); }} className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${mode === "upload" ? "bg-foreground text-background" : "text-foreground/80 hover:text-foreground"}`}>
          Upload files
        </button>
      </div>

      {mode === "upload" ? (
        <form onSubmit={onUploadSubmit} className="max-w-2xl rounded-3xl border border-white/20 bg-white/[0.02] p-6 md:p-7 space-y-5">
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className="block text-sm mb-2 text-foreground/80">Title</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" required />
            </div>
            <div>
              <label className="block text-sm mb-2 text-foreground/80">Artist</label>
              <input value={artist} onChange={(e) => setArtist(e.target.value)} className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" required />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer hover:border-yellow-500/60 transition-colors">
              <span className="block text-sm font-medium">Cover image</span>
              <span className="block text-xs text-foreground/60 mt-1">JPG, PNG, WEBP</span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">{image ? image.name : "Choose image file"}</span>
              <input type="file" accept="image/*" onChange={(e) => setImage(e.target.files?.[0] ?? null)} className="hidden" />
            </label>
            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer hover:border-yellow-500/60 transition-colors">
              <span className="block text-sm font-medium">Audio file</span>
              <span className="block text-xs text-foreground/60 mt-1">FLAC, MP3, WAV</span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">{audio ? audio.name : "Choose audio file"}</span>
              <input type="file" accept="audio/*" onChange={(e) => setAudio(e.target.files?.[0] ?? null)} className="hidden" />
            </label>
          </div>
          {error && <div className="text-sm text-red-500">{error}</div>}
          <button type="submit" disabled={loading} className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center gap-2">
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? "Uploading..." : "Upload Song"}
          </button>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row gap-3">
            <input value={spotifyUrl} onChange={(e) => setSpotifyUrl(e.target.value)} className="flex-1 border border-white/25 rounded-2xl px-4 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" placeholder="https://open.spotify.com/track/..." />
            <select value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} className="w-full md:w-24 border border-white/25 rounded-2xl px-3 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50">
              <option value="US">US</option>
              <option value="GB">GB</option>
              <option value="DE">DE</option>
              <option value="FR">FR</option>
              <option value="ES">ES</option>
              <option value="IT">IT</option>
            </select>
            <button type="button" onClick={handleFetchSpotify} disabled={fetchStatus === "loading" || !spotifyUrl.trim()} className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-medium disabled:opacity-50 inline-flex items-center gap-2">
              {fetchStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              Fetch
            </button>
          </div>

          {spotifyTrack && (
            <div className="rounded-3xl border p-5 bg-black/[0.03] dark:bg-white/[0.03]">
              <div className="flex flex-col lg:flex-row gap-6">
                <div className="shrink-0">
                  {spotifyTrack.imageUrl ? (
                    <div className="relative w-56 h-56 rounded-2xl overflow-hidden bg-black/10">
                      <img src={spotifyTrack.imageUrl} alt={spotifyTrack.title} className="w-full h-full object-cover" />
                      <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-0.5 rounded-lg">{formatDuration(spotifyTrack.durationMs)}</div>
                    </div>
                  ) : (
                    <div className="w-56 h-56 rounded-2xl bg-black/10 grid place-items-center text-sm opacity-70">No Cover</div>
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-4">
                  <div>
                    <h2 className="text-4xl font-bold leading-tight break-words">{spotifyTrack.title}</h2>
                    <p className="text-2xl text-foreground/70 mt-1">{spotifyTrack.artist}</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div><div className="text-foreground/60">Album</div><div className="font-medium">{spotifyTrack.album || "N/A"}</div></div>
                    <div><div className="text-foreground/60">Release Date</div><div className="font-medium">{spotifyTrack.releaseDate || "N/A"}</div></div>
                    <div><div className="text-foreground/60">Total Plays</div><div className="font-medium">{formatPlays(spotifyTrack.totalPlays)}</div></div>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button type="button" onClick={handleAddFromSpotify} disabled={downloadStatus === "loading"} className="h-11 flex-1 justify-center rounded-2xl bg-yellow-500 px-5 text-black font-semibold inline-flex items-center gap-2 disabled:opacity-50 sm:flex-none">
                      {downloadStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                      Download
                      <ActionIcon status={downloadStatus} />
                    </button>
                    {spotifyTrack.previewUrl && (
                      <button type="button" onClick={handlePreviewToggle} className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center" aria-label={isPreviewPlaying ? "Stop preview" : "Play preview"}>
                        {isPreviewPlaying ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {showReplaceModal && (
            <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4">
              <div className="w-full max-w-md rounded-2xl border border-white/20 bg-zinc-950 p-5 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Song already exists</h3>
                  <p className="text-sm text-zinc-300 mt-1">{replaceModalMessage || "This song is already in your library."}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setShowReplaceModal(false); setPendingImportPayload(null); setDownloadStatus("idle"); }} className="h-10 px-4 rounded border border-white/30">Keep Existing</button>
                  <button type="button" onClick={handleConfirmReplaceSong} className="h-10 px-4 rounded bg-yellow-500 text-black font-medium inline-flex items-center gap-2">Replace Song</button>
                </div>
              </div>
            </div>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
      )}
    </div>
  );
}
