import { useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { FileAudio, Image as ImageIcon, Link2 } from "lucide-react-native";
import { Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/http";
import { invalidateLibraryApiCache } from "@/lib/api";
import { getOfflineAccountScope } from "@/store/offline";
import { type BatchInfo, type BatchTrack, isBatchSpotifyUrl, resolveSpotifyBatch } from "@/lib/spotify-batch-client";
import { colors } from "@/theme";

type Mode = "link" | "file";
type Status = { kind: "idle" | "busy" | "ok" | "error"; message?: string };
type BatchProgress = { current: number; total: number; currentTrack: string; succeeded: number; skipped: number; failed: number };

const inputStyle = { color: colors.foreground, height: 48, fontSize: 16, paddingHorizontal: 14, backgroundColor: "#1f1f1f", borderRadius: 8 } as const;

function normalizeTrackKey(title: string, artist: string): string {
  return `${artist} - ${title}`.toLowerCase().replace(/\s+/g, " ").trim();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function UploadScreen() {
  const { status: authStatus } = useAuth();
  const [mode, setMode] = useState<Mode>("link");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // link mode
  const [spotifyUrl, setSpotifyUrl] = useState("");
  // batch mode (album / playlist / Liked Songs)
  const [batchInfo, setBatchInfo] = useState<BatchInfo | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [batchFailures, setBatchFailures] = useState<string[]>([]);
  const [showFailures, setShowFailures] = useState(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  // file mode
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [audio, setAudio] = useState<{ uri: string; name: string; mimeType?: string } | null>(null);
  const [cover, setCover] = useState<{ uri: string; name: string; type: string } | null>(null);

  if (authStatus === "unauthenticated") {
    return (
      <Screen topInset={false}>
        <SignedOutPrompt message="Sign in to upload music." />
      </Screen>
    );
  }

  // Single-track import: POST /api/songs with the Spotify URL. The server resolves
  // metadata itself, so we only pass the URL + quality/format/region.
  const importSpotify = async () => {
    if (!spotifyUrl.trim()) return;
    setStatus({ kind: "busy", message: "Importing…" });
    try {
      const res = await apiFetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "spotify",
          spotifyUrl: spotifyUrl.trim(),
          qualityProfile: "max",
          outputFormat: "flac",
          region: "US",
          replaceExisting: false,
        }),
      });
      if (res.status === 409) {
        setStatus({ kind: "error", message: "This track is already in your library." });
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Import failed (${res.status})`);
      }
      invalidateLibraryApiCache(getOfflineAccountScope());
      setSpotifyUrl("");
      setStatus({ kind: "ok", message: "Added to your library." });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Import failed" });
    }
  };

  // "Fetch" entry point: album/playlist/collection URLs resolve to a batch card;
  // everything else falls through to the single-track import.
  const fetchSpotify = async () => {
    const url = spotifyUrl.trim();
    if (!url) return;
    setBatchInfo(null);
    setBatchProgress(null);
    setBatchFailures([]);
    setShowFailures(false);
    if (!isBatchSpotifyUrl(url)) {
      await importSpotify();
      return;
    }
    setStatus({ kind: "busy", message: "Fetching tracks…" });
    try {
      const info = await resolveSpotifyBatch(url);
      setBatchInfo(info);
      setStatus({ kind: "ok", message: `Found ${info.trackCount} tracks. Tap Download to start.` });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Failed to fetch batch info" });
    }
  };

  // Import one batch track via the same POST /api/songs shape as importSpotify.
  // Returns "skipped" on a 409 duplicate so the caller can tally it separately.
  const importBatchTrack = async (track: BatchTrack, signal: AbortSignal): Promise<"imported" | "skipped"> => {
    const res = await apiFetch("/api/songs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "spotify",
        spotifyUrl: `https://open.spotify.com/track/${track.spotifyId}`,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: String(track.durationMs || ""),
        imageUrl: track.imageUrl,
        qualityProfile: "max",
        outputFormat: "flac",
        region: "US",
        replaceExisting: false,
      }),
      signal,
    });
    if (res.status === 409) return "skipped";
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `Failed (${res.status})`);
    }
    return "imported";
  };

  const cancelBatchDownload = () => {
    batchAbortRef.current?.abort();
  };

  // Download every track in the resolved batch sequentially, pacing requests and
  // tracking succeeded / skipped (409) / failed counts. Cancel via AbortController.
  const downloadBatch = async () => {
    if (!batchInfo) return;
    // Guard against a double-tap while a run is already in flight.
    if (batchAbortRef.current && !batchAbortRef.current.signal.aborted) return;
    const controller = new AbortController();
    batchAbortRef.current = controller;
    const { signal } = controller;
    const tracks = batchInfo.tracks;
    const total = tracks.length;
    const knownKeys = new Set<string>();
    const failures: string[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let cancelled = false;

    setBatchFailures([]);
    setShowFailures(false);
    setStatus({ kind: "busy", message: "Downloading…" });
    setBatchProgress({ current: 0, total, currentTrack: "", succeeded: 0, skipped: 0, failed: 0 });

    for (let index = 0; index < tracks.length; index += 1) {
      if (signal.aborted) {
        cancelled = true;
        break;
      }
      const track = tracks[index];
      const label = `${track.artist} - ${track.title}`;
      setBatchProgress({ current: index + 1, total, currentTrack: label, succeeded, skipped, failed });

      const key = normalizeTrackKey(track.title, track.artist);
      if (knownKeys.has(key)) {
        skipped += 1;
        setBatchProgress({ current: index + 1, total, currentTrack: label, succeeded, skipped, failed });
        await delay(200);
        continue;
      }

      try {
        const result = await importBatchTrack(track, signal);
        knownKeys.add(key);
        if (result === "skipped") skipped += 1;
        else succeeded += 1;
      } catch (e) {
        if (signal.aborted) {
          cancelled = true;
          break;
        }
        failed += 1;
        failures.push(`${label}: ${e instanceof Error ? e.message : "Download failed"}`);
      }

      setBatchProgress({ current: index + 1, total, currentTrack: label, succeeded, skipped, failed });
      await delay(500);
    }

    if (succeeded > 0) invalidateLibraryApiCache(getOfflineAccountScope());
    setBatchFailures(failures);
    if (batchAbortRef.current === controller) batchAbortRef.current = null;
    const summary = `${succeeded} downloaded · ${skipped} skipped · ${failed} failed`;
    if (cancelled) setStatus({ kind: "ok", message: `Cancelled — ${summary}` });
    else if (failed > 0 && succeeded === 0) setStatus({ kind: "error", message: summary });
    else setStatus({ kind: "ok", message: `Done — ${summary}` });
  };

  const pickAudio = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: "audio/*", copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setAudio({ uri: a.uri, name: a.name, mimeType: a.mimeType });
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ""));
  };

  const pickCover = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (result.canceled || !result.assets[0]) return;
    const a = result.assets[0];
    setCover({ uri: a.uri, name: a.fileName ?? "cover.jpg", type: a.mimeType ?? "image/jpeg" });
  };

  const uploadFile = async () => {
    if (!audio || !title.trim() || !artist.trim()) {
      setStatus({ kind: "error", message: "Pick an audio file and enter title + artist." });
      return;
    }
    setStatus({ kind: "busy", message: "Uploading…" });
    try {
      const form = new FormData();
      form.append("audio", { uri: audio.uri, name: audio.name, type: audio.mimeType ?? "audio/mpeg" } as unknown as Blob);
      form.append("title", title.trim());
      form.append("artist", artist.trim());
      if (cover) form.append("image", { uri: cover.uri, name: cover.name, type: cover.type } as unknown as Blob);
      const res = await apiFetch("/api/songs", { method: "POST", body: form });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Upload failed (${res.status})`);
      }
      invalidateLibraryApiCache(getOfflineAccountScope());
      setAudio(null);
      setCover(null);
      setTitle("");
      setArtist("");
      setStatus({ kind: "ok", message: "Uploaded to your library." });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : "Upload failed" });
    }
  };

  return (
    <Screen topInset={false}>
      <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, gap: 16 }}>
        {/* mode toggle */}
        <View className="flex-row gap-2">
          {(["link", "file"] as Mode[]).map((m) => (
            <PressableScale
              key={m}
              scaleTo={1}
              onPress={() => {
                setMode(m);
                setStatus({ kind: "idle" });
              }}
              className="flex-1 flex-row items-center justify-center gap-2 rounded-full py-2.5"
              style={{ backgroundColor: mode === m ? colors.emerald : "#1f1f1f" }}
            >
              {m === "link" ? <Link2 size={18} color={mode === m ? "#fff" : colors.muted} /> : <FileAudio size={18} color={mode === m ? "#fff" : colors.muted} />}
              <Text className="font-semibold" style={{ color: mode === m ? "#fff" : colors.muted }}>
                {m === "link" ? "Spotify link" : "File"}
              </Text>
            </PressableScale>
          ))}
        </View>

        {mode === "link" ? (
          <View style={{ gap: 12 }}>
            <TextInput
              value={spotifyUrl}
              onChangeText={(v) => {
                setSpotifyUrl(v);
                if (batchInfo) setBatchInfo(null);
              }}
              placeholder="Track, album, playlist, or Liked Songs URL"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={inputStyle}
            />
            <PressableScale onPress={fetchSpotify} disabled={status.kind === "busy" || !spotifyUrl.trim()} className="items-center rounded-full py-3" style={{ backgroundColor: colors.green, opacity: status.kind === "busy" || !spotifyUrl.trim() ? 0.6 : 1 }}>
              <Text className="font-bold text-black">{status.kind === "busy" ? (batchInfo ? "Downloading…" : "Working…") : isBatchSpotifyUrl(spotifyUrl.trim()) ? "Fetch tracks" : "Add to library"}</Text>
            </PressableScale>

            {batchInfo ? (
              <View className="gap-4 rounded-2xl p-4" style={{ backgroundColor: "#1f1f1f" }}>
                <View className="gap-1">
                  <Text className="text-lg font-bold" numberOfLines={2} style={{ color: colors.foreground }}>{batchInfo.title}</Text>
                  <Text className="text-sm" style={{ color: colors.muted }}>
                    <Text className="capitalize">{batchInfo.type}</Text>
                    {batchInfo.artist ? ` · ${batchInfo.artist}` : ""}
                    {` · ${batchInfo.trackCount} track${batchInfo.trackCount === 1 ? "" : "s"}`}
                  </Text>
                </View>

                <View className="flex-row gap-2">
                  <PressableScale
                    onPress={downloadBatch}
                    disabled={status.kind === "busy"}
                    className="flex-1 items-center rounded-full py-3"
                    style={{ backgroundColor: colors.green, opacity: status.kind === "busy" ? 0.6 : 1 }}
                  >
                    <Text className="font-bold text-black">{status.kind === "busy" ? "Downloading…" : `Download ${batchInfo.trackCount} track${batchInfo.trackCount === 1 ? "" : "s"}`}</Text>
                  </PressableScale>
                  {status.kind === "busy" && batchProgress ? (
                    <PressableScale onPress={cancelBatchDownload} className="items-center justify-center rounded-full px-5 py-3" style={{ backgroundColor: "#333" }}>
                      <Text className="font-semibold" style={{ color: colors.foreground }}>Cancel</Text>
                    </PressableScale>
                  ) : null}
                </View>

                {batchProgress ? (
                  <View className="gap-2">
                    <View className="flex-row items-center justify-between gap-3">
                      <Text numberOfLines={1} className="flex-1 text-sm" style={{ color: colors.muted }}>
                        {batchProgress.currentTrack || "Starting…"}
                      </Text>
                      <Text className="text-sm" style={{ color: colors.muted, fontVariant: ["tabular-nums"] }}>
                        {batchProgress.current}/{batchProgress.total}
                      </Text>
                    </View>
                    <View className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
                      <View
                        className="h-full rounded-full"
                        style={{ backgroundColor: colors.emerald, width: `${batchProgress.total > 0 ? Math.round((batchProgress.current / batchProgress.total) * 100) : 0}%` }}
                      />
                    </View>
                    <Text className="text-xs" style={{ color: colors.muted }}>
                      {batchProgress.succeeded} downloaded · {batchProgress.skipped} skipped · {batchProgress.failed} failed
                    </Text>
                  </View>
                ) : null}

                {batchFailures.length > 0 ? (
                  <View className="gap-2">
                    <PressableScale scaleTo={1} onPress={() => setShowFailures((v) => !v)} className="self-start">
                      <Text className="text-sm font-medium" style={{ color: "#f87171" }}>
                        {batchFailures.length} track{batchFailures.length === 1 ? "" : "s"} failed{showFailures ? " ▲" : " ▼"}
                      </Text>
                    </PressableScale>
                    {showFailures ? (
                      <View className="gap-1">
                        {batchFailures.map((failure) => (
                          <Text key={failure} className="text-xs" style={{ color: colors.muted }}>{failure}</Text>
                        ))}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <PressableScale onPress={pickAudio} className="flex-row items-center gap-3 rounded-lg p-4" style={{ backgroundColor: "#1f1f1f" }}>
              <FileAudio size={22} color={colors.emerald} />
              <Text numberOfLines={1} className="flex-1" style={{ color: audio ? colors.foreground : colors.muted }}>
                {audio?.name ?? "Choose an audio file"}
              </Text>
            </PressableScale>
            <TextInput value={title} onChangeText={setTitle} placeholder="Title" placeholderTextColor={colors.muted} style={inputStyle} />
            <TextInput value={artist} onChangeText={setArtist} placeholder="Artist" placeholderTextColor={colors.muted} style={inputStyle} />
            <PressableScale onPress={pickCover} className="flex-row items-center gap-3 rounded-lg p-4" style={{ backgroundColor: "#1f1f1f" }}>
              {cover ? (
                <View className="h-12 w-12 overflow-hidden rounded">
                  <CoverImage src={cover.uri} style={{ width: "100%", height: "100%" }} />
                </View>
              ) : (
                <ImageIcon size={22} color={colors.muted} />
              )}
              <Text className="flex-1" style={{ color: cover ? colors.foreground : colors.muted }}>
                {cover ? "Cover selected" : "Choose a cover (optional)"}
              </Text>
            </PressableScale>
            <PressableScale onPress={uploadFile} disabled={status.kind === "busy"} className="items-center rounded-full py-3" style={{ backgroundColor: colors.green, opacity: status.kind === "busy" ? 0.6 : 1 }}>
              <Text className="font-bold text-black">{status.kind === "busy" ? "Uploading…" : "Upload"}</Text>
            </PressableScale>
          </View>
        )}

        {status.kind === "error" && status.message ? <ErrorText>{status.message}</ErrorText> : null}
        {status.kind === "ok" && status.message ? (
          <Text style={{ color: colors.emerald }} className="text-sm font-medium">{status.message}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
