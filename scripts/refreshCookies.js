/**
 * Regenerates cookies.txt from an Instagram login.
 *
 * Optional helper — the normal path is uploading a browser-exported
 * cookies.txt to POST /api/update-cookies. Password logins trip Instagram's
 * bot checks often, so treat this as a fallback.
 *
 *   npm run refresh-cookies
 */
import fs from "fs";
import { IgApiClient } from "instagram-private-api";
import { config } from "../src/config.js";

const { username, password } = config.instagram;

if (!username || !password) {
  console.error("IG_USERNAME and IG_PASSWORD must be set in .env");
  process.exit(1);
}

const ig = new IgApiClient();

async function updateCookies() {
  try {
    ig.state.generateDevice(username);
    await ig.account.login(username, password);

    const cookies = await ig.state.cookieJar.getCookies("https://www.instagram.com");

    // Netscape cookie-jar format, which is what yt-dlp --cookies expects.
    const lines = [
      "# Netscape HTTP Cookie File",
      ...cookies.map((c) => {
        const expires = c.expires instanceof Date
          ? Math.floor(c.expires.getTime() / 1000)
          : 0;
        return [
          ".instagram.com",
          "TRUE",
          "/",
          c.secure ? "TRUE" : "FALSE",
          expires,
          c.key,
          c.value,
        ].join("\t");
      }),
    ];

    fs.writeFileSync(config.cookiesPath, lines.join("\n") + "\n", { mode: 0o600 });
    console.log(`Wrote ${cookies.length} cookies to ${config.cookiesPath}`);
  } catch (err) {
    console.error("Failed to refresh cookies:", err.message);
    process.exit(1);
  }
}

updateCookies();
