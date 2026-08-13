# Server build & runtime for the full local-first Mail Collector service.
# Used to deploy this app on a host where the browser/web interface is served
# from the same Node process that talks to IMAP/SMTP.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:server && npm run build:web && npm prune --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "dist/server.js"]
