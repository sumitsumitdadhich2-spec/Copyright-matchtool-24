# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# CMT — Next.js 16 long-lived Node server + ffmpeg (same version ffmpeg/ffprobe)
# Target: single EC2 box (16 vCPU / 16 GB / 100 GB EBS), Ubuntu 24.04 + Docker.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Pin pnpm. `pnpm@latest` silently moved from 10.x to 11.x, which changed the
# defaults that broke this build (minimumReleaseAge=1 day, strictDepBuilds,
# `pnpm` field in package.json + non-auth .npmrc settings no longer read).
# MUST match "packageManager" in package.json - corepack errors on mismatch.
ARG PNPM_VERSION=11.25.0
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

# ---------- deps ----------
FROM base AS deps
WORKDIR /app
# pnpm-workspace.yaml is the ONLY place pnpm 11 reads project settings from
# (overrides, allowBuilds, minimumReleaseAge...). Without it the lockfile's
# `overrides` no longer matches the config and --frozen-lockfile fails with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
# --frozen-lockfile: reproducible; the lockfile is verified against the
# supply-chain policy in pnpm-workspace.yaml (minimumReleaseAge).
# No --ignore-scripts: build scripts are governed by `allowBuilds` in
# pnpm-workspace.yaml (true = run, false = skip). Anything unlisted fails the
# install on purpose (strictDepBuilds) instead of running silently.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --no-frozen-lockfile

# ---------- build ----------
FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# The standalone tracer leaves dangling pnpm symlinks for some transitive deps
# (gcp-metadata -> json-bigint -> bignumber.js under @google/genai), which
# crashes the server with "Cannot find module 'gcp-metadata'". The script copies
# the missing packages in from node_modules and fails the build if any remain.
RUN pnpm build && node scripts/fix-standalone-symlinks.mjs

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV DISPLAY=:99

# ffmpeg + ffprobe ≥ 6.x, SAME version for both (fixes the old ffprobe v4 /
# ffmpeg v7 mismatch). Debian bookworm's apt ffmpeg is 5.1, so we install the
# official static release build (currently 7.x) into /usr/bin. Override with
# FFMPEG_VERSION=release|7.0.2|6.1 at build time.
# Also install python3 + yt-dlp (for YouTube short downloads), google-chrome-stable
# (real Chrome headed via Xvfb), xvfb, fonts-liberation, and Chromium + shared libs
# (Playwright Chromium kept as fallback).
ARG FFMPEG_VERSION=release
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils tini python3 \
    xvfb xauth fonts-liberation \
    chromium libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libatspi2.0-0 libxshmfence1 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libcups2 \
    libpango-1.0-0 libcairo2 libgtk-3-0 libvulkan1 xdg-utils \
  && ARCH="$( [ "${TARGETARCH:-amd64}" = "arm64" ] && echo arm64 || echo amd64 )" \
  && if [ "${ARCH}" = "amd64" ]; then \
       curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/google-chrome.deb \
       && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
       && rm -f /tmp/google-chrome.deb \
       && google-chrome-stable --version; \
     fi \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://johnvansickle.com/ffmpeg/releases/ffmpeg-${FFMPEG_VERSION}-${ARCH}-static.tar.xz" -o /tmp/ffmpeg.tar.xz \
  && mkdir -p /tmp/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg --strip-components=1 \
  && install -m 0755 /tmp/ffmpeg/ffmpeg /usr/bin/ffmpeg \
  && install -m 0755 /tmp/ffmpeg/ffprobe /usr/bin/ffprobe \
  && rm -rf /tmp/ffmpeg /tmp/ffmpeg.tar.xz \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && ffmpeg -version | head -1 && ffprobe -version | head -1 && yt-dlp --version

WORKDIR /app
RUN groupadd -g 1001 cmt && useradd -u 1001 -g cmt -m cmt

COPY --from=build --chown=cmt:cmt /app/public ./public
COPY --from=build --chown=cmt:cmt /app/test-data ./test-data
COPY --from=build --chown=cmt:cmt /app/.next/standalone ./
COPY --from=build --chown=cmt:cmt /app/.next/static ./.next/static
# Lifts Node's 5-minute request-body timeout so a single-stream multi-GB video
# upload is never cut off with a 408 (see server-timeouts.cjs).
COPY --from=build --chown=cmt:cmt /app/server-timeouts.cjs ./server-timeouts.cjs
COPY --from=build --chown=cmt:cmt /app/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/ /app/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/
COPY --from=build --chown=cmt:cmt /app/node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/ /app/node_modules/.pnpm/playwright@1.64.1/node_modules/playwright/
COPY --from=build --chown=cmt:cmt /app/scripts/start-container.sh ./start-container.sh
RUN chmod 0755 /app/start-container.sh

# Install Playwright's bundled Chromium into /ms-playwright as fallback and make it readable by cmt
RUN mkdir -p /ms-playwright \
  && cd /tmp && npx --yes playwright@1.64.1 install chromium \
  && chown -R cmt:cmt /ms-playwright

# Working store (EBS) + RAM work dir (tmpfs) are volumes — see docker-compose.yml
# Also pre-create /tmp/.X11-unix with sticky 1777 permissions so non-root user (cmt) can run Xvfb :99
RUN mkdir -p /data /dev/shm/cmt /tmp/.X11-unix \
  && chown -R cmt:cmt /data \
  && chmod 1777 /tmp/.X11-unix
VOLUME ["/data"]

USER cmt
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/start-container.sh"]
