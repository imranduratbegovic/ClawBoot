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
import urllib.request


PACKAGE_VERSION = "1.2.0"
NODE_VERSION = "24.18.0"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-linux-arm64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
NODE_SHA256 = "58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6"
# A fixed fallback makes local builds reproducible even when the caller does
# not provide the standard reproducible-builds timestamp.
DEFAULT_SOURCE_DATE_EPOCH = 946684800  # 2000-01-01T00:00:00Z
TEXT_ASSET_SUFFIXES = {
    ".css",
    ".html",
    ".js",
    ".json",
    ".map",
    ".mjs",
    ".rsc",
    ".svg",
    ".txt",
}


def source_date_epoch() -> int:
    raw = os.environ.get("SOURCE_DATE_EPOCH", str(DEFAULT_SOURCE_DATE_EPOCH))
    try:
        epoch = int(raw, 10)
    except ValueError as error:
        raise RuntimeError("SOURCE_DATE_EPOCH must be a non-negative integer.") from error
    # The ar timestamp field is twelve bytes including padding, so eleven
    # decimal digits is the largest unambiguous value it can contain.
    if epoch < 0 or epoch > 99_999_999_999:
        raise RuntimeError("SOURCE_DATE_EPOCH is outside the supported ar timestamp range.")
    return epoch


def copy_file(source: Path, target: Path, *, normalize_newlines: bool = False) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    body = source.read_bytes()
    if normalize_newlines:
        body = body.replace(b"\r\n", b"\n")
    target.write_bytes(body)


def copy_script(source: Path, target: Path) -> None:
    copy_file(source, target, normalize_newlines=True)


def copy_tree(source: Path, target: Path) -> None:
    """Copy generated/runtime files without inheriting host metadata or EOLs."""
    for child in sorted(source.rglob("*"), key=lambda path: path.relative_to(source).as_posix()):
        destination = target / child.relative_to(source)
        if child.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        elif child.is_file():
            copy_file(
                child,
                destination,
                normalize_newlines=child.suffix.lower() in TEXT_ASSET_SUFFIXES,
            )
        else:
            raise RuntimeError(f"Unsupported staged file type: {child}")


def prepare_data_tree(root: Path, stage: Path) -> None:
    copy_tree(root / "setupd", stage / "opt/clawboot/setupd")
    copy_tree(root / "dist/client", stage / "opt/clawboot/dist/client")
    (stage / "opt/clawboot/VERSION").write_bytes(f"{PACKAGE_VERSION}\n".encode("ascii"))
    copy_script(root / "packaging/clawboot-service", stage / "opt/clawboot/bin/clawboot-service")
    copy_script(root / "packaging/clawboot-repair", stage / "opt/clawboot/bin/clawboot-repair")
    copy_script(root / "desktop/clawboot", stage / "usr/bin/clawboot")
    copy_script(root / "packaging/clawboot-helper", stage / "usr/local/libexec/clawboot-helper")
    copy_file(
        root / "packaging/clawboot.sudoers",
        stage / "etc/sudoers.d/clawboot",
        normalize_newlines=True,
    )
    copy_file(
        root / "packaging/clawboot.service",
        stage / "usr/lib/systemd/system/clawboot.service",
        normalize_newlines=True,
    )
    copy_file(
        root / "packaging/io.openclaw.ClawBoot.desktop",
        stage / "usr/share/applications/io.openclaw.ClawBoot.desktop",
        normalize_newlines=True,
    )
    copy_file(
        root / "packaging/io.openclaw.ClawBoot.metainfo.xml",
        stage / "usr/share/metainfo/io.openclaw.ClawBoot.metainfo.xml",
        normalize_newlines=True,
    )
    for size in (64, 128, 256):
        copy_file(
            root / f"packaging/icons/{size}x{size}/clawboot.png",
            stage / f"usr/share/icons/hicolor/{size}x{size}/apps/clawboot.png",
        )
    copy_file(
        root / "LICENSE",
        stage / "usr/share/doc/clawboot/copyright",
        normalize_newlines=True,
    )


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


