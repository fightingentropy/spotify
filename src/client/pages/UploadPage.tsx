"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { CheckCircle2, Download, Loader2, Pause, Play, XCircle } from "lucide-react";
import { invalidateLibraryApiCache } from "@/client/api";
import { useAuth } from "@/client/auth";
import {
  DOWNLOAD_PROVIDER_KEY,
  DOWNLOAD_QUALITY_PROFILE_KEY,
  isDownloadProvider,
  type DownloadProvider,
} from "@/components/DownloadQualitySettings";
import { readSpotifyCookie, writeSpotifyCookie } from "@/components/SpotifyCookieSettings";
import { resolveSpotifyBatchOnClient } from "@/lib/spotify-batch-client";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";
import { convertAudioFile, getSupportedFormats, getExtensionForFormat } from "@/lib/audio-converter";

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
type OutputFormat = "flac" | "mp3" | "aac" | "ogg" | "opus" | "wav";
type BatchType = "track" | "album" | "playlist";
type PendingImportPayload = { lyricsToInclude: string };
type PreparedBrowserSave = {
  files: File[];
  trackTitle: string;
  trackArtist: string;
};
type BatchInfo = {
  type: BatchType;
  title: string;
  artist: string;
  trackCount: number;
  format: OutputFormat;
  trackIds: string[];
};
type BatchProgress = {
  current: number;
  total: number;
  currentTrack: string;
  succeeded: number;
  skipped: number;
  failed: number;
};
type ShareFilesPayload = {
  files: File[];
  title?: string;
  text?: string;
};
type FileSharingNavigator = Navigator & {
  canShare?: (data: ShareFilesPayload) => boolean;
  share?: (data: ShareFilesPayload) => Promise<void>;
};
type BrowserSaveResult = "shared-all" | "shared-some" | "downloaded";

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

function sanitizeDownloadSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ");
  return safe || "Unknown";
}

function extensionFromFileName(name: string, fallback: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : fallback;
}

function stemFromFileName(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(0, index) : name;
}

function createDownloadFile(
  blob: Blob,
  fileName: string,
  type = blob.type || "application/octet-stream",
): File {
  return new File([blob], fileName, { type, lastModified: Date.now() });
}

function browserSupportsSharing(files: File[]): boolean {
  if (typeof navigator === "undefined") return false;
  const sharingNavigator = navigator as FileSharingNavigator;
  if (!sharingNavigator.share) return false;
  if (!sharingNavigator.canShare) return true;
  try {
    return sharingNavigator.canShare({ files });
  } catch {
    return false;
  }
}

