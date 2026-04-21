import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import type { UserRow } from "@/lib/db-types";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { rateLimit, rateLimitHeaders } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const rate = rateLimit(req, {
    keyPrefix: "register",
    max: env.RATE_LIMIT_REGISTER_MAX,
    windowMs: env.RATE_LIMIT_REGISTER_WINDOW_MS,
  });
  if (!rate.allowed) {
    console.warn("[security] register rate limit exceeded", { ip: rate.ip });
    const headers = rateLimitHeaders(rate);
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers },
    );
  }

  console.info("[security] register attempt", { ip: rate.ip });
  const { name, email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }
  const passwordStr = String(password);
  // Guard bcrypt CPU work against arbitrarily long inputs. bcrypt itself
  // silently truncates at 72 bytes, so anything longer is both wasteful
  // and a potential DoS vector.
  if (passwordStr.length < 8 || passwordStr.length > 128) {
    return NextResponse.json(
      { error: "Password must be 8–128 characters" },
      { status: 400 },
    );
  }
  const normalizedEmail = String(email).toLowerCase();
  const existingUsers = await db<UserRow>`
    SELECT "id"
    FROM "User"
    WHERE "email" = ${normalizedEmail}
    LIMIT 1
  `;
  const existing = existingUsers.at(0);
  if (existing) {
    return NextResponse.json(
      { error: "Email already in use" },
      { status: 409 },
    );
  }
  const passwordHash = await hash(passwordStr, 10);
  const userId = randomUUID();
  await db`
    INSERT INTO "User" ("id", "email", "name", "passwordHash", "image", "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${normalizedEmail}, ${name ? String(name) : null}, ${passwordHash}, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `;
  console.info("[security] register success", { ip: rate.ip });
  return NextResponse.json({ ok: true }, { status: 201 });
}
