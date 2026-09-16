# Backend image. Multi-stage so the runtime carries no compiler and no dev deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production dependencies only.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations and the commissioning page are runtime assets, not build output.
COPY server/migrations ./migrations
COPY server/public ./public

# Never run as root; the process needs no privileges beyond its own port.
USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=10s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
