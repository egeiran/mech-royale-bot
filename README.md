# Mech Royale bot

A bot for the Builders Buildathon "Mech Royale" track (protocol `mechfight/1`).

- `bot.js` is the bundle the Docker image runs; it is built from `src/` with `bun build src/entries/<entry>.ts --target=bun`.
- Runtime: [Bun](https://bun.sh) 1.4.4 (base image pinned by digest). No other dependencies.
- `src/protocol/mechfight.ts` is the protocol wrapper from the organisers' bot kit.

Released under the MIT License.