def data_filter(info: tarfile.TarInfo, epoch: int) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = epoch
    info.pax_headers = {}
    path = info.name.removeprefix("./")
    if info.isdir():
        info.mode = 0o755
    elif path in {
        "usr/bin/clawboot",
        "usr/local/libexec/clawboot-helper",
        "opt/clawboot/bin/clawboot-service",
        "opt/clawboot/bin/clawboot-repair",
    }:
        info.mode = 0o755
    elif path == "etc/sudoers.d/clawboot":
        info.mode = 0o440
    else:
        info.mode = 0o644
    return info


def add_staged_tree(output: tarfile.TarFile, stage: Path, epoch: int) -> None:
    """Add the staged filesystem in a platform-independent lexical order."""
    for source in sorted(stage.rglob("*"), key=lambda path: path.relative_to(stage).as_posix()):
        relative = source.relative_to(stage).as_posix()
        output.add(
            source,
            arcname=f"./{relative}",
            recursive=False,
            filter=lambda info: data_filter(info, epoch),
        )


def add_node_runtime(output: tarfile.TarFile, archive_path: Path, epoch: int) -> int:
    installed_bytes = 0
    prefix = f"node-v{NODE_VERSION}-linux-arm64/"
    runtime_root = tarfile.TarInfo("./opt/clawboot/runtime")
    runtime_root.type = tarfile.DIRTYPE
    runtime_root.mode = 0o755
    runtime_root.uid = runtime_root.gid = 0
    runtime_root.uname = runtime_root.gname = "root"
    runtime_root.mtime = epoch
    output.addfile(runtime_root)
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
            transformed.mtime = epoch
            transformed.pax_headers = {}
            payload = source.extractfile(member) if member.isfile() else None
            output.addfile(transformed, payload)
            installed_bytes += member.size
    return installed_bytes


def add_bytes(output: tarfile.TarFile, name: str, value: bytes, mode: int, epoch: int) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(value)
    info.mode = mode
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = epoch
    output.addfile(info, io.BytesIO(value))


def build_control_archive(root: Path, target: Path, installed_kib: int, epoch: int) -> None:
    control = (root / "packaging/debian/control").read_text(encoding="utf-8").rstrip()
    control = f"{control}\nInstalled-Size: {installed_kib}\n"
    # dpkg rejects POSIX PAX extended headers in package filesystem archives.
    # GNU tar format supports the Node.js runtime's long paths without emitting
    # the unsupported PAX type-x records.
    with tarfile.open(target, "w:xz", format=tarfile.GNU_FORMAT) as output:
        add_bytes(output, "./control", control.encode(), 0o644, epoch)
        for name in ("preinst", "postinst", "prerm", "postrm"):
            body = (root / f"packaging/debian/{name}").read_bytes().replace(b"\r\n", b"\n")
            add_bytes(output, f"./{name}", body, 0o755, epoch)


def ar_header(name: str, size: int, epoch: int) -> bytes:
    fields = (
        f"{name + '/':<16}"
        f"{epoch:<12}"
        f"{0:<6}"
        f"{0:<6}"
        f"{0o100644:<8o}"
        f"{size:<10}`\n"
    )
    encoded = fields.encode("ascii")
    if len(encoded) != 60:
        raise RuntimeError("Invalid ar member header.")
    return encoded


def build_deb(target: Path, members: list[tuple[str, Path | bytes]], epoch: int) -> None:
    with target.open("wb") as output:
        output.write(b"!<arch>\n")
        for name, source in members:
            body = source if isinstance(source, bytes) else source.read_bytes()
            output.write(ar_header(name, len(body), epoch))
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
    epoch = source_date_epoch()
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
        with tarfile.open(data_tar, "w:xz", format=tarfile.GNU_FORMAT) as data:
            add_staged_tree(data, stage, epoch)
            node_size = add_node_runtime(data, node_archive, epoch)
        control_tar = work / "control.tar.xz"
        build_control_archive(root, control_tar, (staged_size + node_size + 1023) // 1024, epoch)
        partial = output.with_name(f"{output.name}.partial")
        partial.unlink(missing_ok=True)
        try:
            build_deb(
                partial,
                [
                    ("debian-binary", b"2.0\n"),
                    ("control.tar.xz", control_tar),
                    ("data.tar.xz", data_tar),
                ],
                epoch,
            )
            partial.replace(output)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
    print(f"Built {output}")
    print(f"SHA256 {sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
