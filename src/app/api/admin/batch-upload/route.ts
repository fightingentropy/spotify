import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { importLocalLibrary } from "@/lib/local-library";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type BatchPayload = {
  sourceDir?: unknown;
  includeCoverFiles?: unknown;
  includeLyricsFiles?: unknown;
  userId?: unknown;
  userEmail?: unknown;
};

async function ensureImportUser(userEmail: string): Promise<string> {
  const existing = await db<{ id: string }>`
    SELECT "id"
    FROM "User"
    WHERE "email" = ${userEmail}
    LIMIT 1
  `;
  if (existing[0]?.id) {
    return existing[0].id;
  }

  const userId = randomUUID();
  await db`
    INSERT INTO "User" (
      "id",
      "email",
      "name",
      "passwordHash",
      "image",
      "emailVerified",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${userId},
      ${userEmail},
      ${"Local Library"},
      ${null},
      ${null},
      ${null},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `;
  return userId;
}

async function resolveTargetUserId(payload: BatchPayload): Promise<string> {
  const requestedUserId =
    typeof payload.userId === "string" && payload.userId.trim().length > 0
      ? payload.userId.trim()
      : null;

  if (requestedUserId) {
    const rows = await db<{ id: string }>`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${requestedUserId}
      LIMIT 1
    `;
    if (rows[0]?.id) {
      return rows[0].id;
    }
  }

  const requestedEmail =
    typeof payload.userEmail === "string" && payload.userEmail.trim().length > 0
      ? payload.userEmail.trim().toLowerCase()
      : null;

  if (requestedEmail) {
    const rows = await db<{ id: string }>`
      SELECT "id"
      FROM "User"
      WHERE "email" = ${requestedEmail}
      LIMIT 1
    `;
    if (rows[0]?.id) {
      return rows[0].id;
    }
    return ensureImportUser(requestedEmail);
  }

  const fallbackRows = await db<{ id: string }>`
    SELECT "id"
    FROM "User"
    ORDER BY "createdAt" ASC
    LIMIT 1
  `;

  if (fallbackRows[0]?.id) {
    return fallbackRows[0].id;
  }
  return ensureImportUser("local-library@waveform.local");
}

export async function POST(req: Request) {
  const rate = rateLimit(req, {
    keyPrefix: "admin-batch-upload",
    max: env.RATE_LIMIT_ADMIN_MAX,
    windowMs: env.RATE_LIMIT_ADMIN_WINDOW_MS,
  });
  if (!rate.allowed) {
    const headers = rateLimitHeaders(rate);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers },
    );
  }

  const provided = req.headers.get("x-admin-secret") || "";
  if (!provided || provided !== env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: BatchPayload = {};
  try {
    payload = (await req.json()) as BatchPayload;
  } catch {
    payload = {};
  }

  const targetUserId = await resolveTargetUserId(payload);

  const sourceDir =
    typeof payload.sourceDir === "string" && payload.sourceDir.trim().length > 0
      ? payload.sourceDir.trim()
      : env.LOCAL_MUSIC_SOURCE_DIR;

  const includeCoverFiles =
    typeof payload.includeCoverFiles === "boolean"
      ? payload.includeCoverFiles
      : env.LOCAL_IMPORT_USE_COVER_FILES;

  const includeLyricsFiles =
    typeof payload.includeLyricsFiles === "boolean"
      ? payload.includeLyricsFiles
      : env.LOCAL_IMPORT_USE_LYRICS_FILES;

  try {
    const summary = await importLocalLibrary({
      userId: targetUserId,
      sourceDir,
      includeCoverFiles,
      includeLyricsFiles,
    });

    return NextResponse.json({
      userId: targetUserId,
      ...summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Batch import failed";
    const status = message.includes("Source music directory not found")
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
