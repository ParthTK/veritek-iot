# Backend image. Build context is the server/ directory:
#   docker build -f deploy/Dockerfile .
#
# tsc compiles with rootDir "." so the entrypoint is dist/src/index.js, and the
# runtime resolves migrations/ and public/ relative to dist/ - hence where they
# are copied below.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npx tsc -p tsconfig.json

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./dist/migrations
COPY public ./dist/public

# Never run as root; the process needs nothing beyond its own port.
USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=10s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
