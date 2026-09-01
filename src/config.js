import path from "path";
import dotenv from "dotenv";

// In a container the environment comes from docker, and .env is excluded from
// the image — dotenv then logs "injected env (0) from .env", which reads like a
// failure and is not one. Stay quiet in production; keep the output locally,
// where a missing .env really does matter.
dotenv.config({ quiet: process.env.NODE_ENV === "production" });

const isWindows = process.platform === "win32";
const root = process.cwd();

const resolveFromRoot = (value, fallback) =>
  path.resolve(root, value || fallback);

export const config = {
  port: Number(process.env.PORT) || 8000,
  nodeEnv: process.env.NODE_ENV || "development",

  // Shared secret the mobile app sends as the `x-api-key` header.
  apiKey: process.env.API_KEY || "",

  // Public origin used to build download URLs (e.g. https://api.example.com/downloader).
  // Falls back to the incoming request host when empty.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // How long a converted mp4 stays on disk before it is auto-deleted.
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS) || 3600,

  downloadsDir: resolveFromRoot(process.env.DOWNLOADS_DIR, "downloads"),
  cookiesPath: resolveFromRoot(process.env.COOKIES_PATH, "cookies.txt"),

  ytdlpPath:
    process.env.YTDLP_PATH ||
    (isWindows ? path.resolve(root, "yt-dlp.exe") : "/usr/local/bin/yt-dlp"),
  ffmpegPath:
    process.env.FFMPEG_PATH ||
    (isWindows ? path.resolve(root, "ffmpeg/bin/ffmpeg.exe") : "/usr/bin/ffmpeg"),

  // Default height cap for /api/downloads/prepare. "best" is allowed but a
  // 2160p YouTube merge is ~230MB of VPS disk and bandwidth per request.
  defaultQuality: process.env.DEFAULT_QUALITY || "1080",

  // Hard ceiling on a merge job. A long video at high quality can run for
  // minutes; past this the request is killed and returns 504.
  mergeTimeoutMs: Number(process.env.MERGE_TIMEOUT_MS) || 600_000,

  // Routes TikTok extraction through the mobile API host, which works when
  // the web extractor breaks. Set empty to always use yt-dlp's default.
  tiktokApiHostname:
    process.env.TIKTOK_API_HOSTNAME ?? "api22-normal-c-useast2a.tiktokv.com",

  // TikTok rate-limits anonymous extraction; a single attempt succeeds only
  // ~40% of the time, so retry before giving up.
  tiktokRetries: Number(process.env.TIKTOK_RETRIES) || 8,

  // Download history, stored in Supabase Postgres. Disabled unless both are
  // set. Deliberately the ANON key, never the service_role key: requests are
  // made with the end user's own access token so row-level security decides
  // what they can see. A service_role key here would bypass RLS entirely and
  // turn any VPS compromise into full database access.
  supabase: {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    anonKey: process.env.SUPABASE_ANON_KEY || "",
    get enabled() {
      return Boolean(this.url && this.anonKey);
    },
  },

  instagram: {
    username: process.env.IG_USERNAME || "",
    password: process.env.IG_PASSWORD || "",
  },
};

export default config;
