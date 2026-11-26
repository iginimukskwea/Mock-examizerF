"""Optional high-precision Japanese/math OCR bridge for Mock examizerF.

Reads a JSON file: {"images": ["/path/a.png", ...], "engine": "auto"}
Writes one JSON object to stdout: {"engine": "...", "texts": [...], "errors": [...]}

The Node side only uses this when Python and one of pix2text /
rapidocr_onnxruntime / paddleocr is available. Any failure is reported here and
the caller falls back to preprocessed Tesseract.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys


def sort_key(box):
    try:
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        return (min(ys), min(xs))
    except Exception:
        return (0.0, 0.0)


def result_to_text(result) -> str:
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if isinstance(result, dict):
        for key in (
            "text",
            "text_with_formula",
            "text_formula",
            "markdown",
            "content",
        ):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        for key in ("results", "lines", "pages"):
            value = result.get(key)
            if isinstance(value, (list, dict)):
                text = result_to_text(value)
                if text:
                    return text
        return ""
    if isinstance(result, (list, tuple)):
        parts = []
        for item in result:
            text = result_to_text(item)
            if text:
                parts.append(text)
        return "\n".join(parts).strip()
    return str(result).strip()


def run_pix2text(path: str) -> str:
    from pix2text import Pix2Text

    p2t = Pix2Text.from_config()
    calls = [
        lambda: p2t.recognize_text_formula(path),
        lambda: p2t.recognize(path, file_type="text_formula", return_text=True),
        lambda: p2t.recognize(path, file_type="text_formula"),
        lambda: p2t.recognize(path, return_text=True),
        lambda: p2t.recognize(path),
    ]
    last_error = None
    for call in calls:
        try:
            result = call()
            text = result_to_text(result)
            if text:
                return text
        except Exception as exc:  # API differs between pix2text releases.
            last_error = exc
    if last_error:
        raise last_error
    return ""


def run_rapidocr(path: str) -> str:
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    result, _ = engine(path)
    if result is None:
        return ""

    rows = []
    for row in result:
        if isinstance(row, (list, tuple)) and len(row) >= 2:
            box, text = row[0], row[1]
            score = row[2] if len(row) > 2 else 1.0
            try:
                score = float(score)
            except Exception:
                score = 1.0
            if score < 0.35:
                continue
            rows.append((sort_key(box), str(text)))
        elif hasattr(row, "txt"):
            rows.append(((0.0, 0.0), str(row.txt)))

    rows.sort(key=lambda item: item[0])
    return "\n".join(text for _, text in rows if text.strip()).strip()


def paddle_result_to_text(result) -> str:
    if result is None:
        return ""
    if isinstance(result, dict):
        texts = result.get("rec_texts") or result.get("texts")
        if isinstance(texts, list):
            return "\n".join(str(text) for text in texts if str(text).strip())
        return result_to_text(result)
    if isinstance(result, (list, tuple)):
        rows = []
        for page in result:
            if isinstance(page, dict):
                text = paddle_result_to_text(page)
                if text:
                    rows.append(((0.0, 0.0), text))
                continue
            if not isinstance(page, (list, tuple)):
                continue
            for line in page:
                if not isinstance(line, (list, tuple)) or len(line) < 2:
                    continue
                box, payload = line[0], line[1]
                text = ""
                score = 1.0
                if isinstance(payload, (list, tuple)) and payload:
                    text = str(payload[0])
                    if len(payload) > 1:
                        try:
                            score = float(payload[1])
                        except Exception:
                            pass
                elif isinstance(payload, str):
                    text = payload
                if text.strip() and score >= 0.35:
                    rows.append((sort_key(box), text))
        rows.sort(key=lambda item: item[0])
        return "\n".join(text for _, text in rows).strip()
    return str(result)


def run_paddleocr(path: str) -> str:
    from paddleocr import PaddleOCR

    try:
        ocr = PaddleOCR(use_angle_cls=True, lang="japan", show_log=False)
    except TypeError:
        ocr = PaddleOCR(lang="japan")

    try:
        result = ocr.ocr(path, cls=True)
    except Exception:
        result = ocr.predict(path)
    return paddle_result_to_text(result)


ENGINES = {
    "pix2text": run_pix2text,
    "rapidocr": run_rapidocr,
    "paddleocr": run_paddleocr,
}


def main() -> None:
    # Node reads stdout as UTF-8; force it even on a CP932 Windows console.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8-sig") as handle:
        payload = json.load(handle)

    images = payload.get("images", [])
    requested = payload.get("engine", "auto")
    candidates = (
        [requested]
        if requested in ENGINES
        else ["pix2text", "rapidocr", "paddleocr"]
    )

    result = {"engine": "none", "texts": [], "errors": []}
    all_errors = []

    with contextlib.redirect_stdout(sys.stderr):
        for name in candidates:
            function = ENGINES[name]
            texts = []
            errors = []
            try:
                for image in images:
                    try:
                        text = function(image)
                        texts.append(text)
                        if not text.strip():
                            errors.append(
                                f"{os.path.basename(image)}: 空のOCR結果"
                            )
                    except Exception as exc:
                        texts.append("")
                        errors.append(
                            f"{os.path.basename(image)}: "
                            f"{type(exc).__name__}: {exc}"
                        )
                if any(text.strip() for text in texts):
                    result = {
                        "engine": name,
                        "texts": texts,
                        "errors": errors,
                    }
                    break
                result = {"engine": "none", "texts": texts, "errors": errors}
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
                result = {"engine": "none", "texts": [], "errors": errors}
            all_errors.extend(f"[{name}] {message}" for message in errors)

    if result["engine"] == "none" and all_errors:
        result["errors"] = all_errors

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
