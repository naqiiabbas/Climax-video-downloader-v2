import { config } from "../config.js";

/**
 * Thin PostgREST client for the download-history table.
 *
 * Every call carries the END USER'S access token, forwarded from the mobile app
 * as `x-supabase-token`, so row-level security decides what that user can read
 * and write. The server holds only the anon key, which grants nothing on its
 * own — that is the whole point:
 *
 *   - No service_role key on the VPS, so a compromise cannot read the database.
 *   - A user id cannot be forged. Holding this API's key is not enough to reach
 *     someone else's history; you need that user's Supabase session.
 *
 * Written against fetch rather than @supabase/supabase-js: this is three REST
 * calls, and the SDK would be a large dependency for no benefit.
 */

const TABLE = "download_history";

class SupabaseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

function assertEnabled() {
  if (!config.supabase.enabled) {
    throw new SupabaseError(
      "History is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.",
      503
    );
  }
}

async function request(path, { method = "GET", token, body, prefer } = {}) {
  assertEnabled();

  if (!token) {
    throw new SupabaseError("Missing x-supabase-token header", 401);
  }

  const headers = {
    apikey: config.supabase.anonKey,
    Authorization: `Bearer ${token}`,
  };
  if (body) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  let res;
  try {
    res = await fetch(`${config.supabase.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SupabaseError(`Could not reach Supabase: ${err.message}`, 502);
  }

  const text = await res.text();
  const payload = text ? safeJson(text) : null;

  if (!res.ok) {
    // 401/403 from PostgREST means the user's token is expired or RLS rejected
    // the row — surface it as-is so the app knows to refresh the session.
    const message =
      payload?.message || payload?.error || text || `Supabase error ${res.status}`;
    throw new SupabaseError(message, res.status);
  }

  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const History = {
  /** Insert one row. user_id is filled by the column default (auth.uid()). */
  async add(token, entry) {
    const rows = await request(TABLE, {
      method: "POST",
      token,
      body: entry,
      prefer: "return=representation",
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  /** Most recent first. RLS limits this to the caller's own rows. */
  async list(token, { limit = 50, offset = 0 } = {}) {
    const query = new URLSearchParams({
      select: "*",
      order: "created_at.desc",
      limit: String(limit),
      offset: String(offset),
    });
    return request(`${TABLE}?${query}`, { token });
  },

  /** Deleting someone else's row is a no-op: RLS makes it invisible. */
  async remove(token, id) {
    const rows = await request(`${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      token,
      prefer: "return=representation",
    });
    return Array.isArray(rows) ? rows.length : 0;
  },

  /** Clears the caller's entire history. */
  async clear(token) {
    const rows = await request(`${TABLE}?id=not.is.null`, {
      method: "DELETE",
      token,
      prefer: "return=representation",
    });
    return Array.isArray(rows) ? rows.length : 0;
  },
};

export { SupabaseError };
