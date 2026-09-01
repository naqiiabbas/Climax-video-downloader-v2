import { exec } from "child_process";
import fs from "fs";
import { config } from "../config.js";
import { buildResponse } from "../utils/media.js";

const ytdlp = config.ytdlpPath;

function run(command) {
  return new Promise((resolve, reject) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * TikTok throttles anonymous extraction hard: a single attempt fails with
 * "Unable to extract universal data for rehydration" roughly 60% of the time,
 * measured over 16 runs, and it fails at the same rate with and without the
 * mobile-API-host override — so it is rate limiting, not a broken extractor.
 * Retrying is what actually fixes it; 8 attempts puts success above 97%.
 *
 * Supplying a cookies.txt cuts the failure rate substantially, so both
 * variants are tried in case one is healthier than the other at the time.
 */
function runYtDlp(url) {
  const cookieArg = fs.existsSync(config.cookiesPath)
    ? `--cookies ${JSON.stringify(config.cookiesPath)} `
    : "";
  const base = `"${ytdlp}" --geo-bypass -j --no-warnings ${cookieArg}`;
  const target = JSON.stringify(url);

  const variants = [];
  if (config.tiktokApiHostname) {
    variants.push(
      `${base}--extractor-args ${JSON.stringify(
        `tiktok:api_hostname=${config.tiktokApiHostname}`
      )} ${target}`
    );
  }
  variants.push(`${base}${target}`);

  return (async () => {
    let lastError;
    for (let attempt = 0; attempt < config.tiktokRetries; attempt++) {
      const command = variants[attempt % variants.length];
      try {
        return await run(command);
      } catch (err) {
        lastError = err;
        if (attempt < config.tiktokRetries - 1) await sleep(400);
      }
    }
    throw lastError;
  })();
}

export const FetchTiktok = async (req, res) => {
  let url = req.body?.url || req.query?.url;
  if (typeof url === "string") url = decodeURIComponent(url);
  if (!url) return res.status(400).json({ error: "Missing URL" });

  try {
    const result = await runYtDlp(url);

    let cookies = "";
    if (Array.isArray(result.cookies)) {
      cookies = result.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } else if (typeof result.cookies === "string") {
      cookies = result.cookies;
    }

    // TikTok CDN links 403 without the original request headers, so the client
    // has to replay them on the download.
    res.json(buildResponse(result, { includeHeaders: true, cookies }));
  } catch (error) {
    console.error("yt-dlp error:", error);
    res.status(500).json({
      error: "yt-dlp execution failed",
      details: error.toString(),
    });
  }
};
