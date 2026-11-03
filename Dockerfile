FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --workspaces=false
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
COPY scripts ./scripts
COPY packages/sdk/src/contracts.ts ./packages/sdk/src/contracts.ts
RUN npm run build:app

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY package*.json ./
# Preserve the existing hosting pre-deploy `npm run` command. npm 12.2.1 still
# bundles undici 6.29.0; replace that dependency with its compatible security patch.
RUN npm install --global npm@12.2.1 --ignore-scripts \
    && npm install --prefix /tmp/broker-npm-security --ignore-scripts --no-audit --no-fund \
       --package-lock=false undici@6.29.1 \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
    && mv /tmp/broker-npm-security/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/undici \
    && npm ci --omit=dev --workspaces=false --ignore-scripts && npm cache clean --force \
    && rm -rf /tmp/broker-npm-security /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
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
