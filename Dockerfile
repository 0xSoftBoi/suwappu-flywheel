FROM oven/bun:1.3.14
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN mkdir -p /data && chown bun:bun /data
ENV SUWAPPU_FLYWHEEL_STATE_DIR=/data
USER bun
VOLUME ["/data"]
CMD ["bun", "run", "src/cli.ts", "run"]
