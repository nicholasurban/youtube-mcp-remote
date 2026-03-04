/**
 * Manages YouTube Data API OAuth 2.0 access tokens.
 * Supports multiple channels under the same Google account via per-channel refresh tokens.
 *
 * Env vars:
 *   YOUTUBE_REFRESH_TOKEN      — default channel (@outliyr)
 *   YOUTUBE_REFRESH_TOKEN_HPL  — High Performance Longevity channel
 *   YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET — shared OAuth app credentials
 *
 * Channel mapping:
 *   UCYD_-2jbMxu0Lp65IlcGf5w → YOUTUBE_REFRESH_TOKEN_HPL
 *   anything else (or omitted) → YOUTUBE_REFRESH_TOKEN
 */

interface TokenCache {
  token: string;
  expiresAt: number;
}

const HPL_CHANNEL_ID = "UCYD_-2jbMxu0Lp65IlcGf5w";

/** Per-refresh-token cache keyed by the refresh token itself */
const tokenCacheMap = new Map<string, TokenCache>();

/**
 * Returns the refresh token for a given channel ID.
 * Falls back to default if no channel-specific token is configured.
 */
function getRefreshTokenForChannel(channelId?: string): string {
  const clientId = process.env.YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "YouTube OAuth credentials not configured. " +
        "Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET env vars."
    );
  }

  if (channelId === HPL_CHANNEL_ID) {
    const hplToken = process.env.YOUTUBE_REFRESH_TOKEN_HPL;
    if (hplToken) return hplToken;
    // Fall through to default if HPL token not yet configured
  }

  const defaultToken = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!defaultToken) {
    throw new Error(
      "YouTube OAuth credentials not configured. Set YOUTUBE_REFRESH_TOKEN env var."
    );
  }
  return defaultToken;
}

/**
 * Get an access token, optionally for a specific channel.
 * @param channelId — pass a channel ID to use that channel's refresh token
 */
export async function getYouTubeAccessToken(channelId?: string): Promise<string> {
  const refreshToken = getRefreshTokenForChannel(channelId);
  const now = Date.now();

  // Check cache for this specific refresh token
  const cached = tokenCacheMap.get(refreshToken);
  if (cached && cached.expiresAt - 5 * 60 * 1000 > now) {
    return cached.token;
  }

  const clientId = process.env.YOUTUBE_CLIENT_ID!;
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET!;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCacheMap.set(refreshToken, {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  });
  return data.access_token;
}
