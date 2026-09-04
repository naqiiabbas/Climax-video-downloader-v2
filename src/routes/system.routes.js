import express from "express";
import multer from "multer";
import {
  UpdateCookies,
  DeleteVideo,
  Health,
  Status,
  ClearServer,
} from "../controllers/system.controller.js";
import { verifyStrongKey } from "../middleware/apiAuth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const SystemRoutes = express.Router();

// Health is intentionally open so load balancers can probe it.
SystemRoutes.get("/health", Health);

// Disk usage of the converted files. Gated: it lists every cached file's name,
// and those names are the unguessable part of the open /downloads/<file> URL.
SystemRoutes.get("/status", verifyStrongKey, Status);

SystemRoutes.post("/update-cookies", verifyStrongKey, upload.single("file"), UpdateCookies);
SystemRoutes.get("/delete-video", verifyStrongKey, DeleteVideo);

// DELETE, not GET: this wipes every converted file, and a GET can be fired by a
// prefetch or a stray click. /api/delete-video stays a GET because a mistake
// there costs one named file.
SystemRoutes.delete("/clear-server", verifyStrongKey, ClearServer);

export default SystemRoutes;
