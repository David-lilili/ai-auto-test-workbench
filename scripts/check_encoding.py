from __future__ import annotations

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path


SKIP_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
    ".pytest_cache",
}

TEXT_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".md",
    ".txt",
    ".sql",
    ".ps1",
    ".sh",
}

TEXT_NAMES = {".env.example"}

MOJIBAKE_MARKERS = [
    "\u934f",
    "\u95b8",
    "\u7ecb",
    "\u93c2",
    "\u70d8",
    "\u9352",
    "\u9366",
    "\u951b",
    "\ue5c5",
    "\ufffd",
    "\u00c2",
    "\u00e2\u20ac",
    "\u9225",
    "\u9422",
    "\u9435",
    "\u934b",
    "\u9366",
    "\u7f03",
]

MOJIBAKE_CLUSTER_CODEPOINTS = {
    0x6D93,
    0x93C4,
    0x95C3,
    0x7F02,
    0x9359,
    0x4E67,
    0x934F,
    0x95B8,
    0x7ECB,
    0x93C2,
    0x70D8,
    0x9422,
    0x6924,
    0x572D,
    0x7586,
    0x6DC7,
}

UTF8_BOM = b"\xef\xbb\xbf"


@dataclass(frozen=True)
class Finding:
    file: Path
    issue_type: str
    line: int
    detail: str


def main() -> int:
    parser = argparse.ArgumentParser(description="Check project text files for UTF-8 no BOM and obvious mojibake.")
    parser.add_argument("paths", nargs="*", default=["."], help="Paths to scan. Defaults to current project.")
    parser.add_argument("--include-codex-catalog", action="store_true", default=True, help="Also scan ~/.codex/cc-switch-model-catalog.json when present.")
    parser.add_argument("--include-codex-attachments", action="store_true", default=True, help="Also scan ~/.codex/attachments pasted text files when present.")
    args = parser.parse_args()

    roots = [Path(item).resolve() for item in args.paths]
    if args.include_codex_catalog:
        catalog = Path.home() / ".codex" / "cc-switch-model-catalog.json"
        if catalog.exists():
            roots.append(catalog)
    if args.include_codex_attachments:
        attachments = Path.home() / ".codex" / "attachments"
        if attachments.exists():
            roots.append(attachments)

    findings: list[Finding] = []
    for root in roots:
        if root.is_file():
            findings.extend(check_file(root))
        elif root.exists():
            for file_path in iter_text_files(root):
                findings.extend(check_file(file_path))

    if findings:
        for finding in findings:
            rel = relative_display(finding.file)
            safe_print(f"{rel}:{finding.line}: {finding.issue_type}: {finding.detail}")
        safe_print(f"\nEncoding check failed: {len(findings)} issue(s).")
        return 1

    safe_print("Encoding check passed: UTF-8 no BOM, no obvious mojibake markers.")
    return 0


def iter_text_files(root: Path):
    for current_root, dir_names, file_names in os.walk(root):
        dir_names[:] = [name for name in dir_names if name not in SKIP_DIRS]
        current = Path(current_root)
        if current.name == ".idea":
            file_names[:] = [name for name in file_names if name != "workspace.xml"]
        for name in file_names:
            file_path = current / name
            if is_target_text_file(file_path):
                yield file_path


def is_target_text_file(file_path: Path) -> bool:
    if file_path.name.endswith(".source.txt"):
        return False
    return file_path.name in TEXT_NAMES or file_path.suffix.lower() in TEXT_SUFFIXES


def check_file(file_path: Path) -> list[Finding]:
    try:
        data = file_path.read_bytes()
    except OSError as error:
        return [Finding(file_path, "read_error", 0, str(error))]

    if is_binary(data):
        return []

    findings: list[Finding] = []
    if data.startswith(UTF8_BOM):
        findings.append(Finding(file_path, "utf8_bom", 1, "UTF-8 BOM is not allowed."))
        data = data[len(UTF8_BOM) :]

    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        detail = f"not valid UTF-8 at byte {error.start}"
        try:
            data.decode("gb18030")
            detail += "; file is probably GBK/ANSI and must be converted explicitly"
        except UnicodeDecodeError:
            detail += "; file is neither UTF-8 nor GB18030 text"
        findings.append(Finding(file_path, "utf8_decode_error", 1, detail))
        return findings

    for line_no, line in enumerate(text.splitlines(), start=1):
        marker = first_mojibake_marker(line)
        if marker:
            findings.append(Finding(file_path, "mojibake_marker", line_no, f"found suspicious marker {marker!r}: {line.strip()[:160]}"))
            break

    return findings


def is_binary(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    if not data:
        return False
    sample = data[:4096]
    control = sum(1 for byte in sample if byte < 9 or (13 < byte < 32))
    return control / len(sample) > 0.08


def first_mojibake_marker(line: str) -> str | None:
    plain_line = strip_markdown_inline_code(line)
    for marker in MOJIBAKE_MARKERS:
        if marker in plain_line:
            return marker
    if re.search(r"\?{4,}", plain_line):
        return "question-mark-run"
    cluster_count = sum(1 for char in plain_line if ord(char) in MOJIBAKE_CLUSTER_CODEPOINTS)
    if cluster_count >= 3:
        return "mojibake-cjk-cluster"
    return None


def strip_markdown_inline_code(line: str) -> str:
    return re.sub(r"`[^`]*`", "", line)


def relative_display(file_path: Path) -> str:
    try:
        return str(file_path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(file_path)


def safe_print(value: str) -> None:
    print(value.encode("ascii", errors="backslashreplace").decode("ascii"))


if __name__ == "__main__":
    sys.exit(main())
