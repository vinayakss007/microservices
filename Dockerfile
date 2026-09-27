# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests first so dependency layers cache independently of source.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/ingest-gateway/package.json services/ingest-gateway/
COPY services/delivery-worker/package.json services/delivery-worker/
COPY services/notifier-service/package.json services/notifier-service/
COPY services/billing-service/package.json services/billing-service/
COPY services/dashboard-service/package.json services/dashboard-service/
COPY services/mock-target/package.json services/mock-target/

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

COPY packages ./packages
COPY services ./services

# Node is not root here; /data holds the file-driver fallback when Postgres is absent.
RUN chown -R node:node /app
USER node
EXPOSE 8080

# SERVICE_NAME / PORT / ENTRY come from compose per service.
CMD ["sh", "-c", "node ${ENTRY:-services/dashboard-service/index.js}"]
