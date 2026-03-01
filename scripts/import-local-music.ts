#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { importLocalLibrary } from "@/lib/local-library";

type CliOptions = {
  sourceDir?: string;
  userId?: string;
  userEmail?: string;
  includeCoverFiles: boolean;
  includeLyricsFiles: boolean;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sourceDir: undefined,
    userId: undefined,
    userEmail: undefined,
    includeCoverFiles: env.LOCAL_IMPORT_USE_COVER_FILES,
    includeLyricsFiles: env.LOCAL_IMPORT_USE_LYRICS_FILES,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--source" && argv[i + 1]) {
      options.sourceDir = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--user-id" && argv[i + 1]) {
      options.userId = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--user-email" && argv[i + 1]) {
      options.userEmail = argv[i + 1].toLowerCase();
      i += 1;
      continue;
    }

    if (arg === "--no-covers") {
      options.includeCoverFiles = false;
      continue;
    }

    if (arg === "--no-lyrics") {
      options.includeLyricsFiles = false;
      continue;
    }
  }

  return options;
}

async function ensureImportUser(userEmail: string): Promise<string> {
  const existing = (await (db`
    SELECT "id"
    FROM "User"
    WHERE "email" = ${userEmail}
    LIMIT 1
  ` as any)) as Array<{ id: string }>;
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

async function resolveUserId(options: CliOptions): Promise<string> {
  if (options.userId) {
    const rows = (await (db`
      SELECT "id"
      FROM "User"
      WHERE "id" = ${options.userId}
      LIMIT 1
    ` as any)) as Array<{ id: string }>;
    if (rows[0]?.id) {
      return rows[0].id;
    }
  }

  if (options.userEmail) {
    const rows = (await (db`
      SELECT "id"
      FROM "User"
      WHERE "email" = ${options.userEmail}
      LIMIT 1
    ` as any)) as Array<{ id: string }>;
    if (rows[0]?.id) {
      return rows[0].id;
    }
    return ensureImportUser(options.userEmail);
  }

  const rows = (await (db`
    SELECT "id"
    FROM "User"
    ORDER BY "createdAt" ASC
    LIMIT 1
  ` as any)) as Array<{ id: string }>;
  if (rows[0]?.id) {
    return rows[0].id;
  }
  return ensureImportUser("local-library@waveform.local");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const userId = await resolveUserId(options);

  const summary = await importLocalLibrary({
    userId,
    sourceDir: options.sourceDir || env.LOCAL_MUSIC_SOURCE_DIR,
    includeCoverFiles: options.includeCoverFiles,
    includeLyricsFiles: options.includeLyricsFiles,
  });

  console.log(JSON.stringify({ userId, ...summary }, null, 2));
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  })
  .finally(async () => {
    await db.end({ timeout: 5 });
  });
