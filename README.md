# Z Games

Self-hosted HTML5 game portal for the black box. Every game is mirrored to
local disk ahead of time and served from this machine only - visitors never
load anything from third-party sites at runtime.

- `server.mjs` - zero-dependency Node server: static UI, `/api/catalog`,
  `/mirror/...` assets, and Z Chat OAuth 2.1 (PKCE) login (`/auth/*`).
- `site/` - the front-end (catalog grid, search, player, account chip).
- `tools/mirror.mjs` - resumable syncer that downloads game builds to
  `/srv/zgames/mirror` and writes `site/catalog.json`.
- `deploy/` - systemd units + installer (`zgames.service`, `zgames-mirror.timer`).

Runs on port 8722 behind the Cloudflare tunnel for `game.z-chat.men`.
See `deploy/README.md` for operations.
