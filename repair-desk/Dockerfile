# Repair Desk server. Node built-ins only: no npm install in the image.
# Litestream (continuous off-site backup of the SQLite file) is copied in from
# its official image; it runs only when a backup bucket is attached (BUCKET_NAME).
FROM litestream/litestream:0.5.9 AS litestream

FROM node:22-slim
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
WORKDIR /app
COPY package.json litestream.yml ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["sh", "scripts/start.sh"]
