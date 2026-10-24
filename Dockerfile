# Build the web UI and copy the exact published EASI View SDK assets.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 easi && useradd --uid 10001 --gid easi --no-create-home easi \
    && mkdir /data && chown easi:easi /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/LICENSE /app/NOTICE ./
COPY --from=build /app/licenses ./licenses
USER easi:easi
VOLUME ["/data"]
EXPOSE 8048 4248
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8048/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "src/cli.js", "start", "--host", "0.0.0.0", "--port", "8048", "--data-dir", "/data"]
