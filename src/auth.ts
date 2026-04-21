import type { NextAuthOptions, Session } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { db } from "@/lib/db";
import type { UserRow } from "@/lib/db-types";
import { env } from "@/lib/env";

export const authOptions: NextAuthOptions = {
  // Note: Adapter is not used with Credentials provider (JWT sessions)
  providers: [
    Credentials({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          return null;
        }
        const normalizedEmail = String(credentials.email).toLowerCase();
        const users = await db<UserRow>`
          SELECT "id", "email", "name", "image", "passwordHash"
          FROM "User"
          WHERE "email" = ${normalizedEmail}
          LIMIT 1
        `;
        const user = users.at(0);
        if (!user?.passwordHash) {
          return null;
        }
        const valid = await compare(
          String(credentials.password),
          user.passwordHash,
        );
        if (!valid) {
          return null;
        }
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          image: user.image ?? undefined,
        } satisfies {
          id: string;
          email: string;
          name?: string;
          image?: string;
        };
      },
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, user }) {
      // Add user ID to token on sign in
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      // Add user ID from token to session
      if (session?.user && token?.id) {
        (session.user as Session["user"] & { id?: string }).id =
          token.id as string;
      }
      return session;
    },
  },
  secret: env.NEXTAUTH_SECRET,
  pages: {
    signIn: "/signin",
  },
};
