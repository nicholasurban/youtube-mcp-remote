/** Keys to strip from YouTube API responses. */
const STRIP_KEYS = new Set([
  "etag", "kind", "pageInfo", "nextPageToken", "prevPageToken",
  "localized", "regionRestriction", "contentRating",
  "recordingDetails", "fileDetails", "processingDetails", "suggestions",
]);

/** Thumbnail sizes to keep (drop the rest). */
const KEEP_THUMBS = new Set(["medium"]);

/**
 * Recursively strip noise from a YouTube API response.
 * Returns a cleaned copy without mutating input.
 */
export function trimResponse(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (Array.isArray(data)) return data.map(trimResponse);
  if (typeof data !== "object") return data;

  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (STRIP_KEYS.has(key)) continue;

    if (key === "thumbnails" && typeof value === "object" && value !== null) {
      const thumbs = value as Record<string, unknown>;
      const kept: Record<string, unknown> = {};
      for (const size of KEEP_THUMBS) {
        if (thumbs[size]) kept[size] = thumbs[size];
      }
      if (Object.keys(kept).length > 0) {
        result[key] = kept;
      }
      continue;
    }

    result[key] = trimResponse(value);
  }

  return result;
}
