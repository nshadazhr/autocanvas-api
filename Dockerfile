FROM node:24-alpine AS base
RUN apk add --no-cache openssl
WORKDIR /app

FROM base AS builder
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npx prisma generate --config prisma7.config.ts
RUN npm run build

FROM base AS runtime
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./prisma7.config.ts
COPY package*.json ./
RUN mkdir -p autocanvas-assets && chown node:node autocanvas-assets
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
