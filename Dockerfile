FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --workspaces=false
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY packages/sdk/src/contracts.ts ./packages/sdk/src/contracts.ts
RUN npm run build:app

# Install against the same musl runtime, then leave all package-manager tooling behind.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS production-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --workspaces=false --ignore-scripts

FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS runtime
RUN apk add --no-cache libatomic libstdc++ \
    && addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node
COPY --from=production-deps /usr/local/bin/node /usr/local/bin/node
COPY --from=production-deps /usr/local/LICENSE /usr/local/LICENSE
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package*.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY LICENSE ./LICENSE
COPY migrations ./migrations
COPY scripts/coding-guest.py ./scripts/coding-guest.py
COPY client-releases ./client-releases
USER node
STOPSIGNAL SIGTERM
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist/src/server/index.js"]
