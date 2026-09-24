import express from "express";
import cors from "cors";
import fs from "fs";
import { config } from "./config.js";

import AllMediaRoutes from "./routes/AllMediaRoutes.js";
import TiktokRoutes from "./routes/Tiktok.routes.js";
import VimeoRoutes from "./routes/Vimeo.routes.js";
import DalyMotionRoutes from "./routes/DalyMotion.route.js";
import DownloadsRoutes from "./routes/downloads.routes.js";
import SystemRoutes from "./routes/system.routes.js";
import HistoryRoutes from "./routes/history.routes.js";
import AdminRoutes from "./routes/admin.routes.js";
import { verifyStrongKey } from "./middleware/apiAuth.js";

export function createApp() {
  const app = express();

  if (!fs.existsSync(config.downloadsDir)) {
    fs.mkdirSync(config.downloadsDir, { recursive: true });
  }

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json());

  // Converted mp4 files. Served without a key so the mobile client can fetch
  // the file_url it was handed; keys are unguessable timestamps and expire.
  app.use("/downloads", express.static(config.downloadsDir, { maxAge: "1h" }));

  // Browser page for uploading cookies.txt, which is what Instagram needs.
  // Gated by ADMIN_PASSWORD, deliberately NOT by the mobile API key — see
  // config.adminPassword. Mounted before the JSON routes so /admin is a page.
  app.use("/admin", AdminRoutes);

  app.get("/", (_req, res) => {
    res.json({ service: "video-downloader-api", status: "running" });
  });

  // Mounted first: `app.use("/api", verifyStrongKey, ...)` runs its middleware
  // for every /api request regardless of whether the router matches, so the
  // open /api/health probe has to be reached before those gates.
  // Contains /api/health (open), /api/update-cookies and /api/delete-video
  // (each gated inside the router).
  app.use("/api", SystemRoutes);

  // Download history. Still behind the API key like everything else, but the
  // per-user isolation comes from the caller's own Supabase token, which
  // history.controller.js forwards to PostgREST for RLS to enforce.
  app.use("/api/history", verifyStrongKey, HistoryRoutes);

  // HLS -> mp4 conversion runs ffmpeg, so it is gated too. Mounted on the
  // deeper path before the /api gates for the same reason.
  app.use("/api/downloads", verifyStrongKey, DownloadsRoutes);

  // Extraction endpoints — all require x-api-key.
  app.use("/api", verifyStrongKey, AllMediaRoutes);
  app.use("/api", verifyStrongKey, TiktokRoutes);
  app.use("/api", verifyStrongKey, VimeoRoutes);
  app.use("/api", verifyStrongKey, DalyMotionRoutes);

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: "Not found" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("Unhandled error:", err);
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ success: false, error: "File too large (max 5MB)" });
    }
    res.status(500).json({ success: false, error: "Internal server error" });
  });

  return app;
}

export default createApp;
