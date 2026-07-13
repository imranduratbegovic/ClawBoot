#!/bin/sh
set -eu

cat >&2 <<'EOF'
scripts/install.sh is a retired, contributor-facing guard and does not install
ClawBoot. The old source installer could not reproduce the verified runtime,
upgrade, permission, and uninstall behavior of the Debian package.

Users: download clawboot_arm64.deb from the GitHub release and open it with
Raspberry Pi OS Package Install.

Contributors: run npm test, then build the complete package with:
  python3 scripts/build-deb.py --output clawboot_1.2.0_arm64.deb
EOF
exit 64
