"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Download,
  FileText,
  FolderDown,
  Globe,
  ImageDown,
  Loader2,
  Pause,
  Play,
  XCircle,
} from "lucide-react";
import {
  DOWNLOAD_PROVIDER_KEY,
  DOWNLOAD_QUALITY_PROFILE_KEY,
  isDownloadProvider,
  type DownloadProvider,
} from "@/components/DownloadQualitySettings";
import {
  useBrowserLocalLibraryStore,
} from "@/store/browser-local-library";

type SpotifyAvailability = {
  tidal: boolean;
  qobuz: boolean;
  amazon: boolean;
  tidalUrl?: string;
  qobuzUrl?: string;
  amazonUrl?: string;
};

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
type MissingAssetChoice = "ignore" | "upload";
type QualityProfile = "cd" | "hires48" | "max";
type PendingImportPayload = {
  lyricsToInclude: string;
  customCover: File | null;
  customLyrics: File | null;
};

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

function filenameFromContentDisposition(header: string | null): string {
  if (!header) return "";
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const match = header.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? "";
}

function ActionIcon({ status }: { status: ActionStatus }) {
  if (status === "loading") {
    return <Loader2 size={16} className="animate-spin" />;
  }
  if (status === "success") {
    return <CheckCircle2 size={16} className="text-green-500" />;
  }
  if (status === "error") {
    return <XCircle size={16} className="text-red-500" />;
  }
  return null;
}

function LogoSlot({ children }: { children: ReactNode }) {
  return <div className="h-8 w-8 grid place-items-center">{children}</div>;
}

function TidalLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-emerald-500" fill="currentColor" aria-hidden>
      <path d="M12 2l3 3-3 3-3-3 3-3Z" />
      <path d="M6 8l3 3-3 3-3-3 3-3Z" />
      <path d="M12 8l3 3-3 3-3-3 3-3Z" />
      <path d="M18 8l3 3-3 3-3-3 3-3Z" />
    </svg>
  );
}

function QobuzLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-red-500" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="11" cy="11" r="1.9" fill="currentColor" />
      <path
        d="M15.8 15.8L20 20"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AmazonMusicLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6 text-emerald-500" fill="none" aria-hidden>
      <path
        d="M4.2 17c3.8 2.3 11.8 2.3 15.6 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M18.5 15.8l2.1 1.2-2.4.3"
        fill="currentColor"
      />
      <path
        d="M9.4 5.2v6.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M9.4 5.2c2.1-.1 4.2-.6 6.2-1.6v6.9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="7.1" cy="12.8" r="1.6" fill="currentColor" />
      <circle cx="15.6" cy="11.3" r="1.4" fill="currentColor" />
    </svg>
  );
}

function AvailabilityLogos({ availability }: { availability: SpotifyAvailability }) {
  const availableLogos: ReactNode[] = [];
  if (availability.tidal) {
    availableLogos.push(
      <LogoSlot key="tidal">
        <TidalLogo />
      </LogoSlot>,
    );
  }
  if (availability.qobuz) {
    availableLogos.push(
      <LogoSlot key="qobuz">
        <QobuzLogo />
      </LogoSlot>,
    );
  }
  if (availability.amazon) {
    availableLogos.push(
      <LogoSlot key="amazon">
        <AmazonMusicLogo />
      </LogoSlot>,
    );
  }

  if (availableLogos.length === 0) {
    return <div className="text-xs text-foreground/70">No providers available</div>;
  }

  return (
    <div className="flex items-center justify-center gap-4">
      {availableLogos}
    </div>
  );
}

