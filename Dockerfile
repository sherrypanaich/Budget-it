# Budget it in a container. Data (including the key for bank connections) lives in a volume at /data.
#   docker compose up -d        (see compose.yaml)
FROM node:24-alpine
WORKDIR /app
COPY . .
# The app runs as the ordinary "node" user, not root, and can only write to /data.
# tzdata: the time zone files, so TZ (your time zone, for reminders and "today") works in the container.
# The app's own files stay root's: readable by everyone (even from a checkout with private permissions), changeable by nobody here.
RUN apk add --no-cache tzdata && rm -rf data test && chmod -R a+rX,go-w /app && mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8090 DATA_DIR=/data NODE_ENV=production
EXPOSE 8090
VOLUME ["/data"]
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8090}/manifest.webmanifest" >/dev/null || exit 1
CMD ["node", "server.js"]
