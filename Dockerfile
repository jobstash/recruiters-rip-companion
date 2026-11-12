# Recruiters.rip Companion built from this source and served to a browser on the same computer.
# Usage: README.md, "Run in a container". The same main process runs as the desktop app; started by
# plain Node it uses src/web-shell.mjs in place of an Electron window.
FROM node:24.22.3-alpine3.24 AS base
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm install --global pnpm@10.34.9
COPY package.json pnpm-lock.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY scripts ./scripts
COPY src ./src
COPY ui ./ui
COPY browser-extension ./browser-extension
COPY skills ./skills
RUN pnpm build

# Runtime packages only: no Electron, packager or compiler in the final image.
FROM base AS runtime-packages
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.22.3-alpine3.24
ENV NODE_ENV=production \
    RECRUITERS_COMPANION_CONTAINER=recruiters-companion \
    RECRUITERS_COMPANION_DATA=/data \
    RECRUITERS_COMPANION_WEB_BIND=0.0.0.0 \
    RECRUITERS_COMPANION_WEB_PORT=43117
# Take the base image's patched system packages, and drop its package managers: Companion never runs them,
# so their own dependencies should not ship (or need patching) here.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
       /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
COPY --from=runtime-packages /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/ui ./ui
# The update status code imports this module; a container itself is never updated in place.
COPY --from=build /app/scripts/install-source.mjs ./scripts/install-source.mjs
COPY --from=build /app/browser-extension/dist ./browser-extension/dist
# `docker exec <container> companion …` prints the address to open and the browser-extension setup script.
RUN printf '#!/bin/sh\nexec node /app/src/container-cli.mjs "$@"\n' > /usr/local/bin/companion \
    && chmod 755 /usr/local/bin/companion \
    && mkdir /data && chown node:node /data && chmod 700 /data
USER node
VOLUME /data
EXPOSE 43117
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -q -O /dev/null "http://127.0.0.1:${RECRUITERS_COMPANION_WEB_PORT}/design-tokens.css" || exit 1
CMD ["node", "src/main.mjs"]
