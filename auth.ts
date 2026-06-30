import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Full mail scope: required for batchDelete (permanent delete needs
// https://mail.google.com/; gmail.modify alone only allows trashing).
const GMAIL_SCOPE = "https://mail.google.com/";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: `openid email profile ${GMAIL_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // Initial sign-in: persist tokens from the provider.
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at; // unix seconds
        return token;
      }

      // Subsequent calls: refresh if the access token is expired (60s leeway).
      const expiresAt = (token.expiresAt as number | undefined) ?? 0;
      if (Date.now() < expiresAt * 1000 - 60_000) {
        return token;
      }

      if (!token.refreshToken) {
        token.error = "NoRefreshToken";
        return token;
      }

      try {
        const res = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            grant_type: "refresh_token",
            refresh_token: token.refreshToken as string,
          }),
        });

        const refreshed = await res.json();
        if (!res.ok) throw refreshed;

        token.accessToken = refreshed.access_token;
        token.expiresAt = Math.floor(Date.now() / 1000) + refreshed.expires_in;
        // Google may not return a new refresh token; keep the old one if so.
        if (refreshed.refresh_token) token.refreshToken = refreshed.refresh_token;
        token.error = undefined;
      } catch {
        token.error = "RefreshFailed";
      }

      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      session.error = token.error as string | undefined;
      return session;
    },
  },
});
