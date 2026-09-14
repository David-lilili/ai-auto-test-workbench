from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from check_encoding import SKIP_DIRS, TEXT_NAMES, TEXT_SUFFIXES, UTF8_BOM, is_binary


def main() -> int:
    parser = argparse.ArgumentParser(description="Fix safe encoding issues. Defaults to removing UTF-8 BOM only.")
    parser.add_argument("paths", nargs="*", default=["."], help="Paths to scan. Defaults to current project.")
    parser.add_argument("--from", dest="source_encoding", choices=["gbk", "gb18030"], help="Convert non-UTF-8 text files from GBK/GB18030 to UTF-8 no BOM.")
    parser.add_argument("--check", action="store_true", help="Print fixable files without modifying them.")
    args = parser.parse_args()

    files = collect_files([Path(item).resolve() for item in args.paths])
    bom_files: list[Path] = []
    converted_files: list[Path] = []

    for file_path in files:
        data = file_path.read_bytes()
        if is_binary(data):
            continue
        if data.startswith(UTF8_BOM):
            bom_files.append(file_path)
            continue
        if args.source_encoding and not can_decode_utf8(data):
            try:
                data.decode("gb18030")
            except UnicodeDecodeError:
                continue
            converted_files.append(file_path)

    if not bom_files and not converted_files:
        print("No safe encoding fixes found.")
        return run_check()

    if bom_files:
        print("Removing UTF-8 BOM from:")
        for file_path in bom_files:
            print(f"  {display(file_path)}")
    if converted_files:
        print(f"Converting {args.source_encoding} text files to UTF-8 no BOM:")
        for file_path in converted_files:
            print(f"  {display(file_path)}")

    if args.check:
        print("\nCheck mode: no files were modified.")
        return 1

    for file_path in bom_files:
        data = file_path.read_bytes()
        file_path.write_bytes(data[len(UTF8_BOM) :])

    for file_path in converted_files:
        text = file_path.read_bytes().decode("gb18030")
        file_path.write_text(text, encoding="utf-8", newline="")

    return run_check()


def collect_files(roots: list[Path]) -> list[Path]:
    files: list[Path] = []
    for root in roots:
        if root.is_file() and is_target_text_file(root):
            files.append(root)
            continue
        if not root.exists():
            continue
        for file_path in root.rglob("*"):
            if any(part in SKIP_DIRS for part in file_path.parts):
                continue
            if file_path.parent.name == ".idea" and file_path.name == "workspace.xml":
                continue
            if file_path.is_file() and is_target_text_file(file_path):
                files.append(file_path)
    return files


def is_target_text_file(file_path: Path) -> bool:
    return file_path.name in TEXT_NAMES or file_path.suffix.lower() in TEXT_SUFFIXES


def can_decode_utf8(data: bytes) -> bool:
    try:
        data.decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def run_check() -> int:
    print("\nRunning encoding check...")
    return subprocess.call([sys.executable, str(Path(__file__).with_name("check_encoding.py"))])


def display(file_path: Path) -> str:
    try:
        return str(file_path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(file_path)


if __name__ == "__main__":
    sys.exit(main())
