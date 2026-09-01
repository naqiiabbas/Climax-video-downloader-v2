import { exec } from "child_process";
import fs from "fs";
import { config } from "../config.js";
import { buildResponse } from "../utils/media.js";

const ytdlp = config.ytdlpPath;

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    const cookieArg = fs.existsSync(config.cookiesPath)
      ? `--cookies ${JSON.stringify(config.cookiesPath)} `
      : "";

    const command = `"${ytdlp}" -j --no-warnings ${cookieArg}${JSON.stringify(url)}`;

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

/** Handles Dailymotion and Pinterest. */
export const DalyMotionAndPainternst = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await runYtDlp(url);

    // Dailymotion serves everything as HLS, so dropping m3u8 here would leave
    // the client with an empty media list. They are returned flagged with
    // needs_conversion instead.
    res.json(buildResponse(result));
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};
