# The three multiplayer demos (D-143): their built pages, the worlds they are
# on, and one server for all their rooms, on Node alone. Built from the
# repository's root:
#
#   docker build -f packages/multiplayer/src/demos/Dockerfile -t pixelworld-demos .
#   docker run --rm -p 8080:8080 pixelworld-demos          # http://localhost:8080/

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pixelworlds/multiplayer demos:build

# the server is one file with everything in it, beside the pages: no node_modules
FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/packages/multiplayer/src/demos/dist ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/serve.js"]
