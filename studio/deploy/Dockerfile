FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS current-node

# Reuse the release's tested dependency tree, then rebuild all changed source.
FROM ghcr.io/gitroomhq/postiz-app:v2.25.1@sha256:d2b37802e96757729fdea2d3d71287f841c2b619faa1cb4c21dac07df657fde1 AS upstream
FROM upstream AS postiz
LABEL org.opencontainers.image.source="https://github.com/Kalvisan/ordersmp-creator-studio" org.opencontainers.image.licenses="AGPL-3.0"
USER root
COPY --from=current-node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get -y upgrade && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . /app
ENV NEXT_TELEMETRY_DISABLED=1 NX_DAEMON=false NX_ADD_PLUGINS=false \
    NEXT_PUBLIC_BACKEND_URL=https://studio.ordersmp.net/api \
    FRONTEND_URL=https://studio.ordersmp.net MAIN_URL=https://studio.ordersmp.net \
    BACKEND_INTERNAL_URL=http://127.0.0.1:3000 \
    STORAGE_PROVIDER=local UPLOAD_DIRECTORY=/uploads NEXT_PUBLIC_UPLOAD_DIRECTORY=/uploads \
    NEXT_PUBLIC_IS_GENERAL=true NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm exec prisma generate --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma \
    && pnpm run build \
    && rm -rf /app/apps/frontend/.next/cache \
    && ln -s /tmp/next-cache /app/apps/frontend/.next/cache
USER 18001:18001
ENV HOME=/tmp NODE_ENV=production NODE_OPTIONS=--max-old-space-size=2048
ENTRYPOINT ["node", "/app/studio/deploy/postiz-entrypoint.mjs"]

FROM current-node AS gateway
LABEL org.opencontainers.image.source="https://github.com/Kalvisan/ordersmp-creator-studio" org.opencontainers.image.licenses="AGPL-3.0"
WORKDIR /app
COPY --from=upstream /app/node_modules /app/node_modules
COPY studio /app/studio
USER 18006:18006
ENV NODE_ENV=production HOME=/tmp
ENTRYPOINT ["node", "/app/studio/deploy/gateway-entrypoint.mjs"]

FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS worker
LABEL org.opencontainers.image.source="https://github.com/Kalvisan/ordersmp-creator-studio" org.opencontainers.image.licenses="AGPL-3.0"
RUN apt-get update && apt-get -y upgrade && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY studio/worker /app
COPY studio/assets/order-pixel.ttf studio/assets/SIL-OFL.txt /app/assets/
COPY studio/deploy/worker-entrypoint.py /app/entrypoint.py
USER 18007:18007
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HOME=/tmp OMP_NUM_THREADS=1
ENV CREATOR_CREDIT_FONT=/app/assets/order-pixel.ttf
ENTRYPOINT ["python", "/app/entrypoint.py"]

FROM temporalio/admin-tools:1.32.1@sha256:9ef0dc5b063bf4ffd5c1512de72e0e73e225bd2c7006a18ce69bd592a8862a83 AS temporal-tools
FROM temporalio/server:1.32.1@sha256:acecbab5b0b8ae9cf4012b508866ca97feda3709577bf157b537239f40029049 AS temporal
LABEL org.opencontainers.image.source="https://github.com/Kalvisan/ordersmp-creator-studio" org.opencontainers.image.licenses="AGPL-3.0"
COPY --from=temporal-tools /usr/local/bin/temporal-sql-tool /usr/local/bin/temporal /usr/local/bin/
COPY --from=temporal-tools /etc/temporal/schema /etc/temporal/schema
COPY studio/deploy/temporal.yaml /etc/temporal/studio.yaml
COPY studio/deploy/temporal-entrypoint.sh /etc/temporal/studio-entrypoint.sh
USER 18004:18004
ENV HOME=/tmp GOMAXPROCS=2
ENTRYPOINT ["/bin/sh", "/etc/temporal/studio-entrypoint.sh"]
