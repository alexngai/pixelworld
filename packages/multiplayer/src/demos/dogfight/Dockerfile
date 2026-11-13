# The dogfight demo (D-114): the built page, its world and the server that runs
# its rooms, on Node alone. Built from the repository's root:
#
#   docker build -f packages/multiplayer/src/demos/dogfight/Dockerfile -t pixelworld-dogfight .
#   docker run --rm -p 8080:8080 pixelworld-dogfight          # http://localhost:8080/?room=canyon

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pixelworlds/multiplayer demo:dogfight:build

# the server is one file with everything in it, beside the page: no node_modules
FROM node:22-slim
WORKDIR /app
COPY --from=build /repo/packages/multiplayer/src/demos/dogfight/dist ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server/serve.js"]
