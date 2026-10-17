# No npm install needed: the server only uses Node built-ins.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY assets ./assets
# Files copied from a Mac can be owner-only; make sure the node user can read them.
RUN chmod -R a+rX /app
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/index.js"]
