# Repair Desk server. Node built-ins only: no npm install in the image.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["sh", "scripts/start.sh"]
