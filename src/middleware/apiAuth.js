import crypto from "crypto";
import { config } from "../config.js";

/**
 * Shared-secret gate for the extraction endpoints. The mobile app sends the
 * key as the `x-api-key` header.
 *
 * Note: a key shipped inside a mobile binary is extractable. This blocks
 * casual abuse of the yt-dlp workers, it is not user authentication.
 */
export const verifyStrongKey = (req, res, next) => {
  const apiKey = req.header("x-api-key");

  if (!config.apiKey) {
    console.error("API_KEY is not set — refusing every request.");
    return res.status(500).json({
      success: false,
      message: "Server misconfigured: API_KEY is not set",
    });
  }

  if (!apiKey) {
    return res.status(401).json({ success: false, message: "Missing API key" });
  }

  const provided = Buffer.from(apiKey);
  const expected = Buffer.from(config.apiKey);

  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  const valid =
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);

  if (!valid) {
    return res.status(403).json({ success: false, message: "Invalid API key" });
  }

  next();
};

export default verifyStrongKey;
