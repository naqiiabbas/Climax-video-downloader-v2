FROM node:20-slim

# ffmpeg does the HLS -> mp4 remux and the video+audio merge.
#
# The yt-dlp asset matters: the plain `yt-dlp` release is the Python zipimport
# build and does NOT bundle curl_cffi, so any extractor that needs browser
# impersonation fails with "attempting impersonation, but none of these
# impersonate targets are available" — Dailymotion does this today. The
# `yt-dlp_linux` standalone build bundles curl_cffi (and its own Python, so
# python3 is not needed here).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      curl \
 && ARCH="$(dpkg --print-architecture)" \
 && case "$ARCH" in \
      amd64) YTDLP_ASSET=yt-dlp_linux ;; \
      arm64) YTDLP_ASSET=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac \
 && curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YTDLP_ASSET" \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --version \
 && /usr/local/bin/yt-dlp --list-impersonate-targets \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY index.js ./
COPY src ./src
COPY scripts ./scripts

# cookies.txt is mounted at runtime (see docker-compose.yml) so the image
# never bakes in session credentials.
RUN mkdir -p /app/downloads && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