export default function UploadPage() {
  const { data: session, status } = useSession();
  const router = useRouter();

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
  const [availability, setAvailability] = useState<SpotifyAvailability | null>(null);
  const [lyricsText, setLyricsText] = useState("");

  const [fetchStatus, setFetchStatus] = useState<ActionStatus>("idle");
  const [previewStatus, setPreviewStatus] = useState<ActionStatus>("idle");
  const [lyricsStatus, setLyricsStatus] = useState<ActionStatus>("idle");
  const [coverStatus, setCoverStatus] = useState<ActionStatus>("idle");
  const [availabilityStatus, setAvailabilityStatus] = useState<ActionStatus>("idle");
  const [downloadStatus, setDownloadStatus] = useState<ActionStatus>("idle");
  const [localSaveStatus, setLocalSaveStatus] = useState<ActionStatus>("idle");
  const [qualityProfile, setQualityProfile] = useState<QualityProfile>("max");
  const [downloadProvider, setDownloadProvider] = useState<DownloadProvider>("auto");
  const [showMissingAssetsModal, setShowMissingAssetsModal] = useState(false);
  const [missingCover, setMissingCover] = useState(false);
  const [missingLyrics, setMissingLyrics] = useState(false);
  const [coverChoice, setCoverChoice] = useState<MissingAssetChoice>("ignore");
  const [lyricsChoice, setLyricsChoice] = useState<MissingAssetChoice>("ignore");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isSubmittingMissingAssets, setIsSubmittingMissingAssets] = useState(false);
  const [resolvedLyricsForImport, setResolvedLyricsForImport] = useState("");
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replaceModalMessage, setReplaceModalMessage] = useState("");
  const [pendingImportPayload, setPendingImportPayload] = useState<PendingImportPayload | null>(null);

  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const folderPickerKind = useBrowserLocalLibraryStore((state) => state.folderPickerKind);
  const localFolderWritable = folderPickerKind === "handle";
  const hydrateLocalFolder = useBrowserLocalLibraryStore((state) => state.hydrateCapabilities);
  const saveDownloadedTrack = useBrowserLocalLibraryStore((state) => state.saveDownloadedTrack);

  useEffect(() => {
    return () => {
      const audioEl = previewAudioRef.current;
      if (audioEl) {
        audioEl.pause();
        audioEl.currentTime = 0;
      }
    };
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DOWNLOAD_QUALITY_PROFILE_KEY);
      if (stored === "cd" || stored === "hires48" || stored === "max") {
        setQualityProfile(stored);
      }
      const storedProvider = localStorage.getItem(DOWNLOAD_PROVIDER_KEY);
      if (storedProvider && isDownloadProvider(storedProvider)) {
        setDownloadProvider(storedProvider);
      }
    } catch {}
  }, []);

  useEffect(() => {
    hydrateLocalFolder();
  }, [hydrateLocalFolder]);

  if (status === "loading") {
    return <div className="max-w-md mx-auto py-16 px-4">Loading…</div>;
  }
  if (!session) {
    return (
      <div className="max-w-md mx-auto py-16 px-4">
        <p className="mb-4">You must be signed in to upload songs.</p>
        <a className="underline" href="/signin">Sign in</a>
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
      const res = await fetch("/api/songs", { method: "POST", body: form });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? "Upload failed");
      }
      router.push("/");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleFetchSpotify() {
    setError(null);
    setFetchStatus("loading");
    setPreviewStatus("idle");
    setLyricsStatus("idle");
    setCoverStatus("idle");
    setAvailabilityStatus("idle");
    setDownloadStatus("idle");
    setLocalSaveStatus("idle");
    setSpotifyTrack(null);
    setAvailability(null);
    setLyricsText("");
    setResolvedLyricsForImport("");
    setShowMissingAssetsModal(false);
    setModalError(null);
    setCoverFile(null);
    setLyricsFile(null);
    setShowReplaceModal(false);
    setReplaceModalMessage("");
    setPendingImportPayload(null);

    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "fetch",
          spotifyUrl: spotifyUrl.trim(),
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to fetch Spotify track");
      }
      setSpotifyTrack(data.track ?? null);
      setAvailability(data.availability ?? null);
      setFetchStatus("success");
    } catch (err) {
      setFetchStatus("error");
      const message = err instanceof Error ? err.message : "Failed to fetch Spotify track";
      setError(message);
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
      setPreviewStatus("idle");
      return;
    }

    if (!spotifyTrack.previewUrl) {
      setPreviewStatus("error");
      setError("Preview not available for this track");
      return;
    }

    setPreviewStatus("loading");
    try {
      const audioEl = new Audio(spotifyTrack.previewUrl);
      previewAudioRef.current = audioEl;
      audioEl.addEventListener("ended", () => {
        setIsPreviewPlaying(false);
        setPreviewStatus("idle");
        previewAudioRef.current = null;
      });
      audioEl.addEventListener("error", () => {
        setIsPreviewPlaying(false);
        setPreviewStatus("error");
        previewAudioRef.current = null;
      });
      await audioEl.play();
      setIsPreviewPlaying(true);
      setPreviewStatus("success");
    } catch {
      setPreviewStatus("error");
      setError("Failed to play preview");
    }
  }

  async function handleDownloadLyrics() {
    if (!spotifyTrack) return;
    setError(null);
    setLyricsStatus("loading");
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: spotifyUrl.trim(),
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to download lyrics");
      }

      const text = typeof data.lyrics === "string" ? data.lyrics.trim() : "";
      if (!text) {
        throw new Error("Lyrics are empty");
      }
      setLyricsText(text);

      const fileName =
        typeof data.fileName === "string" && data.fileName
          ? data.fileName
          : `${spotifyTrack.title} - ${spotifyTrack.artist}.lrc`;
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);

      setLyricsStatus("success");
    } catch (err) {
      setLyricsStatus("error");
      const message = err instanceof Error ? err.message : "Failed to download lyrics";
      setError(message);
    }
  }

  async function handleDownloadCover() {
    if (!spotifyTrack?.imageUrl) {
      setCoverStatus("error");
      setError("No cover available for this track");
      return;
    }
    setError(null);
    setCoverStatus("loading");
    try {
      const url = new URL("/api/songs/spotify/cover", window.location.origin);
      url.searchParams.set("url", spotifyTrack.imageUrl);
      url.searchParams.set(
        "filename",
        `${spotifyTrack.title} - ${spotifyTrack.artist}.jpg`,
      );

      const response = await fetch(url.toString(), { method: "GET" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error ?? "Failed to download cover");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = `${spotifyTrack.title} - ${spotifyTrack.artist}.jpg`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
      setCoverStatus("success");
    } catch (err) {
      setCoverStatus("error");
      const message = err instanceof Error ? err.message : "Failed to download cover";
      setError(message);
    }
  }

  async function handleCheckAvailability() {
    if (!spotifyTrack) return;
    setError(null);
    setAvailabilityStatus("loading");
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "availability",
          spotifyUrl: spotifyUrl.trim(),
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ?? "Failed to check availability");
      }
      setAvailability(data.availability ?? null);
      setAvailabilityStatus("success");
    } catch (err) {
      setAvailabilityStatus("error");
      const message = err instanceof Error ? err.message : "Failed to check availability";
      setError(message);
    }
  }

  async function fetchLyricsForImport(): Promise<string> {
    if (!spotifyTrack) return "";
    if (lyricsText.trim()) return lyricsText.trim();

    setLyricsStatus("loading");
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: spotifyUrl.trim(),
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLyricsStatus("error");
        return "";
      }
      const text = typeof data.lyrics === "string" ? data.lyrics.trim() : "";
      if (!text) {
        setLyricsStatus("error");
        return "";
      }
      setLyricsText(text);
      setLyricsStatus("success");
      return text;
    } catch {
      setLyricsStatus("error");
      return "";
    }
  }

  async function submitSpotifyImport(
    lyricsToInclude: string,
    customCover: File | null,
    customLyrics: File | null,
    replaceExisting = false,
  ) {
    if (!spotifyTrack) return;

    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: spotifyUrl.trim(),
      region,
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      album: spotifyTrack.album,
      qualityProfile,
    };
    if (downloadProvider !== "auto") {
      payload.service = downloadProvider;
    }
    if (lyricsToInclude) {
      payload.lyricsText = lyricsToInclude;
    }
    if (replaceExisting) {
      payload.replaceExisting = "true";
    }

    const res = await fetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data?.code === "DUPLICATE_SONG") {
      const duplicateMessage =
        typeof data?.existingSong?.title === "string" &&
        typeof data?.existingSong?.artist === "string"
          ? `You already have "${data.existingSong.title}" by ${data.existingSong.artist}. Replace it?`
          : "You already have this song in your library. Replace it?";
      const duplicateError = new Error(duplicateMessage) as Error & {
        code?: string;
      };
      duplicateError.code = "DUPLICATE_SONG";
      throw duplicateError;
    }
    if (!res.ok) {
      throw new Error(data?.error ?? "Failed to add song from Spotify");
    }

    const createdSongId =
      typeof data?.id === "string" && data.id ? data.id : "";
    if (createdSongId && (customCover || customLyrics)) {
      const form = new FormData();
      if (customCover) {
        form.append("image", customCover);
      }
      if (customLyrics) {
        form.append("lyricsFile", customLyrics);
      }
      const assetsRes = await fetch(`/api/songs/${createdSongId}/assets`, {
        method: "POST",
        body: form,
      });
      const assetsData = await assetsRes.json().catch(() => ({}));
      if (!assetsRes.ok) {
        throw new Error(assetsData?.error ?? "Failed to update song assets");
      }
    }
  }

  function isDuplicateSongError(error: unknown): error is Error & { code: string } {
    return (
      error instanceof Error &&
      typeof (error as Error & { code?: unknown }).code === "string" &&
      (error as Error & { code: string }).code === "DUPLICATE_SONG"
    );
  }

  async function handleConfirmReplaceSong() {
    if (!pendingImportPayload) return;
    setShowReplaceModal(false);
    setDownloadStatus("loading");
    setError(null);
    try {
      await submitSpotifyImport(
        pendingImportPayload.lyricsToInclude,
        pendingImportPayload.customCover,
        pendingImportPayload.customLyrics,
        true,
      );
      setPendingImportPayload(null);
      setDownloadStatus("success");
      router.push("/");
    } catch (err) {
      setDownloadStatus("error");
      const message =
        err instanceof Error ? err.message : "Failed to replace existing song";
      setError(message);
      setModalError(message);
    }
  }

  async function handleConfirmMissingAssets() {
    if (!spotifyTrack) return;
    setModalError(null);

    const wantsCoverUpload = missingCover && coverChoice === "upload";
    const wantsLyricsUpload = missingLyrics && lyricsChoice === "upload";

    if (wantsCoverUpload && !coverFile) {
      setModalError("Select a cover file or choose Ignore for cover");
      return;
    }
    if (wantsLyricsUpload && !lyricsFile) {
      setModalError("Select a lyrics file or choose Ignore for lyrics");
      return;
    }

    setIsSubmittingMissingAssets(true);
    setDownloadStatus("loading");
    setError(null);
    try {
      const pendingPayload: PendingImportPayload = {
        lyricsToInclude: missingLyrics ? "" : resolvedLyricsForImport,
        customCover: wantsCoverUpload ? coverFile : null,
        customLyrics: wantsLyricsUpload ? lyricsFile : null,
      };
      await submitSpotifyImport(
        pendingPayload.lyricsToInclude,
        pendingPayload.customCover,
        pendingPayload.customLyrics,
      );
      setDownloadStatus("success");
      setShowMissingAssetsModal(false);
      router.push("/");
    } catch (err) {
      if (isDuplicateSongError(err)) {
        setPendingImportPayload({
          lyricsToInclude: missingLyrics ? "" : resolvedLyricsForImport,
          customCover: wantsCoverUpload ? coverFile : null,
          customLyrics: wantsLyricsUpload ? lyricsFile : null,
        });
        setReplaceModalMessage(err.message);
        setShowReplaceModal(true);
        setShowMissingAssetsModal(false);
        setDownloadStatus("idle");
        return;
      }
      setDownloadStatus("error");
      const message =
        err instanceof Error ? err.message : "Failed to add song from Spotify";
      setModalError(message);
      setError(message);
    } finally {
      setIsSubmittingMissingAssets(false);
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
      const hasCover = Boolean(spotifyTrack.imageUrl);
      const hasLyrics = Boolean(resolvedLyrics);

      if (!hasCover || !hasLyrics) {
        setResolvedLyricsForImport(resolvedLyrics);
        setMissingCover(!hasCover);
        setMissingLyrics(!hasLyrics);
        setCoverChoice("ignore");
        setLyricsChoice("ignore");
        setCoverFile(null);
        setLyricsFile(null);
        setModalError(null);
        setShowMissingAssetsModal(true);
        setDownloadStatus("idle");
        return;
      }

      await submitSpotifyImport(resolvedLyrics, null, null);
      setDownloadStatus("success");
      router.push("/");
    } catch (err) {
      if (isDuplicateSongError(err)) {
        setPendingImportPayload({
          lyricsToInclude: resolvedLyrics || lyricsText.trim() || resolvedLyricsForImport,
          customCover: null,
          customLyrics: null,
        });
        setReplaceModalMessage(err.message);
        setShowReplaceModal(true);
        setDownloadStatus("idle");
        return;
      }
      setDownloadStatus("error");
      const message =
        err instanceof Error ? err.message : "Failed to add song from Spotify";
      setError(message);
    }
  }

  async function handleSaveToLocalFolder() {
    if (!spotifyTrack) {
      setError("Fetch a Spotify track first");
      return;
    }
    if (!localFolderWritable) {
      setLocalSaveStatus("error");
      setError("Saving to a folder requires a writable folder on desktop Chrome or Edge");
      return;
    }

    setError(null);
    setLocalSaveStatus("loading");
    try {
      const audioRes = await fetch("/api/songs/spotify/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spotifyUrl: spotifyUrl.trim(),
          region,
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          album: spotifyTrack.album,
          qualityProfile,
          service: downloadProvider === "auto" ? undefined : downloadProvider,
        }),
      });
      const audioData = audioRes.ok ? null : await audioRes.json().catch(() => ({}));
      if (!audioRes.ok) {
        throw new Error(audioData?.error ?? "Failed to download audio");
      }
      const audioBlob = await audioRes.blob();
      const audioFileName =
        filenameFromContentDisposition(audioRes.headers.get("content-disposition")) ||
        `${spotifyTrack.artist} - ${spotifyTrack.title}.flac`;

      let coverBlob: Blob | null = null;
      let coverFileName = "";
      if (spotifyTrack.imageUrl) {
        const url = new URL("/api/songs/spotify/cover", window.location.origin);
        url.searchParams.set("url", spotifyTrack.imageUrl);
        url.searchParams.set("filename", `${spotifyTrack.title} - ${spotifyTrack.artist}.jpg`);
        const coverRes = await fetch(url.toString(), { method: "GET" }).catch(() => null);
        if (coverRes?.ok) {
          coverBlob = await coverRes.blob();
          coverFileName =
            filenameFromContentDisposition(coverRes.headers.get("content-disposition")) ||
            `${spotifyTrack.title} - ${spotifyTrack.artist}.jpg`;
        }
      }

      const lyricsToInclude = await fetchLyricsForImport();
      await saveDownloadedTrack({
        title: spotifyTrack.title,
        artist: spotifyTrack.artist,
        audioBlob,
        audioFileName,
        coverBlob,
        coverFileName,
        lyricsText: lyricsToInclude,
      });
      setLocalSaveStatus("success");
    } catch (err) {
      setLocalSaveStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save to folder");
    }
  }

  return (
    <div className="max-w-5xl mx-auto py-12 px-4">
      <h1 className="text-2xl font-semibold mb-6">Add a song</h1>
      <div className="mb-8 inline-flex rounded-2xl border border-white/25 bg-white/[0.02] p-1.5">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setMode("spotify");
          }}
          className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${
            mode === "spotify"
              ? "bg-foreground text-background"
              : "text-foreground/80 hover:text-foreground"
          }`}
        >
          Spotify link
        </button>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setMode("upload");
          }}
          className={`h-10 px-5 rounded-xl text-sm font-medium transition-colors ${
            mode === "upload"
              ? "bg-foreground text-background"
              : "text-foreground/80 hover:text-foreground"
          }`}
        >
          Upload files
        </button>
      </div>

      {mode === "upload" ? (
        <form
          onSubmit={onUploadSubmit}
          className="max-w-2xl rounded-3xl border border-white/20 bg-white/[0.02] p-6 md:p-7 space-y-5"
        >
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <label className="block text-sm mb-2 text-foreground/80">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                required
              />
            </div>
            <div>
              <label className="block text-sm mb-2 text-foreground/80">Artist</label>
              <input
                value={artist}
                onChange={(e) => setArtist(e.target.value)}
                className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                required
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer hover:border-yellow-500/60 transition-colors">
              <span className="block text-sm font-medium">Cover image</span>
              <span className="block text-xs text-foreground/60 mt-1">
                JPG, PNG, WEBP
              </span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">
                {image ? image.name : "Choose image file"}
              </span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => setImage(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </label>

            <label className="rounded-2xl border border-dashed border-white/30 bg-black/20 p-4 cursor-pointer hover:border-yellow-500/60 transition-colors">
              <span className="block text-sm font-medium">Audio file</span>
              <span className="block text-xs text-foreground/60 mt-1">
                FLAC, MP3, WAV
              </span>
              <span className="mt-3 inline-block text-xs px-2.5 py-1 rounded-lg bg-white/10">
                {audio ? audio.name : "Choose audio file"}
              </span>
              <input
                type="file"
                accept="audio/*"
                onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
                className="hidden"
              />
            </label>
          </div>

          {error && <div className="text-sm text-red-500">{error}</div>}
          <button
            type="submit"
            disabled={loading}
            className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center gap-2"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? "Uploading…" : "Upload Song"}
          </button>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col md:flex-row gap-3">
            <input
              value={spotifyUrl}
              onChange={(e) => setSpotifyUrl(e.target.value)}
              className="flex-1 border border-white/25 rounded-2xl px-4 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
              placeholder="https://open.spotify.com/track/..."
            />
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value.toUpperCase())}
              className="w-full md:w-24 border border-white/25 rounded-2xl px-3 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
            >
              <option value="US">US</option>
              <option value="GB">GB</option>
              <option value="DE">DE</option>
              <option value="FR">FR</option>
              <option value="ES">ES</option>
              <option value="IT">IT</option>
            </select>
            <button
              type="button"
              onClick={handleFetchSpotify}
              disabled={fetchStatus === "loading" || !spotifyUrl.trim()}
              className="h-11 px-5 rounded-2xl bg-yellow-500 text-black font-medium disabled:opacity-50 inline-flex items-center gap-2"
            >
              {fetchStatus === "loading" ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Download size={16} />
              )}
              Fetch
            </button>
          </div>

          {spotifyTrack && (
            <div className="rounded-3xl border p-5 bg-black/[0.03] dark:bg-white/[0.03]">
              <div className="flex flex-col lg:flex-row gap-6">
                <div className="shrink-0">
                  {spotifyTrack.imageUrl ? (
                    <div className="relative w-56 h-56 rounded-2xl overflow-hidden bg-black/10">
                      <img
                        src={spotifyTrack.imageUrl}
                        alt={spotifyTrack.title}
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute bottom-2 right-2 bg-black/80 text-white text-xs px-2 py-0.5 rounded-lg">
                        {formatDuration(spotifyTrack.durationMs)}
                      </div>
                    </div>
                  ) : (
                    <div className="w-56 h-56 rounded-2xl bg-black/10 grid place-items-center text-sm opacity-70">
                      No Cover
                    </div>
                  )}
                </div>

                <div className="flex-1 min-w-0 space-y-4">
                  <div>
                    <h2 className="text-4xl font-bold leading-tight break-words">
                      {spotifyTrack.title}
                    </h2>
                    <p className="text-2xl text-foreground/70 mt-1">
                      {spotifyTrack.artist}
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                    <div>
                      <div className="text-foreground/60">Album</div>
                      <div className="font-medium">{spotifyTrack.album || "N/A"}</div>
                    </div>
                    <div>
                      <div className="text-foreground/60">Release Date</div>
                      <div className="font-medium">
                        {spotifyTrack.releaseDate || "N/A"}
                      </div>
                    </div>
                    <div>
                      <div className="text-foreground/60">Total Plays</div>
                      <div className="font-medium">
                        {formatPlays(spotifyTrack.totalPlays)}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      type="button"
                      onClick={handleAddFromSpotify}
                      disabled={downloadStatus === "loading"}
                      className="h-11 flex-1 justify-center rounded-2xl bg-yellow-500 px-5 text-black font-semibold inline-flex items-center gap-2 disabled:opacity-50 sm:flex-none"
                    >
                      {downloadStatus === "loading" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Download size={16} />
                      )}
                      Download
                      <ActionIcon status={downloadStatus} />
                    </button>

                    <button
                      type="button"
                      onClick={handleSaveToLocalFolder}
                      disabled={localSaveStatus === "loading" || !localFolderWritable}
                      title={
                        localFolderWritable
                          ? "Save to local folder"
                          : "Folder writing is not available in this browser"
                      }
                      className="h-11 flex-1 justify-center rounded-2xl border px-5 font-semibold inline-flex items-center gap-2 disabled:opacity-50 sm:flex-none"
                    >
                      {localSaveStatus === "loading" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <FolderDown size={16} />
                      )}
                      Save to Folder
                      <ActionIcon status={localSaveStatus} />
                    </button>

                    <div className="relative group/preview">
                      <button
                        type="button"
                        onClick={handlePreviewToggle}
                        className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center"
                      >
                        {isPreviewPlaying ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-20 opacity-0 scale-95 transition-all duration-150 group-hover/preview:opacity-100 group-hover/preview:scale-100">
                        <div className="relative rounded-2xl border bg-white dark:bg-zinc-900 shadow-2xl px-5 py-2 text-base font-medium whitespace-nowrap">
                          {isPreviewPlaying ? "Stop Preview" : "Play Preview"}
                          <div className="absolute left-1/2 -translate-x-1/2 top-full w-3 h-3 rotate-45 bg-white dark:bg-zinc-900 border-r border-b" />
                        </div>
                      </div>
                    </div>

                    <div className="relative group/lyrics">
                      <button
                        type="button"
                        onClick={handleDownloadLyrics}
                        className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center"
                      >
                        {lyricsStatus === "loading" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : lyricsStatus === "success" ? (
                          <CheckCircle2 size={16} className="text-green-500" />
                        ) : lyricsStatus === "error" ? (
                          <XCircle size={16} className="text-red-500" />
                        ) : (
                          <FileText size={16} />
                        )}
                      </button>
                      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-20 opacity-0 scale-95 transition-all duration-150 group-hover/lyrics:opacity-100 group-hover/lyrics:scale-100">
                        <div className="relative rounded-2xl border bg-white dark:bg-zinc-900 shadow-2xl px-5 py-2 text-base font-medium whitespace-nowrap">
                          Download Lyric
                          <div className="absolute left-1/2 -translate-x-1/2 top-full w-3 h-3 rotate-45 bg-white dark:bg-zinc-900 border-r border-b" />
                        </div>
                      </div>
                    </div>

                    <div className="relative group/cover">
                      <button
                        type="button"
                        onClick={handleDownloadCover}
                        className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center"
                      >
                        {coverStatus === "loading" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : coverStatus === "success" ? (
                          <CheckCircle2 size={16} className="text-green-500" />
                        ) : coverStatus === "error" ? (
                          <XCircle size={16} className="text-red-500" />
                        ) : (
                          <ImageDown size={16} />
                        )}
                      </button>
                      <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-20 opacity-0 scale-95 transition-all duration-150 group-hover/cover:opacity-100 group-hover/cover:scale-100">
                        <div className="relative rounded-2xl border bg-white dark:bg-zinc-900 shadow-2xl px-5 py-2 text-base font-medium whitespace-nowrap">
                          Download Cover
                          <div className="absolute left-1/2 -translate-x-1/2 top-full w-3 h-3 rotate-45 bg-white dark:bg-zinc-900 border-r border-b" />
                        </div>
                      </div>
                    </div>

                    <div className="relative group/availability">
                      {availability && (
                        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-20 opacity-0 scale-95 transition-all duration-150 group-hover/availability:opacity-100 group-hover/availability:scale-100">
                          <div className="relative rounded-2xl border bg-white dark:bg-zinc-900 shadow-2xl px-4 py-3 min-w-[210px]">
                            <AvailabilityLogos availability={availability} />
                            <div className="absolute left-1/2 -translate-x-1/2 top-full w-3 h-3 rotate-45 bg-white dark:bg-zinc-900 border-r border-b" />
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handleCheckAvailability}
                        className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center"
                      >
                        {availabilityStatus === "loading" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Globe size={16} />
                        )}
                      </button>
                      {!availability && (
                        <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-3 z-10 opacity-0 scale-95 transition-all duration-150 group-hover/availability:opacity-100 group-hover/availability:scale-100">
                          <div className="relative rounded-2xl border bg-white dark:bg-zinc-900 shadow-2xl px-5 py-2 text-base font-medium whitespace-nowrap">
                            Check Availability
                            <div className="absolute left-1/2 -translate-x-1/2 top-full w-3 h-3 rotate-45 bg-white dark:bg-zinc-900 border-r border-b" />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {showMissingAssetsModal && (
            <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4">
              <div className="w-full max-w-lg rounded-2xl border border-white/20 bg-zinc-950 p-5 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Missing assets</h3>
                  <p className="text-sm text-zinc-300 mt-1">
                    Choose how to continue for unavailable items.
                  </p>
                </div>

                {missingCover && (
                  <div className="rounded-xl border border-white/15 p-3 space-y-2">
                    <div className="text-sm font-medium">Cover image is unavailable</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setCoverChoice("ignore")}
                        className={`h-9 px-3 rounded border ${
                          coverChoice === "ignore"
                            ? "border-yellow-500 text-yellow-400"
                            : "border-white/30"
                        }`}
                      >
                        Ignore
                      </button>
                      <button
                        type="button"
                        onClick={() => setCoverChoice("upload")}
                        className={`h-9 px-3 rounded border ${
                          coverChoice === "upload"
                            ? "border-yellow-500 text-yellow-400"
                            : "border-white/30"
                        }`}
                      >
                        Upload file
                      </button>
                    </div>
                    {coverChoice === "upload" && (
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setCoverFile(e.target.files?.[0] ?? null)}
                        className="block text-sm"
                      />
                    )}
                  </div>
                )}

                {missingLyrics && (
                  <div className="rounded-xl border border-white/15 p-3 space-y-2">
                    <div className="text-sm font-medium">Lyrics are unavailable</div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setLyricsChoice("ignore")}
                        className={`h-9 px-3 rounded border ${
                          lyricsChoice === "ignore"
                            ? "border-yellow-500 text-yellow-400"
                            : "border-white/30"
                        }`}
                      >
                        Ignore
                      </button>
                      <button
                        type="button"
                        onClick={() => setLyricsChoice("upload")}
                        className={`h-9 px-3 rounded border ${
                          lyricsChoice === "upload"
                            ? "border-yellow-500 text-yellow-400"
                            : "border-white/30"
                        }`}
                      >
                        Upload file
                      </button>
                    </div>
                    {lyricsChoice === "upload" && (
                      <input
                        type="file"
                        accept=".lrc,.txt,text/plain"
                        onChange={(e) => setLyricsFile(e.target.files?.[0] ?? null)}
                        className="block text-sm"
                      />
                    )}
                  </div>
                )}

                {modalError && <div className="text-sm text-red-400">{modalError}</div>}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (isSubmittingMissingAssets) return;
                      setShowMissingAssetsModal(false);
                      setDownloadStatus("idle");
                    }}
                    className="h-10 px-4 rounded border border-white/30"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmMissingAssets}
                    disabled={isSubmittingMissingAssets}
                    className="h-10 px-4 rounded bg-yellow-500 text-black font-medium disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {isSubmittingMissingAssets ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : null}
                    Continue Download
                  </button>
                </div>
              </div>
            </div>
          )}

          {showReplaceModal && (
            <div className="fixed inset-0 z-50 bg-black/70 grid place-items-center p-4">
              <div className="w-full max-w-md rounded-2xl border border-white/20 bg-zinc-950 p-5 space-y-4">
                <div>
                  <h3 className="text-lg font-semibold">Song already exists</h3>
                  <p className="text-sm text-zinc-300 mt-1">
                    {replaceModalMessage || "This song is already in your library."}
                  </p>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowReplaceModal(false);
                      setPendingImportPayload(null);
                      setDownloadStatus("idle");
                    }}
                    className="h-10 px-4 rounded border border-white/30"
                  >
                    Keep Existing
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirmReplaceSong}
                    className="h-10 px-4 rounded bg-yellow-500 text-black font-medium inline-flex items-center gap-2"
                  >
                    Replace Song
                  </button>
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
