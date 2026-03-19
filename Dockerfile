FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

# Copy built assets and production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules

# Config directory - default empty config (override via volume)
RUN mkdir -p /app/config
COPY mcp-servers.json /app/config/mcp-servers.json

ENV NODE_ENV=production

EXPOSE 3000

# يستخدم DATABASE_URL إن وُجد، وإلا ملف الإعداد
CMD ["sh", "-c", "if [ -n \"$DATABASE_URL\" ]; then exec node dist/cli.js --port 3000 --database-url \"$DATABASE_URL\"; else exec node dist/cli.js --port 3000 --config /app/config/mcp-servers.json; fi"]
