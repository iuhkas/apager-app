FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/relay/package.json ./packages/relay/
# tsx fuehrt die TypeScript-Quellen direkt aus und steckt in den devDependencies,
# deshalb hier bewusst --include=dev.
RUN npm install --workspace @apager/relay --include-workspace-root \
      --include=dev --no-audit --no-fund \
  && npm cache clean --force

COPY packages/shared ./packages/shared
COPY packages/relay ./packages/relay

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["npm", "run", "start", "-w", "@apager/relay"]
