import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/auth";
import { basename, extname, join } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { putObjectFromStream } from "@/lib/storage";
import { db } from "@/lib/db";
import type { SongRow } from "@/lib/db-types";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadedFile = {
  fileName: string;
  key: string;
  contentType: string;
};

type UploadFailure = {
  status: number;
  message: string;
};

const IMAGE_EXT_TYPES = new Map<string, string>([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const AUDIO_EXT_TYPES = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".mpeg", "audio/mpeg"],
  [".wav", "audio/wav"],
]);

const IMAGE_MIME_TYPES = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const AUDIO_MIME_TYPES = new Set<string>([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
]);

const MAX_IMAGE_BYTES = env.UPLOAD_MAX_IMAGE_BYTES;
const MAX_AUDIO_BYTES = env.UPLOAD_MAX_AUDIO_BYTES;

class UploadError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb * 10) / 10} MB`;
  return `${bytes} bytes`;
}

function sanitizeFileName(fileName: string): string {
  const base = basename(fileName || "upload");
  const safe = base.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return safe || "upload";
}

function resolveUploadConfig(
  fieldName: "image" | "audio",
  mimeType: string,
  fileName: string,
): { contentType: string; maxBytes: number; prefix: string } | null {
  const ext = extname(fileName).toLowerCase();
  if (fieldName === "image") {
    const extType = IMAGE_EXT_TYPES.get(ext);
    const lower = mimeType.toLowerCase();
    if (IMAGE_MIME_TYPES.has(lower)) {
      return {
        contentType: lower,
        maxBytes: MAX_IMAGE_BYTES,
        prefix: "images",
      };
    }
    if (extType) {
      return {
        contentType: extType,
        maxBytes: MAX_IMAGE_BYTES,
        prefix: "images",
      };
    }
    return null;
  }
  const lower = mimeType.toLowerCase();
  if (AUDIO_MIME_TYPES.has(lower)) {
    const normalized =
      lower === "audio/mp3"
        ? "audio/mpeg"
        : lower === "audio/x-wav" || lower === "audio/wave"
          ? "audio/wav"
          : lower;
    return {
      contentType: normalized,
      maxBytes: MAX_AUDIO_BYTES,
      prefix: "audio",
    };
  }
  const extType = AUDIO_EXT_TYPES.get(ext);
  if (extType) {
    return { contentType: extType, maxBytes: MAX_AUDIO_BYTES, prefix: "audio" };
  }
  return null;
}

function createByteLimiter(maxBytes: number, label: string) {
  let total = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(
          new UploadError(`${label} exceeds ${formatBytes(maxBytes)}`, 413),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

async function uploadStreamWithLimit(
  file: NodeJS.ReadableStream,
  key: string,
  contentType: string,
  maxBytes: number,
  label: string,
): Promise<void> {
  const limiter = createByteLimiter(maxBytes, label);
  const pass = new PassThrough();
  const upload = putObjectFromStream(key, pass, contentType);
  await Promise.all([upload, pipeline(file, limiter, pass)]);
}

async function parseMultipartUpload(req: Request): Promise<{
  data?: {
    title: string;
    artist: string;
    image: UploadedFile;
    audio: UploadedFile;
  };
  error?: UploadFailure;
}> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return { error: { status: 400, message: "Expected multipart/form-data" } };
  }
  if (!req.body) {
    return { error: { status: 400, message: "Missing request body" } };
  }

  const busboy = Busboy({
    headers: { "content-type": contentType },
    limits: {
      files: 2,
      fields: 10,
      fieldSize: 1024,
    },
  });

  let title = "";
  let artist = "";
  let image: UploadedFile | null = null;
  let audio: UploadedFile | null = null;
  let failure: UploadFailure | null = null;
  const uploads: Promise<void>[] = [];

  const setFailure = (message: string, status: number) => {
    if (!failure) failure = { message, status };
  };

  busboy.on("field", (name, value) => {
    if (name === "title") title = String(value).trim();
    if (name === "artist") artist = String(value).trim();
  });

  busboy.on("file", (name, file, info) => {
    if (failure) {
      file.resume();
      return;
    }
    if (name !== "image" && name !== "audio") {
      file.resume();
      return;
    }
    if (name === "image" && image) {
      setFailure("Only one image file is allowed", 400);
      file.resume();
      return;
    }
    if (name === "audio" && audio) {
      setFailure("Only one audio file is allowed", 400);
      file.resume();
      return;
    }

    const originalName =
      typeof info.filename === "string" ? info.filename : "upload";
    const safeName = sanitizeFileName(originalName);
    const config = resolveUploadConfig(name, info.mimeType || "", safeName);

    if (!config) {
      setFailure(
        name === "image" ? "Unsupported image type" : "Unsupported audio type",
        415,
      );
      file.resume();
      return;
    }

    const fileId = randomUUID();
    const fileName = `${fileId}-${safeName}`;
    const key = join(config.prefix, fileName).replaceAll("\\", "/");
    const label = name === "image" ? "Image file" : "Audio file";
    const uploadPromise = uploadStreamWithLimit(
      file,
      key,
      config.contentType,
      config.maxBytes,
      label,
    ).catch((err) => {
      if (err instanceof UploadError) {
        setFailure(err.message, err.status);
      } else {
        setFailure("Upload failed", 500);
      }
    });
    uploads.push(uploadPromise);

    if (name === "image") {
      image = { fileName, key, contentType: config.contentType };
    } else {
      audio = { fileName, key, contentType: config.contentType };
    }
  });

  let busboyError: Error | null = null;
  const finished = new Promise<void>((resolve) => {
    busboy.on("finish", resolve);
    busboy.on("error", (err) => {
      busboyError = err instanceof Error ? err : new Error("Busboy error");
      resolve();
    });
  });

  const bodyStream = Readable.fromWeb(
    req.body as unknown as ReadableStream<Uint8Array>,
  );
  bodyStream.pipe(busboy);

  await finished;

  await Promise.all(uploads);

  if (busboyError && !failure) {
    return { error: { status: 400, message: "Invalid multipart upload" } };
  }

  if (!failure && (!title || !artist || !image || !audio)) {
    setFailure("Missing fields", 400);
  }

  if (failure) {
    return { error: failure };
  }

  return { data: { title, artist, image: image!, audio: audio! } };
}

export async function GET() {
  const songs = (await (db`
    SELECT "id", "title", "artist", "imageUrl", "audioUrl", "userId", "createdAt"
    FROM "Song"
    ORDER BY "title" ASC
  ` as any)) as SongRow[];
  return NextResponse.json(songs);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  type AppSession = Session & {
    user: NonNullable<Session["user"]> & { id: string };
  };
  const s = session as AppSession | null;
  if (!s?.user?.email || !s.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = await parseMultipartUpload(req);
  if (parsed.error) {
    return NextResponse.json(
      { error: parsed.error.message },
      { status: parsed.error.status },
    );
  }

  const { title, artist, image, audio } = parsed.data!;
  const imageUrl = `/api/files/images/${encodeURIComponent(image.fileName)}`;
  const audioUrl = `/api/files/audio/${encodeURIComponent(audio.fileName)}`;

  const userId = s.user.id;
  const songId = randomUUID();
  const [song] = (await (db`
    INSERT INTO "Song" ("id", "title", "artist", "imageUrl", "audioUrl", "userId")
    VALUES (${songId}, ${title}, ${artist}, ${imageUrl}, ${audioUrl}, ${userId})
    RETURNING "id", "title", "artist", "imageUrl", "audioUrl", "userId", "createdAt"
  ` as any)) as SongRow[];

  return NextResponse.json(song, { status: 201 });
}
