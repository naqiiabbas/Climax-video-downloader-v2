import { createApp } from "./src/app.js";
import { config } from "./src/config.js";

const app = createApp();

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`video-downloader-api listening on port ${config.port} (${config.nodeEnv})`);
  if (!config.apiKey) {
    console.warn("WARNING: API_KEY is empty — every protected route will return 500.");
  }
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
