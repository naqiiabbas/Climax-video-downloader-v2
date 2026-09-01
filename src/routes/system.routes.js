import express from "express";
import multer from "multer";
import { UpdateCookies, DeleteVideo, Health } from "../controllers/system.controller.js";
import { verifyStrongKey } from "../middleware/apiAuth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const SystemRoutes = express.Router();

// Health is intentionally open so load balancers can probe it.
SystemRoutes.get("/health", Health);

SystemRoutes.post("/update-cookies", verifyStrongKey, upload.single("file"), UpdateCookies);
SystemRoutes.get("/delete-video", verifyStrongKey, DeleteVideo);

export default SystemRoutes;
