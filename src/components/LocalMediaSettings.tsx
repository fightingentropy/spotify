"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ImportDefaults = {
  sourceDir: string;
  includeCoverFiles: boolean;
  includeLyricsFiles: boolean;
};

type ImportSummary = {
  sourceDir: string;
  scanned: number;
  imported: number;
  updated: number;
  converted: number;
  skipped: number;
  errors: Array<{ file: string; message: string }>;
};

type SongOption = {
  id: string;
  title: string;
  artist: string;
  imageUrl: string;
  lyricsUrl?: string | null;
};

const SOURCE_DIR_KEY = "wf_source_dir";
const COVER_FILES_KEY = "wf_import_covers";
const LYRICS_FILES_KEY = "wf_import_lyrics";

export default function LocalMediaSettings() {
  const [sourceDir, setSourceDir] = useState("/Users/erlinhoxha/Music");
  const [includeCoverFiles, setIncludeCoverFiles] = useState(true);
  const [includeLyricsFiles, setIncludeLyricsFiles] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  const [songs, setSongs] = useState<SongOption[]>([]);
  const [selectedSongId, setSelectedSongId] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [lyricsFile, setLyricsFile] = useState<File | null>(null);
  const [lyricsText, setLyricsText] = useState("");
  const [savingAssets, setSavingAssets] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [assetSuccess, setAssetSuccess] = useState<string | null>(null);

  const loadSongs = useCallback(async () => {
    const res = await fetch("/api/songs", { cache: "no-store" });
    if (!res.ok) {
      throw new Error("Failed to load songs");
    }
    const items = (await res.json()) as SongOption[];
    setSongs(items);
    setSelectedSongId((current) => current || items[0]?.id || "");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadDefaults() {
      try {
        const localSource = localStorage.getItem(SOURCE_DIR_KEY);
        const localCover = localStorage.getItem(COVER_FILES_KEY);
        const localLyrics = localStorage.getItem(LYRICS_FILES_KEY);

        const res = await fetch("/api/library/import", { cache: "no-store" });
        const defaults = (res.ok
          ? ((await res.json()) as ImportDefaults)
          : {
              sourceDir: "/Users/erlinhoxha/Music",
              includeCoverFiles: true,
              includeLyricsFiles: true,
            }) as ImportDefaults;

        if (cancelled) return;

        setSourceDir(localSource || defaults.sourceDir || "/Users/erlinhoxha/Music");
        setIncludeCoverFiles(
          localCover === null ? !!defaults.includeCoverFiles : localCover === "1",
        );
        setIncludeLyricsFiles(
          localLyrics === null ? !!defaults.includeLyricsFiles : localLyrics === "1",
        );
      } catch {
        if (!cancelled) {
          setSourceDir(localStorage.getItem(SOURCE_DIR_KEY) || "/Users/erlinhoxha/Music");
          setIncludeCoverFiles(localStorage.getItem(COVER_FILES_KEY) !== "0");
          setIncludeLyricsFiles(localStorage.getItem(LYRICS_FILES_KEY) !== "0");
        }
      }
    }

    loadDefaults();
    loadSongs().catch(() => {
      if (!cancelled) {
        setAssetError("Failed to load songs for media updates.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadSongs]);

  useEffect(() => {
    localStorage.setItem(SOURCE_DIR_KEY, sourceDir);
  }, [sourceDir]);

  useEffect(() => {
    localStorage.setItem(COVER_FILES_KEY, includeCoverFiles ? "1" : "0");
  }, [includeCoverFiles]);

  useEffect(() => {
    localStorage.setItem(LYRICS_FILES_KEY, includeLyricsFiles ? "1" : "0");
  }, [includeLyricsFiles]);

  const selectedSong = useMemo(
    () => songs.find((song) => song.id === selectedSongId) ?? null,
    [songs, selectedSongId],
  );

  const runImport = useCallback(async () => {
    setImporting(true);
    setImportError(null);
    setImportSummary(null);

    try {
      const res = await fetch("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceDir,
          includeCoverFiles,
          includeLyricsFiles,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || "Import failed");
      }

      setImportSummary(data as ImportSummary);
      await loadSongs();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }, [includeCoverFiles, includeLyricsFiles, loadSongs, sourceDir]);

  const saveAssets = useCallback(async () => {
    if (!selectedSongId) {
      setAssetError("Choose a song first.");
      return;
    }

    if (!coverFile && !lyricsFile && !lyricsText.trim()) {
      setAssetError("Add a cover or lyrics first.");
      return;
    }

    setSavingAssets(true);
    setAssetError(null);
    setAssetSuccess(null);

    try {
      const form = new FormData();
      if (coverFile) {
        form.append("image", coverFile);
      }
      if (lyricsFile) {
        form.append("lyricsFile", lyricsFile);
      }
      if (lyricsText.trim()) {
        form.append("lyricsText", lyricsText.trim());
      }

      const res = await fetch(`/api/songs/${encodeURIComponent(selectedSongId)}/assets`, {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || "Failed to update song assets");
      }

      setCoverFile(null);
      setLyricsFile(null);
      setLyricsText("");
      setAssetSuccess("Song media updated.");
      await loadSongs();
    } catch (error) {
      setAssetError(
        error instanceof Error ? error.message : "Failed to update song assets",
      );
    } finally {
      setSavingAssets(false);
    }
  }, [coverFile, loadSongs, lyricsFile, lyricsText, selectedSongId]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium mb-2">Local Library Import</h2>
        <div className="rounded border border-black/10 dark:border-white/10 p-4 space-y-4">
          <div>
            <label className="block text-sm mb-1">Music source directory</label>
            <input
              value={sourceDir}
              onChange={(event) => setSourceDir(event.target.value)}
              className="w-full border rounded px-3 py-2 bg-transparent"
              placeholder="/Users/erlinhoxha/Music"
            />
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeCoverFiles}
              onChange={(event) => setIncludeCoverFiles(event.target.checked)}
            />
            <span>Use sidecar cover files (cover/folder/song-name images)</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeLyricsFiles}
              onChange={(event) => setIncludeLyricsFiles(event.target.checked)}
            />
            <span>Use sidecar lyrics files (.lrc/.txt)</span>
          </label>

          <button
            type="button"
            onClick={runImport}
            disabled={importing}
            className="h-10 px-4 rounded bg-foreground text-background disabled:opacity-50"
          >
            {importing ? "Importing…" : "Import from local folder"}
          </button>

          {importError && <div className="text-sm text-red-600">{importError}</div>}

          {importSummary && (
            <div className="text-sm space-y-1">
              <div>
                Source: <span className="opacity-80">{importSummary.sourceDir}</span>
              </div>
              <div>
                Scanned: {importSummary.scanned} | Imported: {importSummary.imported} | Updated: {importSummary.updated}
              </div>
              <div>
                Converted to FLAC: {importSummary.converted} | Skipped: {importSummary.skipped}
              </div>
              {importSummary.errors.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium">Errors ({importSummary.errors.length})</div>
                  <div className="max-h-32 overflow-auto rounded border border-black/10 dark:border-white/10 p-2 text-xs">
                    {importSummary.errors.slice(0, 10).map((item, idx) => (
                      <div key={`${item.file}-${idx}`} className="mb-1 break-all">
                        {item.file}: {item.message}
                      </div>
                    ))}
                    {importSummary.errors.length > 10 && (
                      <div>Showing first 10 errors.</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-medium mb-2">Song Cover And Lyrics</h2>
        <div className="rounded border border-black/10 dark:border-white/10 p-4 space-y-4">
          <div>
            <label className="block text-sm mb-1">Song</label>
            <select
              value={selectedSongId}
              onChange={(event) => setSelectedSongId(event.target.value)}
              className="w-full border rounded px-3 py-2 bg-transparent"
            >
              {songs.length === 0 && <option value="">No songs available</option>}
              {songs.map((song) => (
                <option key={song.id} value={song.id}>
                  {song.title} - {song.artist}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm mb-1">Cover image</label>
            <input
              type="file"
              accept="image/*"
              onChange={(event) => setCoverFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Lyrics file (.txt, .lrc)</label>
            <input
              type="file"
              accept=".txt,.lrc,text/plain"
              onChange={(event) => setLyricsFile(event.target.files?.[0] ?? null)}
            />
          </div>

          <div>
            <label className="block text-sm mb-1">Lyrics text</label>
            <textarea
              value={lyricsText}
              onChange={(event) => setLyricsText(event.target.value)}
              rows={6}
              className="w-full border rounded px-3 py-2 bg-transparent"
              placeholder="Optional: paste lyrics here"
            />
          </div>

          {selectedSong && (
            <div className="text-xs opacity-70">
              Current cover: {selectedSong.imageUrl || "none"}
              <br />
              Current lyrics: {selectedSong.lyricsUrl || "none"}
            </div>
          )}

          {assetError && <div className="text-sm text-red-600">{assetError}</div>}
          {assetSuccess && <div className="text-sm text-emerald-600">{assetSuccess}</div>}

          <button
            type="button"
            onClick={saveAssets}
            disabled={savingAssets || songs.length === 0}
            className="h-10 px-4 rounded bg-foreground text-background disabled:opacity-50"
          >
            {savingAssets ? "Saving…" : "Save song media"}
          </button>
        </div>
      </div>
    </div>
  );
}
