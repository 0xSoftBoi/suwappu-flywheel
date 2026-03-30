FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
HEALTHCHECK --interval=300s CMD echo "ok"
CMD ["bun", "run", "src/cli.ts", "run", "--dry-run"]
