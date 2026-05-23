import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { discoverMusicLibrary } from "@/lib/local-library";
import { getMusicSourceDirectoryCandidates } from "@/lib/storage";

const LIBRARY_USER_EMAIL = "library@waveform.local";
let syncPromise: Promise<void> | null = null;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveLibraryUserId(): Promise<string | null> {
  const existing = await db<{ id: string }>`
    SELECT "id"
    FROM "User"
    ORDER BY "createdAt" ASC
    LIMIT 1
  `;
  if (existing[0]?.id) {
    return existing[0].id;
  }

  const libraryUser = await db<{ id: string }>`
    SELECT "id"
    FROM "User"
    WHERE "email" = ${LIBRARY_USER_EMAIL}
    LIMIT 1
  `;
  if (libraryUser[0]?.id) {
    return libraryUser[0].id;
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
      ${LIBRARY_USER_EMAIL},
      ${"Music Library"},
      ${null},
      ${null},
      ${null},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
  `;
  return userId;
}

async function hasMusicToScan(): Promise<boolean> {
  const { getCloudflareBindings } = await import("@/lib/cloudflare");
  if (await getCloudflareBindings()) {
    return false;
  }

  for (const candidate of getMusicSourceDirectoryCandidates()) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isDirectory()) {
      return true;
    }
  }
  return false;
}

async function runMusicSync(): Promise<void> {
  if (!(await hasMusicToScan())) {
    return;
  }

  const userId = await resolveLibraryUserId();
  if (!userId) {
    return;
  }

  const summary = await discoverMusicLibrary({ userId });
  if (summary.mode === "organized" && summary.organized) {
    console.info(
      `[waveform] indexed ${summary.organized.imported + summary.organized.updated} songs from ${summary.organized.musicRoot}`,
    );
    return;
  }

  if (summary.imported) {
    console.info(
      `[waveform] ${env.LOCAL_MUSIC_COPY_FILES ? "imported" : "indexed"} ${summary.imported.imported + summary.imported.updated} songs from ${summary.imported.sourceDir}`,
    );
  }
}

export function syncMusicLibraryOnStartup(): Promise<void> {
  if (!syncPromise) {
    syncPromise = runMusicSync().catch((error) => {
      syncPromise = null;
      console.error("[waveform] music library sync failed:", error);
    });
  }
  return syncPromise;
}

export async function ensureMusicLibrarySynced(): Promise<void> {
  await syncMusicLibraryOnStartup();
}

export function getDefaultMusicFolder(): string {
  return resolve(process.cwd(), "music");
}

export async function musicFolderExists(): Promise<boolean> {
  return pathExists(getDefaultMusicFolder());
}
