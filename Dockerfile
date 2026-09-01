FROM node:20-slim

# yt-dlp needs python3; ffmpeg does the HLS -> mp4 remux.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      ffmpeg \
      ca-certificates \
      curl \
 && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
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
