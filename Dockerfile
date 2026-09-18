# The Reins demo agent, for running on a server rather than a laptop.
# See examples/demo-agent/README.md, "Run it on a server".
#
# Node 24 runs the demo's TypeScript directly; the Reins server it drives is
# compiled here. Nothing secret goes into the image: the Anthropic key comes
# from .env at run time, and the demo's state lives in a mounted demo-data/.
FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# The official image's unprivileged user; demo-data/ on the host must be
# writable by it (uid 1000).
USER node
CMD ["node", "examples/demo-agent/agent.ts", "--idle-when-spent"]
