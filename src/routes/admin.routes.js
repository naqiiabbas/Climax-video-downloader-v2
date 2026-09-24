import express from "express";
import multer from "multer";
import { AdminPage, AdminStatus, AdminTest } from "../controllers/admin.controller.js";
import { UpdateCookies } from "../controllers/system.controller.js";
import { verifyAdminPassword } from "../middleware/adminAuth.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB, same as /api/update-cookies
});

const AdminRoutes = express.Router();

// The page is a login form and holds no secrets, so it loads without auth.
// Every action below is gated.
AdminRoutes.get("/", AdminPage);

// Doubles as the login check: the page calls it with the typed password and
// shows the dashboard only if it comes back 200.
AdminRoutes.get("/status", verifyAdminPassword, AdminStatus);

// Reuses the exact handler behind POST /api/update-cookies rather than a
// parallel copy, so the Netscape-format validation and the 0600 write cannot
// drift between the two entry points. Only the gate in front differs.
//
// verifyAdminPassword runs BEFORE multer: an unauthenticated caller should not
// get to stream 5MB into the process before being rejected. That means the
// password must arrive as a header here, since the multipart body is not
// parsed yet — which is what the page sends.
AdminRoutes.post("/cookies", verifyAdminPassword, upload.single("file"), UpdateCookies);

AdminRoutes.post("/test", verifyAdminPassword, AdminTest);

export default AdminRoutes;
