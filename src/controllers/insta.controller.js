import { exec } from "child_process";
import { config } from "../config.js";
import { buildResponse } from "../utils/media.js";
import { hasUsableCookies, cookieArgString } from "../utils/cookies.js";

const ytdlp = config.ytdlpPath;

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const { username, password } = config.instagram;

    // Prefer a usable cookies.txt; fall back to credentials only if both are
    // configured. Instagram rate-limits password logins aggressively.
    let authArgs = "";
    if (hasUsableCookies()) {
      authArgs = cookieArgString();
    } else if (username && password) {
      authArgs = `--username ${JSON.stringify(username)} --password ${JSON.stringify(password)} `;
    }

    // No --format selector — see the note in AllMedia.controller.js.
    const command =
      `"${ytdlp}" -j --no-warnings ${authArgs}${JSON.stringify(url)}`;

    exec(command, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(stderr || error.message);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject("Failed to parse yt-dlp output");
      }
    });
  });
}

export const InstaDownloader = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await runYtDlp(url);
    res.json(buildResponse(result));
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};
