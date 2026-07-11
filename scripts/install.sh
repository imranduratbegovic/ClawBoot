#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Run this installer as root." >&2
    exit 1
  fi
  exec sudo -E sh "$0" "$@"
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
INSTALL_DIR=/opt/clawboot
SERVICE_USER=openclaw

if [ "$(uname -s)" != Linux ]; then
  echo "This installer requires Raspberry Pi OS or another Debian-based Linux distribution." >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64) ;;
  *)
    echo "A 64-bit Raspberry Pi OS installation is required." >&2
    exit 1
    ;;
esac

if [ -r /proc/device-tree/model ] && ! tr -d '\000' < /proc/device-tree/model | grep -qi 'Raspberry Pi 5'; then
  echo "This setup app is intended for Raspberry Pi 5 hardware." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl git sudo zstd \
  python3 python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 \
  desktop-file-utils hicolor-icon-theme

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
if [ "$NODE_MAJOR" != 24 ]; then
  NODESOURCE_SETUP="$(mktemp)"
  trap 'rm -f "$NODESOURCE_SETUP"' EXIT HUP INT TERM
  curl --fail --show-error --location --proto '=https' --tlsv1.2 \
    --output "$NODESOURCE_SETUP" \
    https://deb.nodesource.com/setup_24.x
  sh "$NODESOURCE_SETUP"
  rm -f "$NODESOURCE_SETUP"
  trap - EXIT HUP INT TERM
  apt-get install -y nodejs
fi

if [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  echo "Node.js 24 could not be installed." >&2
  exit 1
fi

if [ ! -f "$SOURCE_DIR/dist/client/index.html" ]; then
  echo "This release is missing its prebuilt interface (dist/client/index.html)." >&2
  echo "Download a packaged release or run npm run build before installing." >&2
  exit 1
fi

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/openclaw --shell /bin/bash "$SERVICE_USER"
fi
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 /var/lib/openclaw /var/lib/openclaw/.npm-global

OPENCLAW_UID="$(id -u "$SERVICE_USER")"
loginctl enable-linger "$SERVICE_USER" >/dev/null 2>&1 || true
systemctl start "user@${OPENCLAW_UID}.service"

STAGING="${INSTALL_DIR}.new"
rm -rf "$STAGING"
install -d -o root -g root -m 0755 "$STAGING" "$STAGING/dist" "$STAGING/bin"
cp -a "$SOURCE_DIR/setupd" "$STAGING/setupd"
cp -a "$SOURCE_DIR/dist/client" "$STAGING/dist/client"
install -o root -g root -m 0755 "$SOURCE_DIR/packaging/clawboot-service" "$STAGING/bin/clawboot-service"
chown -R root:root "$STAGING"
rm -rf "$INSTALL_DIR"
mv "$STAGING" "$INSTALL_DIR"

install -o root -g root -m 0755 \
  "$SOURCE_DIR/packaging/clawboot-helper" \
  /usr/local/libexec/clawboot-helper
install -o root -g root -m 0440 \
  "$SOURCE_DIR/packaging/clawboot.sudoers" \
  /etc/sudoers.d/clawboot
visudo -cf /etc/sudoers.d/clawboot >/dev/null

install -o root -g root -m 0755 \
  "$SOURCE_DIR/desktop/clawboot" \
  /usr/bin/clawboot
install -o root -g root -m 0644 \
  "$SOURCE_DIR/packaging/io.openclaw.ClawBoot.desktop" \
  /usr/share/applications/io.openclaw.ClawBoot.desktop
install -o root -g root -m 0644 \
  "$SOURCE_DIR/packaging/io.openclaw.ClawBoot.metainfo.xml" \
  /usr/share/metainfo/io.openclaw.ClawBoot.metainfo.xml

for SIZE in 64 128 256; do
  install -d -o root -g root -m 0755 "/usr/share/icons/hicolor/${SIZE}x${SIZE}/apps"
  install -o root -g root -m 0644 \
    "$SOURCE_DIR/packaging/icons/${SIZE}x${SIZE}/clawboot.png" \
    "/usr/share/icons/hicolor/${SIZE}x${SIZE}/apps/clawboot.png"
done

desktop-file-validate /usr/share/applications/io.openclaw.ClawBoot.desktop
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor >/dev/null 2>&1 || true

UNIT_TMP="$(mktemp)"
trap 'rm -f "$UNIT_TMP"' EXIT HUP INT TERM
sed "s/OPENCLAW_UID/$OPENCLAW_UID/g" \
  "$SOURCE_DIR/packaging/clawboot.service" > "$UNIT_TMP"
install -o root -g root -m 0644 "$UNIT_TMP" /etc/systemd/system/clawboot.service
rm -f "$UNIT_TMP"
trap - EXIT HUP INT TERM

systemctl daemon-reload
systemctl enable clawboot.service
systemctl restart clawboot.service

echo
echo "ClawBoot is installed."
echo "Open it from Raspberry Pi Menu > System Tools > ClawBoot."
echo "You can also run: clawboot"
echo "For a headless Pi, forward it securely from your computer:"
echo "  ssh -L 3210:127.0.0.1:3210 -L 18789:127.0.0.1:18789 <your-pi-user>@<your-pi-host>"
echo "Then open http://127.0.0.1:3210 on your computer."
