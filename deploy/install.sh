#!/usr/bin/env bash
# Z Games idempotent installer (run as root).
#
# Typical layout: the repo is checked out at /srv/zgames/src, so this script
# lives at /srv/zgames/src/deploy/install.sh and copies server.mjs,
# tools/mirror.mjs and site/ from its parent directory into /srv/zgames.
#
# Usage:
#   sudo bash /srv/zgames/src/deploy/install.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: install.sh must be run as root (sudo bash $0)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "${HERE}/.." && pwd)"
APP_DIR="/srv/zgames"
SYSTEMD_DIR="/etc/systemd/system"

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: node not found in PATH" >&2
  exit 1
fi

if ! id -u zchat >/dev/null 2>&1; then
  echo "ERROR: system user 'zchat' not found; run the Z Chat blackbox installer first" >&2
  exit 1
fi

echo "==> Z Games installer (source: ${SRC}, node: ${NODE_BIN})"

echo "==> Creating ${APP_DIR} tree"
install -d -m 0755 -o zchat -g zchat \
  "${APP_DIR}" "${APP_DIR}/site" "${APP_DIR}/mirror" "${APP_DIR}/tools" "${APP_DIR}/state"

echo "==> Copying application files"
copy_file() {
  local rel="$1" dst="$2"
  if [[ -f "${SRC}/${rel}" ]]; then
    install -m 0644 -o zchat -g zchat "${SRC}/${rel}" "${dst}"
    echo "    ${rel} -> ${dst}"
  else
    echo "    WARNING: ${SRC}/${rel} not found - skipping ${dst}" >&2
  fi
}
copy_file "server.mjs" "${APP_DIR}/server.mjs"
copy_file "tools/mirror.mjs" "${APP_DIR}/tools/mirror.mjs"

if [[ -d "${SRC}/site" ]]; then
  shopt -s nullglob
  site_entries=("${SRC}/site/"*)
  shopt -u nullglob
  if [[ "${#site_entries[@]}" -eq 0 ]]; then
    echo "    WARNING: ${SRC}/site is empty - nothing copied" >&2
  fi
  for entry in "${site_entries[@]}"; do
    base="$(basename "${entry}")"
    if [[ -d "${entry}" ]]; then
      cp -a "${entry}" "${APP_DIR}/site/${base}"
    else
      install -m 0644 -o zchat -g zchat "${entry}" "${APP_DIR}/site/${base}"
    fi
    echo "    site/${base} -> ${APP_DIR}/site/${base}"
  done
else
  echo "    WARNING: ${SRC}/site not found - nothing copied to ${APP_DIR}/site" >&2
fi

echo "==> Fixing ownership (${APP_DIR})"
chown -R zchat:zchat "${APP_DIR}"

echo "==> Session secret"
if [[ ! -s "${APP_DIR}/session-secret" ]]; then
  (umask 177; printf 'SESSION_SECRET=%s\n' "$(openssl rand -hex 32)" > "${APP_DIR}/session-secret")
  echo "    generated ${APP_DIR}/session-secret"
else
  echo "    keeping existing ${APP_DIR}/session-secret"
fi
# root-only 0600; systemd reads it as PID 1 before dropping to zchat.
chown root:root "${APP_DIR}/session-secret"
chmod 600 "${APP_DIR}/session-secret"

echo "==> Installing systemd units into ${SYSTEMD_DIR}"
install -d -m 0755 "${SYSTEMD_DIR}"
install -m 0644 "${HERE}/zgames.service" "${SYSTEMD_DIR}/zgames.service"
install -m 0644 "${HERE}/zgames-mirror.service" "${SYSTEMD_DIR}/zgames-mirror.service"
install -m 0644 "${HERE}/zgames-mirror.timer" "${SYSTEMD_DIR}/zgames-mirror.timer"

# Patch the ExecStart path when node is not /usr/bin/node (same approach as
# the Z Chat blackbox installer).
if [[ "${NODE_BIN}" != "/usr/bin/node" ]]; then
  for unit in zgames.service zgames-mirror.service; do
    sed -i "s|^ExecStart=/usr/bin/node|ExecStart=${NODE_BIN}|g" "${SYSTEMD_DIR}/${unit}"
  done
fi

echo "==> Enabling and starting services"
systemctl daemon-reload
systemctl enable zgames.service zgames-mirror.timer
systemctl restart zgames.service || echo "    WARNING: zgames.service failed to start (see: journalctl -u zgames.service)" >&2
systemctl start zgames-mirror.timer || echo "    WARNING: zgames-mirror.timer failed to start" >&2

echo "==> Status"
printf '  %-24s %s\n' "zgames.service" "$(systemctl is-active zgames.service || true)"
printf '  %-24s %s\n' "zgames-mirror.timer" "$(systemctl is-active zgames-mirror.timer || true)"
printf '  healthz http://127.0.0.1:8722/healthz -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8722/healthz || true)"

echo "==> Done."
