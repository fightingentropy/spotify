"use client";

import { useCallback, useEffect, useState } from "react";

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

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SOURCE_DIR_KEY, sourceDir);
  }, [sourceDir]);

  useEffect(() => {
    localStorage.setItem(COVER_FILES_KEY, includeCoverFiles ? "1" : "0");
  }, [includeCoverFiles]);

  useEffect(() => {
    localStorage.setItem(LYRICS_FILES_KEY, includeLyricsFiles ? "1" : "0");
  }, [includeLyricsFiles]);

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
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }, [includeCoverFiles, includeLyricsFiles, sourceDir]);

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
    </div>
  );
}
