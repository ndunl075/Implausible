# Implausible — self-hosting image.
#
# Debian-based rather than Alpine on purpose: DuckDB ships prebuilt binaries
# linked against glibc, and musl would force a source build for no benefit.

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Runs unprivileged, and owns only the data directory it needs to write to.
RUN useradd --system --create-home --uid 10001 implausible

COPY --from=build --chown=implausible:implausible /app/package.json /app/package-lock.json ./
COPY --from=build --chown=implausible:implausible /app/node_modules ./node_modules
COPY --from=build --chown=implausible:implausible /app/.next ./.next
COPY --from=build --chown=implausible:implausible /app/public ./public
COPY --from=build --chown=implausible:implausible /app/next.config.ts ./

# The database and the salt live here. Mount a volume over it, or the salt is
# regenerated on every restart and a day of session continuity is lost.
RUN mkdir -p /data && chown implausible:implausible /data
ENV IMPLAUSIBLE_DB_PATH=/data/implausible.duckdb
ENV IMPLAUSIBLE_SALT_PATH=/data/salt.json
VOLUME ["/data"]

USER implausible
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
