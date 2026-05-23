import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/auth";
import { env } from "@/lib/env";
import { discoverMusicLibrary } from "@/lib/local-library";

export const dynamic = "force-dynamic";

type ImportPayload = {
  sourceDir?: unknown;
  includeCoverFiles?: unknown;
  includeLyricsFiles?: unknown;
};

export async function GET() {
  return NextResponse.json({
    sourceDir: env.LOCAL_MUSIC_SOURCE_DIR,
    copyFiles: env.LOCAL_MUSIC_COPY_FILES,
    includeCoverFiles: env.LOCAL_IMPORT_USE_COVER_FILES,
    includeLyricsFiles: env.LOCAL_IMPORT_USE_LYRICS_FILES,
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ImportPayload = {};
  try {
    body = (await req.json()) as ImportPayload;
  } catch {
    body = {};
  }

  const sourceDir =
    typeof body.sourceDir === "string" && body.sourceDir.trim().length > 0
      ? body.sourceDir.trim()
      : env.LOCAL_MUSIC_SOURCE_DIR;
  const includeCoverFiles =
    typeof body.includeCoverFiles === "boolean"
      ? body.includeCoverFiles
      : env.LOCAL_IMPORT_USE_COVER_FILES;
  const includeLyricsFiles =
    typeof body.includeLyricsFiles === "boolean"
      ? body.includeLyricsFiles
      : env.LOCAL_IMPORT_USE_LYRICS_FILES;

  try {
    const summary = await discoverMusicLibrary({
      userId,
      sourceDir,
      includeCoverFiles,
      includeLyricsFiles,
    });

    if (summary.mode === "organized" && summary.organized) {
      return NextResponse.json({
        mode: "organized",
        ...summary.organized,
      });
    }

    return NextResponse.json({
      mode: "import",
      ...(summary.imported ?? {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import failed";
    const status = message.includes("Source music directory not found")
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