function triggerBrowserDownloads(files: File[]) {
  for (const file of files) {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

function normalizeTrackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isBrowserSaveDismissed(errorValue: unknown): boolean {
  return (
    errorValue instanceof DOMException &&
    (errorValue.name === "AbortError" || errorValue.name === "NotAllowedError")
  );
}

export default function UploadPage() {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const localDirectoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const localFolderPickerKind = useBrowserLocalLibraryStore((state) => state.folderPickerKind);
  const localFolderWritable = useBrowserLocalLibraryStore((state) => state.writable);
  const localSongsCount = useBrowserLocalLibraryStore((state) => state.songs.length);
  const localSongs = useBrowserLocalLibraryStore((state) => state.songs);
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
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("flac");
  const [downloadProvider, setDownloadProvider] = useState<DownloadProvider>("auto");
  const [showReplaceModal, setShowReplaceModal] = useState(false);
  const [replaceModalMessage, setReplaceModalMessage] = useState("");
  const [pendingImportPayload, setPendingImportPayload] = useState<PendingImportPayload | null>(null);
  const [preparedBrowserSave, setPreparedBrowserSave] = useState<PreparedBrowserSave | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);
  const [batchInfo, setBatchInfo] = useState<BatchInfo | null>(null);
  const [batchStatus, setBatchStatus] = useState<ActionStatus>("idle");
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchFailures, setBatchFailures] = useState<string[]>([]);
  const autoStartRef = useRef<"fetch" | "download" | null>(null);
  const [autoDownloadPending, setAutoDownloadPending] = useState(false);
  const autoDownloadStartedRef = useRef(false);
  const batchDownloadRunnerRef = useRef<() => Promise<void>>(() => Promise.resolve());
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

    const params = new URLSearchParams(window.location.search);
    const cookieParam = params.get("spotifyCookie");
    const urlParam = params.get("url");
    const autostart = params.get("autostart") === "1";
    if (cookieParam) writeSpotifyCookie(cookieParam);
    if (urlParam) setSpotifyUrl(decodeURIComponent(urlParam));
    if (autostart && urlParam) {
      autoStartRef.current = "download";
      window.history.replaceState({}, "", "/upload");
    } else if (urlParam) {
      autoStartRef.current = "fetch";
      window.history.replaceState({}, "", "/upload");
    }
  }, []);

  useEffect(() => {
    if (status === "loading" || !user) return;
    const pending = autoStartRef.current;
    if (!pending || !spotifyUrl.trim()) return;
    autoStartRef.current = null;
    if (pending === "download") setAutoDownloadPending(true);

    void (async () => {
      setError(null);
      setNotice(null);
      setFetchStatus("loading");
      setBatchStatus("idle");
      setBatchProgress(null);
      setBatchFailures([]);
      setBatchInfo(null);

      const url = spotifyUrl.trim();
      try {
        const cookie = readSpotifyCookie();
        const clientBatch = await resolveSpotifyBatchOnClient(url, cookie, outputFormat);
        setBatchInfo(clientBatch);
        setFetchStatus("success");
        setNotice(`Found ${clientBatch.trackCount} tracks from Spotify.`);
      } catch (err) {
        setFetchStatus("error");
        setError(err instanceof Error ? err.message : "Failed to fetch batch info");
      }
    })();
  }, [user, status, spotifyUrl, outputFormat]);

  useEffect(() => {
    if (!batchInfo || !autoDownloadPending || autoDownloadStartedRef.current) return;
    autoDownloadStartedRef.current = true;
    setAutoDownloadPending(false);
    window.dispatchEvent(new CustomEvent("spotify-start-batch-download"));
  }, [batchInfo, autoDownloadPending]);

  useEffect(() => {
    const handler = () => {
      void batchDownloadRunnerRef.current();
    };
    window.addEventListener("spotify-start-batch-download", handler);
    return () => window.removeEventListener("spotify-start-batch-download", handler);
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
      invalidateLibraryApiCache();
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleFetchSpotify() {
    setError(null);
    setNotice(null);
    setFetchStatus("loading");
    setDownloadStatus("idle");
    setBatchStatus("idle");
    setBatchProgress(null);
    setBatchFailures([]);
    setSpotifyTrack(null);
    setBatchInfo(null);
    setLyricsText("");
    setShowReplaceModal(false);
    setReplaceModalMessage("");
    setPendingImportPayload(null);
    setPreparedBrowserSave(null);

    // Detect if this is a batch URL (album/playlist)
    const url = spotifyUrl.trim();
    const isBatch = url.includes("/album/") || url.includes("/playlist/") || url.includes("/collection/");

    if (isBatch) {
      try {
        const cookie = readSpotifyCookie();
        try {
          const clientBatch = await resolveSpotifyBatchOnClient(url, cookie, outputFormat);
          setBatchInfo(clientBatch);
          setFetchStatus("success");
          setNotice(`Found ${clientBatch.trackCount} tracks from Spotify.`);
          return;
        } catch (clientError) {
          const res = await fetch("/api/songs/spotify/batch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              spotifyUrl: url,
              region,
              outputFormat,
              qualityProfile,
              spotifyCookie: cookie,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw clientError instanceof Error
              ? clientError
              : new Error(data?.error ?? "Failed to fetch batch info");
          }
          setBatchInfo(data.batchInfo);
          setFetchStatus("success");
        }
      } catch (err) {
        setFetchStatus("error");
        setError(err instanceof Error ? err.message : "Failed to fetch batch info");
      }
    } else {
      // Handle single track
      try {
        const res = await fetch("/api/songs/spotify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ action: "fetch", spotifyUrl: url, region }),
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
  }

  async function fetchSpotifyTrackById(trackId: string): Promise<SpotifyTrack> {
    const res = await fetch("/api/songs/spotify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        action: "fetch",
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
        region,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "Failed to fetch Spotify track");
    if (!data.track) throw new Error("Spotify track metadata missing");
    return data.track as SpotifyTrack;
  }

  async function fetchLyricsForTrack(track: SpotifyTrack, trackUrl: string): Promise<string> {
    try {
      const res = await fetch("/api/songs/spotify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "lyrics",
          spotifyUrl: trackUrl,
          title: track.title,
          artist: track.artist,
          region,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return "";
      return typeof data.lyrics === "string" ? data.lyrics.trim() : "";
    } catch {
      return "";
    }
  }

  function buildDownloadPayloadForTrack(
    track: SpotifyTrack,
    trackUrl: string,
    lyricsToInclude = "",
  ): Record<string, string> {
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: trackUrl,
      region,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: String(track.durationMs || ""),
      imageUrl: track.imageUrl,
      qualityProfile,
    };
    if (downloadProvider !== "auto") payload.service = downloadProvider;
    if (lyricsToInclude) payload.lyricsText = lyricsToInclude;
    return payload;
  }

  async function fetchSpotifyAudioBlobForTrack(
    track: SpotifyTrack,
    payload: Record<string, string>,
  ) {
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
    const fallback = `${track.artist || "Unknown Artist"} - ${track.title || "Track"}${extensionFromContentType(blob.type, ".flac")}`;
    return {
      blob,
      fileName: filenameFromContentDisposition(res.headers.get("content-disposition"), fallback),
    };
  }

  async function fetchSpotifyCoverBlobForTrack(track: SpotifyTrack) {
    if (!track.imageUrl) return null;
    const res = await fetch(
      `/api/songs/spotify/cover?url=${encodeURIComponent(track.imageUrl)}&filename=${encodeURIComponent(`${track.title} cover`)}`,
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

  async function saveTrackToLocalFolder(
    track: SpotifyTrack,
    trackUrl: string,
    lyricsToInclude: string,
  ) {
    const payload = buildDownloadPayloadForTrack(track, trackUrl, lyricsToInclude);
    const [audio, cover] = await Promise.all([
      fetchSpotifyAudioBlobForTrack(track, payload),
      fetchSpotifyCoverBlobForTrack(track).catch(() => null),
    ]);
    await saveDownloadedTrack({
      title: track.title,
      artist: track.artist,
      audioBlob: audio.blob,
      audioFileName: audio.fileName,
      coverBlob: cover?.blob ?? null,
      coverFileName: cover?.fileName,
      lyricsText: lyricsToInclude,
    });
  }

  async function buildBrowserSaveForTrack(
    track: SpotifyTrack,
    trackUrl: string,
    lyricsToInclude: string,
  ): Promise<PreparedBrowserSave> {
    const payload = buildDownloadPayloadForTrack(track, trackUrl, lyricsToInclude);
    const [audio, cover] = await Promise.all([
      fetchSpotifyAudioBlobForTrack(track, payload),
      fetchSpotifyCoverBlobForTrack(track).catch(() => null),
    ]);

    let processedAudioBlob = audio.blob;
    let audioExt = extensionFromFileName(
      audio.fileName,
      extensionFromContentType(audio.blob.type, ".flac"),
    );

    if (outputFormat !== "flac" && getSupportedFormats().includes(outputFormat)) {
      try {
        const audioBuffer = await audio.blob.arrayBuffer();
        processedAudioBlob = await convertAudioFile(audioBuffer, {
          format: outputFormat,
          quality: 0.9,
          bitRate: outputFormat === "mp3" ? 320 : undefined,
        });
        audioExt = getExtensionForFormat(outputFormat);
      } catch (conversionError) {
        console.warn("Audio conversion failed, using original format:", conversionError);
      }
    }

    const audioStem = sanitizeDownloadSegment(`${track.artist} - ${track.title}`);
    const audioFileName = `${audioStem}${audioExt}`;
    const files = [createDownloadFile(processedAudioBlob, audioFileName)];
    let coverFileName: string | undefined;
    let lyricsFileName: string | undefined;

    if (cover?.blob) {
      const coverExt = extensionFromFileName(
        cover.fileName,
        extensionFromContentType(cover.blob.type, ".jpg"),
      );
      coverFileName = `${audioStem}.cover${coverExt}`;
      files.push(createDownloadFile(cover.blob, coverFileName));
    }

    if (lyricsToInclude.trim()) {
      lyricsFileName = `${audioStem}.lrc`;
      files.push(
        createDownloadFile(
          new Blob([lyricsToInclude.trim()], { type: "text/plain;charset=utf-8" }),
          lyricsFileName,
          "text/plain;charset=utf-8",
        ),
      );
    }

    const sidecar = {
      version: 1,
      title: track.title,
      artist: track.artist,
      coverFile: coverFileName,
      lyricsFile: lyricsFileName,
      updatedAt: new Date().toISOString(),
    };
    files.push(
      createDownloadFile(
        new Blob([`${JSON.stringify(sidecar, null, 2)}\n`], { type: "application/json" }),
        `${stemFromFileName(audioFileName)}.spotify.json`,
        "application/json",
      ),
    );

    return {
      files,
      trackTitle: track.title,
      trackArtist: track.artist,
    };
  }

  async function submitTrackImport(
    track: SpotifyTrack,
    trackUrl: string,
    lyricsToInclude: string,
    replaceExisting = false,
  ) {
    const payload: Record<string, string> = {
      mode: "spotify",
      spotifyUrl: trackUrl,
      region,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: String(track.durationMs || ""),
      imageUrl: track.imageUrl,
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
      return "skipped" as const;
    }
    if (!res.ok) throw new Error(data?.error ?? "Failed to add song from Spotify");
    invalidateLibraryApiCache();
    return "imported" as const;
  }

  function isTrackAlreadyLocal(track: SpotifyTrack, knownKeys: Set<string>) {
    return knownKeys.has(normalizeTrackKey(track.title, track.artist));
  }

  async function handleBatchDownload() {
    if (!batchInfo) return;
    setError(null);
    setNotice(null);
    setBatchFailures([]);
    setBatchStatus("loading");

    const total = batchInfo.trackIds.length;
    const knownKeys = new Set(
      localSongs.map((song) => normalizeTrackKey(song.title, song.artist)),
    );
    const failures: string[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    const saveLocally = shouldSaveToLocalFolder();
    const saveViaBrowserDownloads = hasReadOnlyPickedFolder();

    setBatchProgress({
      current: 0,
      total,
      currentTrack: "",
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });

    try {
      for (let index = 0; index < batchInfo.trackIds.length; index += 1) {
        const trackId = batchInfo.trackIds[index];
        const trackUrl = `https://open.spotify.com/track/${trackId}`;
        let track: SpotifyTrack;

        try {
          track = await fetchSpotifyTrackById(trackId);
        } catch (err) {
          failed += 1;
          failures.push(
            `${trackId}: ${err instanceof Error ? err.message : "Failed to fetch track metadata"}`,
          );
          setBatchProgress({
            current: index + 1,
            total,
            currentTrack: trackId,
            succeeded,
            skipped,
            failed,
          });
          await delay(400);
          continue;
        }

        setBatchProgress({
          current: index + 1,
          total,
          currentTrack: `${track.artist} - ${track.title}`,
          succeeded,
          skipped,
          failed,
        });

        if (isTrackAlreadyLocal(track, knownKeys)) {
          skipped += 1;
          setBatchProgress({
            current: index + 1,
            total,
            currentTrack: `${track.artist} - ${track.title}`,
            succeeded,
            skipped,
            failed,
          });
          await delay(200);
          continue;
        }

        try {
          const lyrics = await fetchLyricsForTrack(track, trackUrl);
          if (saveLocally) {
            await saveTrackToLocalFolder(track, trackUrl, lyrics);
          } else if (saveViaBrowserDownloads) {
            const prepared = await buildBrowserSaveForTrack(track, trackUrl, lyrics);
            triggerBrowserDownloads(
              prepared.files.filter((file) => !file.name.endsWith(".spotify.json")),
            );
          } else {
            const result = await submitTrackImport(track, trackUrl, lyrics);
            if (result === "skipped") {
              skipped += 1;
              knownKeys.add(normalizeTrackKey(track.title, track.artist));
              setBatchProgress({
                current: index + 1,
                total,
                currentTrack: `${track.artist} - ${track.title}`,
                succeeded,
                skipped,
                failed,
              });
              await delay(400);
              continue;
            }
          }
          knownKeys.add(normalizeTrackKey(track.title, track.artist));
          succeeded += 1;
        } catch (err) {
          failed += 1;
          failures.push(
            `${track.artist} - ${track.title}: ${err instanceof Error ? err.message : "Download failed"}`,
          );
        }

        setBatchProgress({
          current: index + 1,
          total,
          currentTrack: `${track.artist} - ${track.title}`,
          succeeded,
          skipped,
          failed,
        });
        await delay(500);
      }

      setBatchFailures(failures);
      setBatchStatus(failed > 0 && succeeded === 0 ? "error" : "success");
      setNotice(
        `Batch complete: ${succeeded} downloaded, ${skipped} skipped, ${failed} failed out of ${total} tracks.`,
      );
      if (succeeded > 0) invalidateLibraryApiCache();
      if (failures.length > 0) {
        setError(failures.slice(0, 3).join(" · "));
      }
    } catch (err) {
      setBatchStatus("error");
      setError(err instanceof Error ? err.message : "Batch download failed");
    }
  }
  batchDownloadRunnerRef.current = handleBatchDownload;

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
      durationMs: String(spotifyTrack.durationMs || ""),
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
    invalidateLibraryApiCache();
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
      durationMs: String(spotifyTrack.durationMs || ""),
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

  async function buildSpotifyBrowserSave(lyricsToInclude: string): Promise<PreparedBrowserSave> {
    if (!spotifyTrack) throw new Error("Fetch a Spotify track first");
    const payload = spotifyDownloadPayload(lyricsToInclude);
    const [audio, cover] = await Promise.all([
      fetchSpotifyAudioBlob(payload),
      fetchSpotifyCoverBlob().catch(() => null),
    ]);

    let processedAudioBlob = audio.blob;
    let audioExt = extensionFromFileName(
      audio.fileName,
      extensionFromContentType(audio.blob.type, ".flac"),
    );

    // Convert audio format if needed
    if (outputFormat !== "flac" && getSupportedFormats().includes(outputFormat)) {
      try {
        const audioBuffer = await audio.blob.arrayBuffer();
        processedAudioBlob = await convertAudioFile(audioBuffer, {
          format: outputFormat,
          quality: 0.9,
          bitRate: outputFormat === "mp3" ? 320 : undefined
        });
        audioExt = getExtensionForFormat(outputFormat);
      } catch (error) {
        console.warn("Audio conversion failed, using original format:", error);
      }
    }

    const audioStem = sanitizeDownloadSegment(`${spotifyTrack.artist} - ${spotifyTrack.title}`);
    const audioFileName = `${audioStem}${audioExt}`;
    const audioFile = createDownloadFile(processedAudioBlob, audioFileName);
    const files = [audioFile];
    let coverFileName: string | undefined;
    let lyricsFileName: string | undefined;

    if (cover?.blob) {
      const coverExt = extensionFromFileName(
        cover.fileName,
        extensionFromContentType(cover.blob.type, ".jpg"),
      );
      coverFileName = `${audioStem}.cover${coverExt}`;
      files.push(createDownloadFile(cover.blob, coverFileName));
    }

    if (lyricsToInclude.trim()) {
      lyricsFileName = `${audioStem}.lrc`;
      files.push(
        createDownloadFile(
          new Blob([lyricsToInclude.trim()], { type: "text/plain;charset=utf-8" }),
          lyricsFileName,
          "text/plain;charset=utf-8",
        ),
      );
    }

    const sidecar = {
      version: 1,
      title: spotifyTrack.title,
      artist: spotifyTrack.artist,
      coverFile: coverFileName,
      lyricsFile: lyricsFileName,
      updatedAt: new Date().toISOString(),
    };
    files.push(
      createDownloadFile(
        new Blob([`${JSON.stringify(sidecar, null, 2)}\n`], { type: "application/json" }),
        `${stemFromFileName(audioFileName)}.spotify.json`,
        "application/json",
      ),
    );

    return {
      files,
      trackTitle: spotifyTrack.title,
      trackArtist: spotifyTrack.artist,
    };
  }

  async function savePreparedFilesThroughBrowser(
    prepared: PreparedBrowserSave,
  ): Promise<BrowserSaveResult> {
    const sharingNavigator = navigator as FileSharingNavigator;
    const title = `${prepared.trackArtist} - ${prepared.trackTitle}`;
    const text = "Save these files into your music folder.";
    if (sharingNavigator.share) {
      const candidates = [
        prepared.files,
        prepared.files.filter((file) => !file.name.endsWith(".spotify.json")),
        prepared.files.filter(
          (file) =>
            file.type.startsWith("audio/") ||
            file.type.startsWith("image/") ||
            file.type.startsWith("text/"),
        ),
        prepared.files.filter((file) => file.type.startsWith("audio/")),
      ].filter((files) => files.length > 0);

      for (const files of candidates) {
        if (!browserSupportsSharing(files)) continue;
        try {
          await sharingNavigator.share({ title, text, files });
          return files.length === prepared.files.length ? "shared-all" : "shared-some";
        } catch (errorValue) {
          if (isBrowserSaveDismissed(errorValue)) throw errorValue;
        }
      }
    }

    triggerBrowserDownloads(prepared.files);
    return "downloaded";
  }

  function browserSaveNotice(result: BrowserSaveResult) {
    if (result === "shared-all") {
      return "Save sheet opened. Save the files into your music folder, then reopen that folder in Library.";
    }
    if (result === "shared-some") {
      return "Save sheet opened. This browser accepted the music file, but may skip one of the helper files.";
    }
    return "Download started. Save the files into your music folder, then reopen that folder in Library.";
  }

  function isDuplicateSongError(errorValue: unknown): errorValue is Error & { code: string } {
    return errorValue instanceof Error && (errorValue as Error & { code?: string }).code === "DUPLICATE_SONG";
  }

  async function handleConfirmReplaceSong() {
    if (!pendingImportPayload) return;
    setShowReplaceModal(false);
    setDownloadStatus("loading");
    setError(null);
    setNotice(null);
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
    setNotice(null);
    setPreparedBrowserSave(null);
    setDownloadStatus("loading");
    let resolvedLyrics = "";
    let shouldStayOnPage = false;
    let browserSavePrepared = false;
    try {
      resolvedLyrics = await fetchLyricsForImport();
      if (shouldSaveToLocalFolder()) {
        await saveSpotifyImportToLocalFolder(resolvedLyrics);
      } else if (hasReadOnlyPickedFolder()) {
        const prepared = await buildSpotifyBrowserSave(resolvedLyrics);
        setPreparedBrowserSave(prepared);
        browserSavePrepared = true;
        const result = await savePreparedFilesThroughBrowser(prepared);
        setNotice(browserSaveNotice(result));
        shouldStayOnPage = true;
      } else {
        await submitSpotifyImport(resolvedLyrics);
      }
      setDownloadStatus("success");
      if (!shouldStayOnPage) navigate("/");
    } catch (err) {
      if (isDuplicateSongError(err)) {
        setPendingImportPayload({ lyricsToInclude: resolvedLyrics || lyricsText.trim() });
        setReplaceModalMessage(err.message);
        setShowReplaceModal(true);
        setDownloadStatus("idle");
        return;
      }
      if (browserSavePrepared && isBrowserSaveDismissed(err)) {
        setDownloadStatus("idle");
        setNotice("Ready to save. Tap Save to Files to open the system save sheet.");
        return;
      }
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to add song from Spotify");
    }
  }

  async function handleSavePreparedToFiles() {
    if (!preparedBrowserSave) return;
    setError(null);
    setNotice(null);
    setDownloadStatus("loading");
    try {
      const result = await savePreparedFilesThroughBrowser(preparedBrowserSave);
      setNotice(browserSaveNotice(result));
      setDownloadStatus("success");
    } catch (err) {
      if (isBrowserSaveDismissed(err)) {
        setDownloadStatus("idle");
        setNotice("Ready to save. Tap Save to Files to open the system save sheet.");
        return;
      }
      setDownloadStatus("error");
      setError(err instanceof Error ? err.message : "Failed to save files");
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
            <input value={spotifyUrl} onChange={(e) => setSpotifyUrl(e.target.value)} className="flex-1 border border-white/25 rounded-2xl px-4 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50" placeholder="Spotify playlist, album, or Liked Songs URL" />
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

          {/* Format and Quality Settings */}
          {(spotifyTrack || batchInfo) && (
            <div className="rounded-3xl border border-white/20 bg-white/[0.02] p-6 space-y-4">
              <h3 className="text-lg font-semibold">Download Settings</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm mb-2 text-foreground/80">Output Format</label>
                  <select
                    value={outputFormat}
                    onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}
                    className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                  >
                    <option value="flac">FLAC (Lossless)</option>
                    {getSupportedFormats().includes("mp3") && <option value="mp3">MP3 320kbps</option>}
                    {getSupportedFormats().includes("aac") && <option value="aac">AAC (M4A)</option>}
                    {getSupportedFormats().includes("ogg") && <option value="ogg">OGG Vorbis</option>}
                    {getSupportedFormats().includes("opus") && <option value="opus">Opus</option>}
                    {getSupportedFormats().includes("wav") && <option value="wav">WAV (Uncompressed)</option>}
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-2 text-foreground/80">Quality Profile</label>
                  <select
                    value={qualityProfile}
                    onChange={(e) => setQualityProfile(e.target.value as QualityProfile)}
                    className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                  >
                    <option value="cd">CD Quality (16-bit/44.1kHz)</option>
                    <option value="hires48">Hi-Res (24-bit/48kHz)</option>
                    <option value="max">Maximum Available</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm mb-2 text-foreground/80">Download Provider</label>
                  <select
                    value={downloadProvider}
                    onChange={(e) => setDownloadProvider(e.target.value as DownloadProvider)}
                    className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
                  >
                    <option value="auto">Auto (Best Available)</option>
                    <option value="qobuz">Qobuz</option>
                    <option value="tidal">Tidal</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Batch Info Display */}
          {batchInfo && (
            <div className="rounded-3xl border border-white/20 bg-white/[0.02] p-6">
              <h3 className="text-xl font-semibold mb-4">Batch Download</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Type:</span>
                  <span className="font-medium capitalize">{batchInfo.type}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Title:</span>
                  <span className="font-medium">{batchInfo.title}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Artist:</span>
                  <span className="font-medium">{batchInfo.artist}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Tracks:</span>
                  <span className="font-medium">{batchInfo.trackCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/70">Format:</span>
                  <span className="font-medium uppercase">{batchInfo.format}</span>
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button
                  type="button"
                  onClick={handleBatchDownload}
                  disabled={batchStatus === "loading"}
                  className="flex-1 h-11 rounded-2xl bg-yellow-500 text-black font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2"
                >
                  {batchStatus === "loading" ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  Download All ({batchInfo.trackCount} tracks)
                  <ActionIcon status={batchStatus} />
                </button>
              </div>
              {batchProgress && (
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-foreground/70 truncate pr-3">
                      {batchProgress.currentTrack || "Starting..."}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {batchProgress.current}/{batchProgress.total}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className="h-full bg-yellow-500 transition-all duration-300"
                      style={{
                        width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="text-xs text-foreground/60">
                    {batchProgress.succeeded} downloaded · {batchProgress.skipped} skipped · {batchProgress.failed} failed
                  </div>
                </div>
              )}
              {batchFailures.length > 0 && (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-red-400">
                    {batchFailures.length} track{batchFailures.length === 1 ? "" : "s"} failed
                  </summary>
                  <ul className="mt-2 space-y-1 text-foreground/70 max-h-40 overflow-y-auto">
                    {batchFailures.map((failure) => (
                      <li key={failure}>{failure}</li>
                    ))}
                  </ul>
                </details>
              )}
              {notice && <div className="text-sm text-green-500 mt-4">{notice}</div>}
            </div>
          )}

          {/* Single Track Display */}
          {spotifyTrack && !batchInfo && (
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
                    {preparedBrowserSave && (
                      <button type="button" onClick={handleSavePreparedToFiles} disabled={downloadStatus === "loading"} className="h-11 flex-1 justify-center rounded-2xl border px-5 font-semibold inline-flex items-center gap-2 disabled:opacity-50 sm:flex-none">
                        <Download size={16} />
                        Save to Files
                      </button>
                    )}
                    {spotifyTrack.previewUrl && (
                      <button type="button" onClick={handlePreviewToggle} className="h-11 w-11 rounded-2xl border inline-flex items-center justify-center" aria-label={isPreviewPlaying ? "Stop preview" : "Play preview"}>
                        {isPreviewPlaying ? <Pause size={16} /> : <Play size={16} />}
                      </button>
                    )}
                  </div>
                  {notice && <div className="text-sm text-green-500">{notice}</div>}
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
