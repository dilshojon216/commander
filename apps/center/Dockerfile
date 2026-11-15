# syntax=docker/dockerfile:1
# Build context = monorepo ildizi (docker-compose.yml shuni sozlaydi):
#   docker build -f apps/center/Dockerfile .

FROM node:24-alpine AS build
WORKDIR /app
# Faqat center va uning ichki bog'liqligi (contracts) uchun manifestlar
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/center/package.json apps/center/
COPY libs/contracts/package.json libs/contracts/
RUN npm ci -w @commander/center -w @commander/contracts --include-workspace-root=false
COPY libs/contracts libs/contracts
COPY apps/center/tsconfig.json apps/center/tsconfig.build.json apps/center/nest-cli.json apps/center/
COPY apps/center/src apps/center/src
RUN npm run build -w @commander/contracts \
 && npm run build -w @commander/center \
 && npm prune --omit=dev -w @commander/center -w @commander/contracts

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/libs/contracts/package.json ./libs/contracts/package.json
COPY --from=build --chown=node:node /app/libs/contracts/dist ./libs/contracts/dist
COPY --from=build --chown=node:node /app/apps/center/dist ./apps/center/dist
COPY --chown=node:node apps/center/package.json ./apps/center/package.json
# Maxfiy volume (buyruq-imzo kaliti): yangi named volume shu papkaning egasini (node) oladi.
RUN mkdir -p /var/lib/commander-secrets && chown node:node /var/lib/commander-secrets && chmod 700 /var/lib/commander-secrets
USER node
WORKDIR /app/apps/center
EXPOSE 4317
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
