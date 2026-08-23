#!/usr/bin/env python3
"""Bounded workspace archive/list operations for the trusted sandbox runtime."""

from __future__ import annotations

import argparse
import io
import json
import os
import pathlib
import stat
import tarfile
import zipfile

MAX_PATH = 1_024


def workspace_path(value: str) -> pathlib.Path:
    path = pathlib.Path(value)
    if not path.is_absolute() or path.parts[:2] != ("/", "workspace"):
        raise ValueError("path must remain inside /workspace")
    normalized = pathlib.Path(os.path.normpath(path))
    if str(normalized) != value:
        raise ValueError("path must be canonical")
    return normalized


def safe_member_name(name: str) -> bool:
    if not name or len(name) > MAX_PATH or "\x00" in name or "\\" in name:
        return False
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        return False
    return all(part not in ("", ".", "..") for part in path.parts)


def regular_mode(mode: int) -> bool:
    if mode == 0 or stat.S_IFMT(mode) == 0:
        return True
    return stat.S_ISREG(mode) or stat.S_ISDIR(mode)


def extract_zip(archive: pathlib.Path, destination: pathlib.Path, limits: dict[str, int]) -> int:
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        if len(infos) > limits["max_files"]:
            raise ValueError("archive has too many files")
        total = 0
        destination.mkdir(parents=True, exist_ok=True)
        for info in infos:
            if not safe_member_name(info.filename):
                raise ValueError("unsafe archive member path")
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and not regular_mode(mode):
                raise ValueError("unsafe archive member type")
            if info.is_dir():
                (destination / info.filename).mkdir(parents=True, exist_ok=True)
                continue
            if info.file_size > limits["max_file_bytes"]:
                raise ValueError("archive member exceeds size limit")
            total += info.file_size
            if total > limits["max_total_bytes"]:
                raise ValueError("archive exceeds total size limit")
            target = destination / info.filename
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as source, target.open("wb") as output:
                remaining = info.file_size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("truncated archive member")
                    output.write(chunk)
                    remaining -= len(chunk)
        return len(infos)


def extract_tar(archive: pathlib.Path, destination: pathlib.Path, limits: dict[str, int]) -> int:
    with tarfile.open(archive, "r:*") as tf:
        members = tf.getmembers()
        if len(members) > limits["max_files"]:
            raise ValueError("archive has too many files")
        total = 0
        destination.mkdir(parents=True, exist_ok=True)
        for member in members:
            if not safe_member_name(member.name):
                raise ValueError("unsafe archive member path")
            if not regular_mode(member.mode):
                raise ValueError("unsafe archive member type")
            if member.isdir():
                (destination / member.name).mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile() or member.size > limits["max_file_bytes"]:
                raise ValueError("unsafe or oversized archive member")
            total += member.size
            if total > limits["max_total_bytes"]:
                raise ValueError("archive exceeds total size limit")
            target = destination / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tf.extractfile(member)
            if source is None:
                raise ValueError("archive member is not readable")
            with source, target.open("wb") as output:
                remaining = member.size
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("truncated archive member")
                    output.write(chunk)
                    remaining -= len(chunk)
        return len(members)


def create_zip(source: pathlib.Path, output: pathlib.Path, limits: dict[str, int]) -> None:
    if not source.is_dir():
        raise ValueError("archive source must be a directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if len(files) > limits["max_files"]:
        raise ValueError("source has too many files")
    total = sum(path.stat().st_size for path in files)
    if total > limits["max_total_bytes"]:
        raise ValueError("source exceeds total size limit")
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            relative = path.relative_to(source)
            if len(str(relative)) > MAX_PATH:
                raise ValueError("source path is too long")
            zf.write(path, relative)


def list_files(path: pathlib.Path) -> None:
    if not path.exists():
        raise FileNotFoundError(path)
    files = []
    for path in sorted(path.rglob("*")):
        relative = path.relative_to(pathlib.Path("/workspace"))
        files.append(
            {
                "path": str(relative),
                "type": "directory" if path.is_dir() else "file",
                "size": 0 if path.is_dir() else path.stat().st_size,
            }
        )
    print(json.dumps({"files": files}, separators=(",", ":")))


def remove_paths(paths: list[str]) -> None:
    for value in paths:
        path = workspace_path(value)
        if path == pathlib.Path("/workspace"):
            raise ValueError("cannot remove workspace root")
        if not path.exists():
            continue
        if path.is_dir():
            for child in sorted(path.rglob("*"), reverse=True):
                if child.is_file() or child.is_symlink():
                    child.unlink(missing_ok=True)
                elif child.is_dir():
                    child.rmdir()
            path.rmdir()
        else:
            path.unlink()


def parse_limits(arguments: argparse.Namespace) -> dict[str, int]:
    return {
        "max_files": arguments.max_files,
        "max_file_bytes": arguments.max_file_bytes,
        "max_total_bytes": arguments.max_total_bytes,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    extract = commands.add_parser("extract")
    extract.add_argument("--archive", required=True)
    extract.add_argument("--destination", required=True)
    extract.add_argument("--max-files", type=int, default=2_000)
    extract.add_argument("--max-file-bytes", type=int, default=26_214_400)
    extract.add_argument("--max-total-bytes", type=int, default=104_857_600)
    create = commands.add_parser("create")
    create.add_argument("--source", required=True)
    create.add_argument("--output", required=True)
    create.add_argument("--max-files", type=int, default=2_000)
    create.add_argument("--max-total-bytes", type=int, default=104_857_600)
    listing = commands.add_parser("list")
    listing.add_argument("--path", default="/workspace")
    remove = commands.add_parser("remove")
    remove.add_argument("--path", action="append", required=True)
    arguments = parser.parse_args()

    if arguments.command == "extract":
        archive = workspace_path(arguments.archive)
        destination = workspace_path(arguments.destination)
        limits = parse_limits(arguments)
        count = (
            extract_zip(archive, destination, limits)
            if zipfile.is_zipfile(archive)
            else extract_tar(archive, destination, limits)
        )
        print(json.dumps({"extracted": count}, separators=(",", ":")))
    elif arguments.command == "create":
        source = workspace_path(arguments.source)
        output = workspace_path(arguments.output)
        create_zip(
            source,
            output,
            {"max_files": arguments.max_files, "max_total_bytes": arguments.max_total_bytes},
        )
        print(json.dumps({"output": str(output)}, separators=(",", ":")))
    elif arguments.command == "list":
        list_files(workspace_path(arguments.path))
    else:
        remove_paths(arguments.path)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(f"SANDBOX_ARCHIVE_ERROR: {error}") from error
