FROM node:20-alpine

# better-sqlite3 requires build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package*.json ./
RUN npm ci --production

COPY src/ ./src/

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
