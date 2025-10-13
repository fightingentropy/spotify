import { randomUUID } from "node:crypto";
import type {
  Adapter,
  AdapterAccount,
  AdapterSession,
  AdapterUser,
  VerificationToken,
} from "next-auth/adapters";
import { db } from "@/lib/db";
import type { SessionRow, UserRow, VerificationTokenRow } from "@/lib/db-types";

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function mapUser(row: UserRow): AdapterUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    emailVerified: toDate(row.emailVerified),
  };
}

function mapSession(row: SessionRow): AdapterSession {
  return {
    userId: row.userId,
    sessionToken: row.sessionToken,
    expires: row.expires instanceof Date ? row.expires : new Date(row.expires),
  };
}

export function PostgresAdapter(): Adapter {
  return {
    async createUser(user: Omit<AdapterUser, "id">) {
      const id = randomUUID();
      const [created] =
        await db<UserRow>`
          INSERT INTO "User" ("id", "name", "email", "image", "emailVerified", "passwordHash", "createdAt", "updatedAt")
          VALUES (${id}, ${user.name ?? null}, ${user.email}, ${user.image ?? null}, ${user.emailVerified ?? null}, NULL, NOW(), NOW())
          RETURNING "id", "name", "email", "image", "emailVerified", "passwordHash", "createdAt", "updatedAt"
        `;
      return mapUser(created);
    },

    async getUser(id) {
      const rows =
        await db<UserRow>`
          SELECT "id", "name", "email", "image", "emailVerified", "passwordHash", "createdAt", "updatedAt"
          FROM "User"
          WHERE "id" = ${id}
          LIMIT 1
        `;
      const row = rows.at(0);
      return row ? mapUser(row) : null;
    },

    async getUserByEmail(email) {
      const rows =
        await db<UserRow>`
          SELECT "id", "name", "email", "image", "emailVerified", "passwordHash", "createdAt", "updatedAt"
          FROM "User"
          WHERE "email" = ${email}
          LIMIT 1
        `;
      const row = rows.at(0);
      return row ? mapUser(row) : null;
    },

    async getUserByAccount(account) {
      const rows =
        await db<UserRow>`
          SELECT u."id", u."name", u."email", u."image", u."emailVerified", u."passwordHash", u."createdAt", u."updatedAt"
          FROM "Account" a
          INNER JOIN "User" u ON u."id" = a."userId"
          WHERE a."provider" = ${account.provider} AND a."providerAccountId" = ${account.providerAccountId}
          LIMIT 1
        `;
      const row = rows.at(0);
      return row ? mapUser(row) : null;
    },

    async updateUser(user: Partial<AdapterUser> & Pick<AdapterUser, "id">) {
      const existingRows =
        await db<UserRow>`
          SELECT "id", "name", "email", "image", "emailVerified", "passwordHash", "createdAt", "updatedAt"
          FROM "User"
          WHERE "id" = ${user.id}
          LIMIT 1
        `;
      const existing = existingRows.at(0);
      if (!existing) {
        throw new Error(`User with id ${user.id} not found`);
      }
      const nextUser: UserRow = {
        ...existing,
        name: user.name ?? existing.name,
        email: user.email ?? existing.email,
        image: user.image ?? existing.image,
        emailVerified:
          user.emailVerified !== undefined ? user.emailVerified : existing.emailVerified,
        updatedAt: new Date(),
      };
      await db`
        UPDATE "User"
        SET "name" = ${nextUser.name},
            "email" = ${nextUser.email},
            "image" = ${nextUser.image},
            "emailVerified" = ${nextUser.emailVerified},
            "updatedAt" = ${nextUser.updatedAt}
        WHERE "id" = ${user.id}
      `;
      return mapUser(nextUser);
    },

    async deleteUser(userId) {
      await db`
        DELETE FROM "User"
        WHERE "id" = ${userId}
      `;
    },

    async linkAccount(account: AdapterAccount) {
      const id = account.id ?? randomUUID();
      await db`
        INSERT INTO "Account" (
          "id",
          "userId",
          "type",
          "provider",
          "providerAccountId",
          "refresh_token",
          "access_token",
          "expires_at",
          "token_type",
          "scope",
          "id_token",
          "session_state"
        ) VALUES (
          ${id},
          ${account.userId},
          ${account.type},
          ${account.provider},
          ${account.providerAccountId},
          ${account.refresh_token ?? null},
          ${account.access_token ?? null},
          ${account.expires_at ?? null},
          ${account.token_type ?? null},
          ${account.scope ?? null},
          ${account.id_token ?? null},
          ${account.session_state ?? null}
        )
        ON CONFLICT ("provider", "providerAccountId") DO UPDATE
        SET "refresh_token" = EXCLUDED."refresh_token",
            "access_token" = EXCLUDED."access_token",
            "expires_at" = EXCLUDED."expires_at",
            "token_type" = EXCLUDED."token_type",
            "scope" = EXCLUDED."scope",
            "id_token" = EXCLUDED."id_token",
            "session_state" = EXCLUDED."session_state"
      `;
      return { ...account, id } satisfies AdapterAccount;
    },

    async unlinkAccount(account: Pick<AdapterAccount, "provider" | "providerAccountId">) {
      await db`
        DELETE FROM "Account"
        WHERE "provider" = ${account.provider} AND "providerAccountId" = ${account.providerAccountId}
      `;
    },

    async createSession(session: { sessionToken: string; userId: string; expires: Date }) {
      const id = randomUUID();
      const [created] =
        await db<SessionRow>`
          INSERT INTO "Session" ("id", "sessionToken", "userId", "expires")
          VALUES (${id}, ${session.sessionToken}, ${session.userId}, ${session.expires})
          RETURNING "id", "sessionToken", "userId", "expires"
        `;
      return mapSession(created);
    },

    async getSessionAndUser(sessionToken: string) {
      const rows =
        await db<{
          session_id: string;
          session_token: string;
          session_user_id: string;
          session_expires: Date;
          user_id: string;
          user_name: string | null;
          user_email: string;
          user_image: string | null;
          user_email_verified: Date | null;
        }>`
          SELECT
            s."id" as session_id,
            s."sessionToken" as session_token,
            s."userId" as session_user_id,
            s."expires" as session_expires,
            u."id" as user_id,
            u."name" as user_name,
            u."email" as user_email,
            u."image" as user_image,
            u."emailVerified" as user_email_verified
          FROM "Session" s
          INNER JOIN "User" u ON u."id" = s."userId"
          WHERE s."sessionToken" = ${sessionToken}
          LIMIT 1
        `;
      const row = rows.at(0);
      if (!row) return null;
      const session: AdapterSession = {
        sessionToken: row.session_token,
        userId: row.session_user_id,
        expires:
          row.session_expires instanceof Date
            ? row.session_expires
            : new Date(row.session_expires),
      };
      const user: AdapterUser = {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        image: row.user_image,
        emailVerified: toDate(row.user_email_verified),
      };
      return { session, user };
    },

    async updateSession(session: Partial<AdapterSession> & Pick<AdapterSession, "sessionToken">) {
      const existingRows =
        await db<SessionRow>`
          SELECT "id", "sessionToken", "userId", "expires"
          FROM "Session"
          WHERE "sessionToken" = ${session.sessionToken}
          LIMIT 1
        `;
      const existing = existingRows.at(0);
      if (!existing) return null;
      const nextSession: SessionRow = {
        ...existing,
        userId: session.userId ?? existing.userId,
        expires: session.expires ?? existing.expires,
      };
      await db`
        UPDATE "Session"
        SET "userId" = ${nextSession.userId},
            "expires" = ${nextSession.expires}
        WHERE "sessionToken" = ${session.sessionToken}
      `;
      return mapSession(nextSession);
    },

    async deleteSession(sessionToken: string) {
      await db`
        DELETE FROM "Session"
        WHERE "sessionToken" = ${sessionToken}
      `;
    },

    async createVerificationToken(token: VerificationToken) {
      const [created] =
        await db<VerificationTokenRow>`
          INSERT INTO "VerificationToken" ("identifier", "token", "expires")
          VALUES (${token.identifier}, ${token.token}, ${token.expires})
          RETURNING "identifier", "token", "expires"
        `;
      return {
        identifier: created.identifier,
        token: created.token,
        expires: created.expires instanceof Date ? created.expires : new Date(created.expires),
      } satisfies VerificationToken;
    },

    async useVerificationToken(token: { identifier: string; token: string }) {
      const rows =
        await db<VerificationTokenRow>`
          DELETE FROM "VerificationToken"
          WHERE "identifier" = ${token.identifier} AND "token" = ${token.token}
          RETURNING "identifier", "token", "expires"
        `;
      const row = rows.at(0);
      if (!row) return null;
      return {
        identifier: row.identifier,
        token: row.token,
        expires: row.expires instanceof Date ? row.expires : new Date(row.expires),
      } satisfies VerificationToken;
    },
  };
}
