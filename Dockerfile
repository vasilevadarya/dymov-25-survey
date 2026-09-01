FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY config ./config
COPY public ./public
COPY server ./server
COPY scripts ./scripts
COPY reference ./reference
RUN node scripts/validate.mjs
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/live || exit 1
CMD ["node", "server/index.js"]
