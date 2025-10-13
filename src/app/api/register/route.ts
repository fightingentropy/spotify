import { NextResponse } from "next/server";
import { hash } from "bcryptjs";
import { db } from "@/lib/db";
import type { UserRow } from "@/lib/db-types";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { name, email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }
  const normalizedEmail = String(email).toLowerCase();
  const existingUsers =
    await db<UserRow>`
      SELECT "id"
      FROM "User"
      WHERE "email" = ${normalizedEmail}
      LIMIT 1
    `;
  const existing = existingUsers.at(0);
  if (existing) {
    return NextResponse.json({ error: "Email already in use" }, { status: 409 });
  }
  const passwordHash = await hash(String(password), 10);
  const userId = randomUUID();
  await db`
    INSERT INTO "User" ("id", "email", "name", "passwordHash", "image", "emailVerified", "createdAt", "updatedAt")
    VALUES (${userId}, ${normalizedEmail}, ${name ? String(name) : null}, ${passwordHash}, NULL, NULL, NOW(), NOW())
  `;
  return NextResponse.json({ ok: true }, { status: 201 });
}
