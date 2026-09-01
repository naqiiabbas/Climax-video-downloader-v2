import path from "path";
import dotenv from "dotenv";

dotenv.config();

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

  instagram: {
    username: process.env.IG_USERNAME || "",
    password: process.env.IG_PASSWORD || "",
  },
};

export default config;
