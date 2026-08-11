FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY frontend ./frontend
RUN npm run build

FROM node:24-bookworm-slim AS runtime-dependencies

WORKDIR /runtime
COPY src-tauri/resources/runtime/package.json src-tauri/resources/runtime/package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/* /root/.npm

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/mail-collector.db

WORKDIR /app
COPY --from=runtime-dependencies /runtime/node_modules ./node_modules
COPY src-tauri/resources/runtime/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 CMD ["node", "-e", "const net=require('node:net');const s=net.connect(3000,'127.0.0.1',()=>{s.end();process.exit(0)});s.setTimeout(3000,()=>process.exit(1));s.on('error',()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
