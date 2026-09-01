import { exec } from "child_process";
import { config } from "../config.js";
import { buildResponse } from "../utils/media.js";
import { cookieArgString } from "../utils/cookies.js";

const ytdlp = config.ytdlpPath;

function runYtDlp(url) {
  return new Promise((resolve, reject) => {
    // Only pass --cookies when the jar is actually usable — an empty or
    // malformed file makes yt-dlp abort every request. See utils/cookies.js.
    const cookieArg = cookieArgString();

    // No --format selector: -j dumps every format regardless, and the selector
    // makes yt-dlp abort with "Requested format is not available" on sources
    // that only publish adaptive streams (YouTube, notably). buildMediaList
    // does the picking instead.
    const command =
      `"${ytdlp}" -j --no-warnings ${cookieArg}${JSON.stringify(url)}`;

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

export const AllMediaFetch = async (req, res) => {
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
