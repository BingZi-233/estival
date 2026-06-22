# estival — HTTP service wrapping the Claude Agent SDK.
#
# Load-bearing constraints (do not change the base image or install method):
#  - glibc base (bookworm, NOT alpine): lets @anthropic-ai/claude-agent-sdk resolve
#    its optionalDependencies to the linux-<arch> (glibc) CLI binary, not the musl one.
#  - Always `pnpm install` inside the image; never copy host node_modules. The CLI
#    (~250MB), esbuild, and tsx ship per-platform/libc binaries — only an in-image
#    install matches the build machine's arch (see .dockerignore).
#  - The runtime executes TS directly via tsx (no build step), so install the full
#    dependency set (tsx lives in devDependencies); do not use --prod.
#  - Node 22+: pnpm@11 relies on Node 22 built-ins (Node 20 → ERR_UNKNOWN_BUILTIN_MODULE).
FROM node:22-bookworm-slim

# ca-certificates: HTTPS for the model gateway / remote file fetches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack. Needs pnpm@10+ (pnpm-workspace.yaml's onlyBuiltDependencies is a
# v10+ feature; v9 misreads the file and errors "packages field missing").
RUN corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

# Copy manifests first for layer caching. .pnpmfile.cjs + pnpm-workspace.yaml must be
# present, else esbuild's (tsx's) build script gets blocked by pnpm.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
RUN pnpm install --frozen-lockfile --config.dangerouslyAllowAllBuilds=true

# Copy only the engine source. The image is a pure runtime engine: your business
# config (.claude = skills/ + mcp.json) is NOT baked in — mount it read-only at runtime
# (see docker-compose.yml). A bare `docker run` with no mount finds no skills.
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# slim image has no curl/wget; probe /health with a node one-liner.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["pnpm", "start"]
