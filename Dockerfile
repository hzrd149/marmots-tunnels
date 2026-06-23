# Headless Marmot group-history debugger server.
# Node 24 gives us the built-in node:sqlite module with no extra flags.
FROM node:24-slim

# Use the pnpm version pinned in package.json ("packageManager"); never prompt.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Copy the whole workspace. The marmot-ts submodule (and its nested ts-mls)
# must be checked out in the build context — CI does this with a recursive
# submodule checkout.
COPY . .

# Install dependencies (the `prepare` script builds ts-mls then marmot-ts) and
# compile the app to dist/. Dev deps (typescript/tsx) are needed for the build,
# so NODE_ENV must not be "production" yet.
RUN pnpm install --frozen-lockfile && pnpm build

# SQLite database + generated identity key live here; mount a volume to persist.
ENV TUNNELS_DATA=/data
VOLUME /data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
