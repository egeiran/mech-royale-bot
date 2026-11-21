# Mech Royale bot (mechfight/1). Runs with no network, read-only root, 1 CPU, 512 MB, map at /arena.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ENV HOME=/tmp
WORKDIR /bot
COPY . .
ENTRYPOINT ["bun", "/bot/example.ts"]
