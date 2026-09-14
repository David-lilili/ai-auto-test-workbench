from __future__ import annotations

import argparse
import json
from pathlib import Path


UTF8_BOM = b"\xef\xbb\xbf"
MARKERS = {
    "replacement_char": "\ufffd",
    "question_mark_run": "?" * 4,
    "u6d93": chr(0x6D93),
    "u93c4": chr(0x93C4),
    "u95c3": chr(0x95C3),
    "u7f02": chr(0x7F02),
    "u9359": chr(0x9359),
    "u4e67": chr(0x4E67),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect one text file for UTF-8/BOM/mojibake indicators.")
    parser.add_argument("path", help="Text file to inspect.")
    args = parser.parse_args()

    file_path = Path(args.path).expanduser().resolve()
    data = file_path.read_bytes()
    bom = data.startswith(UTF8_BOM)
    payload = data[len(UTF8_BOM) :] if bom else data

    try:
        text = payload.decode("utf-8")
        encoding = "utf-8"
        valid_utf8 = True
    except UnicodeDecodeError:
        text = payload.decode("utf-8", errors="replace")
        encoding = "invalid-utf-8"
        valid_utf8 = False

    marker_hits = {
        name: {
            "present": marker in text,
            "count": text.count(marker),
            "firstLine": first_line(text, marker),
        }
        for name, marker in MARKERS.items()
    }

    result = {
        "path": str(file_path),
        "bytes": len(data),
        "encodingGuess": encoding,
        "validUtf8": valid_utf8,
        "utf8Bom": bom,
        "containsMojibakeMarker": any(item["present"] for item in marker_hits.values()),
        "markers": marker_hits,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["containsMojibakeMarker"] or bom or not valid_utf8 else 0


def first_line(text: str, marker: str) -> int | None:
    for line_no, line in enumerate(text.splitlines(), start=1):
        if marker in line:
            return line_no
    return None


if __name__ == "__main__":
    raise SystemExit(main())
