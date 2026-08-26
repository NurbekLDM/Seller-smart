FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/app/data/smart-retail.sqlite

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && mkdir -p /app/data \
    && chown -R node:node /app

COPY --chown=node:node public ./public
COPY --chown=node:node server ./server

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=4s --start-period=12s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
