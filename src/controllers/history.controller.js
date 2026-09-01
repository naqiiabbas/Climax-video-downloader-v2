import { History, SupabaseError } from "../utils/supabase.js";
import { config } from "../config.js";

/** The user's Supabase access token, forwarded by the mobile app. */
const tokenFrom = (req) => req.header("x-supabase-token") || "";

function fail(res, err, fallback) {
  if (err instanceof SupabaseError) {
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
  console.error(fallback, err);
  return res.status(500).json({ success: false, error: fallback });
}

/** Whitelisted so a client cannot write arbitrary columns through PostgREST. */
function sanitise(body = {}) {
  const entry = {
    source: body.source ?? null,
    page_url: body.page_url ?? body.url ?? null,
    title: body.title ?? null,
    author: body.author ?? null,
    thumbnail: body.thumbnail ?? null,
    duration: body.duration ?? null,
    quality: body.quality ?? null,
    file_size_bytes: body.file_size_bytes ?? body.size_bytes ?? null,
  };

  const duration = Number(entry.duration);
  entry.duration = Number.isFinite(duration) ? duration : null;

  const size = Number(entry.file_size_bytes);
  entry.file_size_bytes = Number.isFinite(size) ? Math.round(size) : null;

  return entry;
}

/** POST /api/history — record one completed download. */
export const AddHistory = async (req, res) => {
  const entry = sanitise(req.body);

  if (!entry.page_url) {
    return res.status(400).json({ success: false, error: "Missing page_url" });
  }

  try {
    const row = await History.add(tokenFrom(req), entry);
    res.status(201).json({ success: true, entry: row });
  } catch (err) {
    fail(res, err, "Failed to record history");
  }
};

/** GET /api/history?limit=&offset= */
export const ListHistory = async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  try {
    const entries = await History.list(tokenFrom(req), { limit, offset });
    res.json({ success: true, count: entries?.length ?? 0, limit, offset, entries });
  } catch (err) {
    fail(res, err, "Failed to load history");
  }
};

/** DELETE /api/history/:id */
export const DeleteHistory = async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, error: "Missing id" });

  try {
    const deleted = await History.remove(tokenFrom(req), id);
    if (!deleted) {
      // Either it never existed or RLS hides it — same answer either way, and
      // saying which would leak whether another user's row exists.
      return res.status(404).json({ success: false, error: "Entry not found" });
    }
    res.json({ success: true, deleted });
  } catch (err) {
    fail(res, err, "Failed to delete history entry");
  }
};

/** DELETE /api/history — clear the caller's history. */
export const ClearHistory = async (req, res) => {
  try {
    const deleted = await History.clear(tokenFrom(req));
    res.json({ success: true, deleted });
  } catch (err) {
    fail(res, err, "Failed to clear history");
  }
};

/** GET /api/history/status — is the feature configured on this server? */
export const HistoryStatus = (_req, res) => {
  res.json({ success: true, enabled: config.supabase.enabled });
};
