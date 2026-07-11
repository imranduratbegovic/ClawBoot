#!/usr/bin/env python3
"""Build the self-contained ClawBoot arm64 Debian package."""

from __future__ import annotations

import argparse
import copy
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import time
import urllib.request


PACKAGE_VERSION = "0.2.0"
NODE_VERSION = "24.18.0"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-linux-arm64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
NODE_SHA256 = "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def prepare_data_tree(root: Path, stage: Path) -> None:
    shutil.copytree(root / "setupd", stage / "opt/clawboot/setupd")
    shutil.copytree(root / "dist/client", stage / "opt/clawboot/dist/client")
    copy_file(root / "packaging/clawboot-service", stage / "opt/clawboot/bin/clawboot-service")
    copy_file(root / "desktop/clawboot", stage / "usr/bin/clawboot")
    copy_file(root / "packaging/clawboot-helper", stage / "usr/local/libexec/clawboot-helper")
    copy_file(root / "packaging/clawboot.sudoers", stage / "etc/sudoers.d/clawboot")
    copy_file(root / "packaging/clawboot.service", stage / "usr/lib/systemd/system/clawboot.service")
    copy_file(
        root / "packaging/io.openclaw.ClawBoot.desktop",
        stage / "usr/share/applications/io.openclaw.ClawBoot.desktop",
    )
    copy_file(
        root / "packaging/io.openclaw.ClawBoot.metainfo.xml",
        stage / "usr/share/metainfo/io.openclaw.ClawBoot.metainfo.xml",
    )
    for size in (64, 128, 256):
        copy_file(
            root / f"packaging/icons/{size}x{size}/clawboot.png",
            stage / f"usr/share/icons/hicolor/{size}x{size}/apps/clawboot.png",
        )
    copy_file(root / "LICENSE", stage / "usr/share/doc/clawboot/copyright")


def download_node(cache: Path) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / NODE_ARCHIVE
    if not target.exists() or sha256(target) != NODE_SHA256:
        partial = target.with_suffix(target.suffix + ".partial")
        partial.unlink(missing_ok=True)
        print(f"Downloading Node.js {NODE_VERSION} for Linux arm64...")
        with urllib.request.urlopen(NODE_URL, timeout=60) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        if sha256(partial) != NODE_SHA256:
            partial.unlink(missing_ok=True)
            raise RuntimeError("The downloaded Node.js archive failed its SHA-256 check.")
        partial.replace(target)
    return target


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def data_filter(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    path = info.name.removeprefix("./")
    if info.isdir():
        info.mode = 0o755
    elif path in {
        "usr/bin/clawboot",
        "usr/local/libexec/clawboot-helper",
        "opt/clawboot/bin/clawboot-service",
    }:
        info.mode = 0o755
    elif path == "etc/sudoers.d/clawboot":
        info.mode = 0o440
    else:
        info.mode = 0o644
    return info


def add_node_runtime(output: tarfile.TarFile, archive_path: Path) -> int:
    installed_bytes = 0
    prefix = f"node-v{NODE_VERSION}-linux-arm64/"
    with tarfile.open(archive_path, "r:xz") as source:
        for member in source.getmembers():
            if member.name == prefix.rstrip("/"):
                continue
            if not member.name.startswith(prefix):
                raise RuntimeError(f"Unexpected path in Node.js archive: {member.name}")
            relative = member.name[len(prefix):]
            parts = PurePosixPath(relative).parts
            if not relative or ".." in parts:
                raise RuntimeError(f"Unsafe path in Node.js archive: {member.name}")
            transformed = copy.copy(member)
            transformed.name = f"./opt/clawboot/runtime/{relative}"
            transformed.uid = transformed.gid = 0
            transformed.uname = transformed.gname = "root"
            payload = source.extractfile(member) if member.isfile() else None
            output.addfile(transformed, payload)
            installed_bytes += member.size
    return installed_bytes


def add_bytes(output: tarfile.TarFile, name: str, value: bytes, mode: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(value)
    info.mode = mode
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = int(time.time())
    output.addfile(info, io.BytesIO(value))


def build_control_archive(root: Path, target: Path, installed_kib: int) -> None:
    control = (root / "packaging/debian/control").read_text(encoding="utf-8").rstrip()
    control = f"{control}\nInstalled-Size: {installed_kib}\n"
    with tarfile.open(target, "w:xz", format=tarfile.PAX_FORMAT) as output:
        add_bytes(output, "./control", control.encode(), 0o644)
        for name in ("postinst", "prerm", "postrm"):
            body = (root / f"packaging/debian/{name}").read_bytes().replace(b"\r\n", b"\n")
            add_bytes(output, f"./{name}", body, 0o755)


def ar_header(name: str, size: int) -> bytes:
    fields = (
        f"{name + '/':<16}"
        f"{int(time.time()):<12}"
        f"{0:<6}"
        f"{0:<6}"
        f"{0o100644:<8o}"
        f"{size:<10}`\n"
    )
    encoded = fields.encode("ascii")
    if len(encoded) != 60:
        raise RuntimeError("Invalid ar member header.")
    return encoded


def build_deb(target: Path, members: list[tuple[str, Path | bytes]]) -> None:
    with target.open("wb") as output:
        output.write(b"!<arch>\n")
        for name, source in members:
            body = source if isinstance(source, bytes) else source.read_bytes()
            output.write(ar_header(name, len(body)))
            output.write(body)
            if len(body) % 2:
                output.write(b"\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--cache", type=Path, default=None)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    output = (args.output or root.parent / f"clawboot_{PACKAGE_VERSION}_arm64.deb").resolve()
    cache = (args.cache or root.parent.parent / "work/downloads").resolve()
    if not (root / "dist/client/index.html").is_file():
        raise RuntimeError("Run npm run build before creating the Debian package.")

    node_archive = download_node(cache)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="clawboot-deb-") as temporary:
        work = Path(temporary)
        stage = work / "data"
        prepare_data_tree(root, stage)
        data_tar = work / "data.tar.xz"
        staged_size = sum(path.stat().st_size for path in stage.rglob("*") if path.is_file())
        with tarfile.open(data_tar, "w:xz", format=tarfile.PAX_FORMAT) as data:
            for child in sorted(stage.iterdir()):
                data.add(child, arcname=f"./{child.name}", recursive=True, filter=data_filter)
            node_size = add_node_runtime(data, node_archive)
        control_tar = work / "control.tar.xz"
        build_control_archive(root, control_tar, (staged_size + node_size + 1023) // 1024)
        build_deb(
            output,
            [
                ("debian-binary", b"2.0\n"),
                ("control.tar.xz", control_tar),
                ("data.tar.xz", data_tar),
            ],
        )
    print(f"Built {output}")
    print(f"SHA256 {sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
