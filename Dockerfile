FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run check && npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000 DATABASE_URL=file:/app/data/zongpu.sqlite UPLOAD_DIR=/app/data/uploads DOCUMENT_DIR=/app/data/family-documents BACKUP_DIR=/app/backups
WORKDIR /app
RUN apk add --no-cache su-exec
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=build /app/dist ./dist
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data/uploads /app/data/family-documents /app/backups && chown -R node:node /app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.mjs"]
