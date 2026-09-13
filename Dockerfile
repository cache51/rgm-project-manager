# RGM Project Manager
#
# Multi-stage, but there is nothing to compile: the app is plain ESM with two
# runtime dependencies. The build stage exists to install with the full dev
# toolchain, and the runtime stage copies only what is needed.
#
#   docker build -t rgm .
#   docker run -p 3000:3000 -e DATABASE_URL=... -e STORAGE_SECRET=... rgm

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev keeps the final image free of anything not needed at runtime.
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# Run as a non-root user: a container that can write to its own app directory can
# overwrite its own code.
RUN addgroup -S rgm && adduser -S rgm -G rgm

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY db ./db

# The embedded database and local object storage live under /data, which is the
# only path the process needs to write to.
RUN mkdir -p /data/storage && chown -R rgm:rgm /data

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    PGLITE_DIR=/data/pg \
    STORAGE_DIR=/data/storage \
    MIGRATE_ON_START=false

USER rgm
EXPOSE 3000
VOLUME ["/data"]

# The health endpoint needs no credentials, so it is a valid readiness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are NOT run here: they belong in an init job, so that scaling to
# several replicas does not race several migrations against each other.
CMD ["node", "src/server.js"]
