import base64
import hashlib
import html
import json
import os
import pathlib
import re
import sys
from typing import Any, Dict, List, Optional, Tuple


def get_runtime_root() -> pathlib.Path:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return pathlib.Path(meipass).resolve()

        executable = getattr(sys, "executable", "")
        if executable:
            return pathlib.Path(executable).resolve().parent

    return pathlib.Path(__file__).resolve().parent


def hydrate_bundled_sys_path() -> None:
    script_dir = get_runtime_root()
    candidates = [
        script_dir / "site-packages",
        script_dir / ".python-packages",
    ]

    extra_pythonpath = os.environ.get("PYTHONPATH", "")
    for entry in extra_pythonpath.split(os.pathsep):
        if entry.strip():
            candidates.append(pathlib.Path(entry.strip()))

    inserted: List[str] = []
    for candidate in candidates:
        if candidate.exists():
            resolved = str(candidate.resolve())
            if resolved not in inserted:
                sys.path.insert(0, resolved)
                inserted.append(resolved)


hydrate_bundled_sys_path()


def normalize_inline_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\u00A0", " ").strip())


def normalize_multiline_text(value: str) -> Optional[str]:
    normalized = (
        value.replace("\r\n", "\n")
        .replace("\u00A0", " ")
        .replace("\u200B", "")
        .replace("\u200C", "")
        .replace("\u200D", "")
        .replace("\uFEFF", "")
    )
    normalized = re.sub(r"\u0000", " ", normalized)
    normalized = re.sub(r"[ \t]+\n", "\n", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    normalized = normalized.strip()
    return normalized or None


def clamp_probability(value: Optional[float]) -> float:
    if value is None:
        return 0.0

    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return 0.0

    return max(0.0, min(1.0, numeric))


RESUME_HEADINGS = {
    "ABOUT",
    "ABOUT ME",
    "ABOUT MYSELF",
    "PROFILE",
    "SUMMARY",
    "PROFESSIONAL SUMMARY",
    "PERSONAL PROFILE",
    "EXPERIENCE",
    "WORK EXPERIENCE",
    "EDUCATION",
    "EDUCATION AND TRAINING",
    "SKILLS",
    "TECHNICAL SKILLS",
    "CORE SKILLS",
    "KEY SKILLS",
    "PROJECTS",
    "LANGUAGES",
    "LANGUAGE SKILLS",
    "CERTIFICATIONS",
}

MONTH_PATTERN = (
    r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|"
    r"Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|"
    r"Nov(?:ember)?|Dec(?:ember)?)"
)

DATE_RANGE_PATTERN = re.compile(
    rf"((?:\d{{4}}-\d{{2}}(?:-\d{{2}})?)|(?:\d{{1,2}}/\d{{1,2}}/\d{{4}})|(?:\d{{1,2}}/\d{{4}})|(?:\d{{4}})|(?:{MONTH_PATTERN}\s+\d{{4}}))\s*[–—-]\s*"
    rf"(Current|Present|(?:\d{{4}}-\d{{2}}(?:-\d{{2}})?)|(?:\d{{1,2}}/\d{{1,2}}/\d{{4}})|(?:\d{{1,2}}/\d{{4}})|(?:\d{{4}})|(?:{MONTH_PATTERN}\s+\d{{4}}))",
    re.IGNORECASE,
)

CONTACT_META_PATTERN = re.compile(
    r"date of birth|nationality|phone|email|website|address|skills|experience|education|"
    r"frameworks|languages|databases|tools|soft skills",
    re.IGNORECASE,
)

ROLE_COMPANY_PATTERN = re.compile(
    r"\b(?:Engineer|Developer|Designer|Manager|Director|Analyst|Consultant|Specialist|"
    r"Intern|Lead|Inc|Corp|LLC|Ltd|GmbH|Principal|Senior|Staff)\b",
    re.IGNORECASE,
)


def classify_block_kind(text: str) -> str:
    normalized = normalize_inline_text(text)

    if not normalized:
        return "unknown"

    if re.search(r"@|linkedin\.com|github\.com|https?://", normalized, re.IGNORECASE):
        return "contact"

    if DATE_RANGE_PATTERN.search(normalized):
        return "experience_header"

    if re.match(r"^(?:[-*•●])", normalized):
        return "list_item"

    if (
        normalized.upper() == normalized and len(normalized) <= 72
    ) or re.match(r"^[A-Z][A-Z\s&/.'()_-]{5,}$", normalized):
        return "heading"

    return "paragraph"


def classify_section_hint(text: str) -> str:
    normalized = normalize_inline_text(text).lower()

    if not normalized:
        return "other"

    if normalized in {
        "about",
        "about me",
        "about myself",
        "profile",
        "summary",
        "professional summary",
        "personal profile",
    }:
        return "summary"

    if normalized in {"experience", "work experience", "employment", "professional experience"}:
        return "experience"

    if normalized in {"education", "education and training"}:
        return "education"

    if normalized in {"certification", "certifications", "license", "licenses"}:
        return "certifications"

    if normalized in {
        "skills",
        "technical skills",
        "core skills",
        "key skills",
        "frameworks",
        "tools",
        "programming languages",
    }:
        return "skills"

    if normalized in {"projects", "portfolio"}:
        return "projects"

    if normalized in {"language skills", "languages"}:
        return "languages"

    if re.search(r"@|linkedin\.com|github\.com|https?://|phone|email|address", normalized, re.IGNORECASE):
        return "contact"

    if re.search(r"\b(university|college|school|bachelor|master|phd|degree)\b", normalized, re.IGNORECASE):
        return "education"

    if re.search(r"\b(engineer|developer|manager|designer|analyst|consultant|architect|officer)\b", normalized, re.IGNORECASE):
        return "identity"

    if len(normalized) >= 64:
        return "summary"

    if len(normalized) <= 80 and re.match(r"^[a-z][a-z\s.'()_-]+$", normalized, re.IGNORECASE):
        return "identity"

    return "other"


def compute_invalid_unicode_ratio(text: Optional[str]) -> float:
    if not text:
        return 0.0

    suspicious = len(re.findall(r"[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]", text))
    return suspicious / max(len(text), 1)


def build_quality_signal(
    full_text: Optional[str],
    line_count: int,
    block_count: int,
    reading_order_confidence: Optional[float],
    native_text_coverage: Optional[float],
    ocr_confidence: Optional[float],
    column_likelihood: Optional[float],
    image_coverage_ratio: Optional[float],
    invalid_unicode_ratio: Optional[float],
) -> Dict[str, Any]:
    text = full_text or ""
    token_count = len([part for part in re.split(r"\s+", text) if part])
    page_count = 1
    text_density = clamp_probability(len(text) / max(page_count * 1600, 1))
    normalized_reading_order = clamp_probability(
        reading_order_confidence if reading_order_confidence is not None else 0.9,
    )
    normalized_native_text = clamp_probability(
        native_text_coverage if native_text_coverage is not None else 1.0,
    )
    normalized_ocr = None if ocr_confidence is None else clamp_probability(ocr_confidence)
    normalized_columns = None if column_likelihood is None else clamp_probability(column_likelihood)
    normalized_image = clamp_probability(image_coverage_ratio if image_coverage_ratio is not None else 0.0)
    normalized_invalid_unicode = clamp_probability(
        invalid_unicode_ratio if invalid_unicode_ratio is not None else 0.0,
    )

    score = clamp_probability(
        normalized_reading_order * 0.38
        + normalized_native_text * 0.24
        + text_density * 0.18
        + ((normalized_ocr if normalized_ocr is not None else 0.8) * 0.08)
        + ((1 - normalized_image) * 0.06)
        + ((1 - normalized_invalid_unicode) * 0.06)
    )

    return {
        "score": score,
        "textDensity": text_density,
        "tokenCount": token_count,
        "lineCount": line_count,
        "blockCount": block_count,
        "columnLikelihood": normalized_columns,
        "readingOrderConfidence": normalized_reading_order,
        "nativeTextCoverage": normalized_native_text,
        "ocrConfidence": normalized_ocr,
        "imageCoverageRatio": normalized_image,
        "invalidUnicodeRatio": normalized_invalid_unicode,
    }


def normalize_location_label(value: Optional[str]) -> Optional[str]:
    if not value:
        return None

    cleaned = normalize_inline_text(value)
    if not cleaned:
        return None

    if re.search(r"[A-Z]{2,}", cleaned):
        words: List[str] = []
        for word in cleaned.split(" "):
            lower = word.lower()
            if lower in {"uk", "usa", "uae", "ny", "tx", "pa", "ca", "fl"}:
                words.append(word.upper())
            else:
                words.append(word[:1].upper() + word[1:].lower() if word else word)
        return " ".join(words)

    return cleaned


def clean_location_candidate(value: str) -> Optional[str]:
    trimmed = normalize_inline_text(value)
    without_prefix = re.sub(r"^Address:\s*", "", trimmed, flags=re.IGNORECASE)
    without_suffix = re.sub(r"\s*\([^)]*\)\s*$", "", without_prefix)
    without_linkedin = re.sub(r"\s+linkedin\.com/\S+$", "", without_suffix, flags=re.IGNORECASE)
    return normalize_location_label(without_linkedin)


def is_likely_location_value(value: str) -> bool:
    cleaned = clean_location_candidate(value)

    if not cleaned or len(cleaned) > 96:
        return False

    if re.search(r"[@]|https?://", cleaned, re.IGNORECASE):
        return False

    if re.search(
        r"\b(recently|decided|return|passion|experience|building|driven|improving)\b",
        cleaned,
        re.IGNORECASE,
    ):
        return False

    if re.search(r"[.!?]", cleaned):
        return False

    return bool(
        re.match(r"^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$", cleaned)
        or re.match(r"^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$", cleaned)
        or re.match(r"^[A-Za-z][A-Za-z\s.'-]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$", cleaned)
    )


def is_likely_person_name(value: str) -> bool:
    trimmed = normalize_inline_text(value)

    if not trimmed or len(trimmed) > 56:
        return False

    if re.search(r"[@\d]|https?://", trimmed, re.IGNORECASE):
        return False

    if re.search(
        r"resume|curriculum|summary|profile|experience|birth|nationality|phone|email|address|skills|linkedin",
        trimmed,
        re.IGNORECASE,
    ):
        return False

    if re.search(r"[.!?]", trimmed):
        return False

    parts = [part for part in re.split(r"\s+", trimmed) if part]
    if len(parts) < 2 or len(parts) > 4:
        return False

    if not re.match(r"^[A-Za-z][A-Za-z\s.'-]+$", trimmed):
        return False

    banned = {"Remote", "Current", "Present", "Summary", "Experience", "Profile"}
    return not any(part in banned for part in parts)


def infer_name(lines: List[str]) -> Optional[str]:
    top_lines = lines[:8]

    for line in top_lines:
        if is_likely_person_name(line):
            return line

    identity_candidates: List[str] = []
    for line in top_lines:
        candidate = normalize_inline_text(line)

        if not candidate:
            continue

        if re.search(r"[@]|https?://", candidate, re.IGNORECASE):
            continue

        if CONTACT_META_PATTERN.search(candidate):
            continue

        if DATE_RANGE_PATTERN.search(candidate):
            continue

        if ROLE_COMPANY_PATTERN.search(candidate):
            continue

        if candidate.upper() in RESUME_HEADINGS:
            continue

        if re.search(
            r"\b(?:senior|staff|principal|lead|software|engineer|developer|designer|manager|architect|consultant|analyst|mentorship)\b",
            candidate,
            re.IGNORECASE,
        ):
            continue

        parts = candidate.split()
        if len(parts) < 2 or len(parts) > 4:
            continue

        if re.match(r"^[A-Za-z][A-Za-z\s.'-]+$", candidate):
            identity_candidates.append(candidate)

    return identity_candidates[0] if identity_candidates else None


def infer_current_location(lines: List[str]) -> Optional[str]:
    address_line = next(
        (line for line in lines if re.match(r"^Address:", line, re.IGNORECASE)),
        None,
    )

    if address_line:
        cleaned = clean_location_candidate(address_line)
        if cleaned:
            return cleaned

    for line in lines[:6]:
        cleaned = clean_location_candidate(line)
        if cleaned and is_likely_location_value(cleaned):
            return cleaned

    location_hint_pattern = re.compile(
        r"\b(?:[A-Z]{2}|UK|USA|UAE|Kosovo|Canada|Germany|France|India|Japan|Australia|Singapore|"
        r"London|Toronto|Berlin|Paris|Prishtina|New York|Tampa|Philadelphia|Cedar Park|Austin|"
        r"Texas|Florida|California|Pennsylvania)\b|\b\d{5}(?:-\d{4})?\b",
        re.IGNORECASE,
    )
    degree_or_school_pattern = re.compile(
        r"\b(?:Bachelor|Master|B\.?Sc|M\.?Sc|Ph\.?D|University|College|School|Academy)\b",
        re.IGNORECASE,
    )

    for line in lines[:12]:
        candidate = clean_location_candidate(line)

        if not candidate:
            continue

        if CONTACT_META_PATTERN.search(candidate):
            continue

        if degree_or_school_pattern.search(candidate):
            continue

        if location_hint_pattern.search(candidate) and is_likely_location_value(candidate):
            return candidate

    return None


def detect_file_kind(file_path: str) -> str:
    suffix = pathlib.Path(file_path).suffix.lower()

    if suffix == ".txt":
        return "plain_text"

    if suffix in {".md", ".markdown"}:
        return "markdown"

    if suffix == ".docx":
        return "docx"

    if suffix == ".pdf":
        return "pdf"

    return "unknown"


def truncate_svg_text(value: str, limit: int = 180) -> str:
    normalized = normalize_inline_text(value)
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(0, limit - 1)].rstrip() + "…"


MAX_VISION_LINES_PER_PAGE = 48


def split_text_into_pages(text: Optional[str], max_lines_per_page: int = MAX_VISION_LINES_PER_PAGE) -> List[List[str]]:
    if not text:
        return [[]]

    lines = [normalize_inline_text(line) for line in re.split(r"\r?\n", text)]
    lines = [line for line in lines if line]

    if not lines:
        return [[]]

    return [lines[index:index + max_lines_per_page] for index in range(0, len(lines), max_lines_per_page)]


def encode_page_image(
    svg: str,
    lines: List[str],
    width: int,
    height: int,
    page_number: int,
    file_kind: str,
    render_kind: str,
    retained: str,
) -> Dict[str, Any]:
    try:
        from PIL import Image, ImageDraw, ImageFont
        from io import BytesIO

        def load_font(size: int) -> Tuple[Any, bool]:
            for candidate in (
                "arial.ttf",
                "Arial.ttf",
                "DejaVuSans.ttf",
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            ):
                try:
                    return ImageFont.truetype(candidate, size=size), True
                except Exception:
                    continue
            return ImageFont.load_default(), False

        def safe_text(value: str, is_unicode_font: bool) -> str:
            if is_unicode_font:
                return value
            return value.encode("latin-1", "replace").decode("latin-1")

        image = Image.new("RGB", (width, height), "#f8fafc")
        draw = ImageDraw.Draw(image)
        card_margin = round(min(width, height) * 36 / 1240)
        card_radius = max(4, card_margin // 2)
        text_x = round(width * 82 / 1240)
        title_y = round(height * 86 / 1754)
        body_start_y = round(height * 158 / 1754)
        line_gap = round(height * 32 / 1754)
        draw.rounded_rectangle((card_margin, card_margin, width - card_margin, height - card_margin), radius=card_radius, fill="#ffffff", outline="#d8e0eb", width=2)
        title_font, title_uses_unicode = load_font(24)
        body_font, body_uses_unicode = load_font(28)
        title = f"Resume visual import preview - page {page_number}"
        draw.text((text_x, title_y), safe_text(title, title_uses_unicode), fill="#64748b", font=title_font)

        for index, line in enumerate(lines[:MAX_VISION_LINES_PER_PAGE]):
            y = body_start_y + index * line_gap
            draw.text((text_x, y), safe_text(truncate_svg_text(line), body_uses_unicode), fill="#152033", font=body_font)

        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
        raw = output.getvalue()
        digest = hashlib.sha256(raw).hexdigest()
        return {
            "id": f"vision_page_{page_number}_{digest[:12]}",
            "sourceResumeId": "resume_source_pending",
            "sourceFileKind": file_kind,
            "pageNumber": page_number,
            "renderKind": render_kind,
            "mimeType": "image/png",
            "width": width,
            "height": height,
            "byteLength": len(raw),
            "sha256": digest,
            "dataUrl": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
            "storagePath": None if retained == "temporary" else "inline-debug-artifact",
            "retained": retained,
            "generatedAt": iso_now(),
            "warnings": [],
        }
    except Exception:
        raw = svg.encode("utf-8")
        digest = hashlib.sha256(raw).hexdigest()
        return {
            "id": f"vision_page_{page_number}_{digest[:12]}",
            "sourceResumeId": "resume_source_pending",
            "sourceFileKind": file_kind,
            "pageNumber": page_number,
            "renderKind": render_kind,
            "mimeType": "image/svg+xml",
            "width": width,
            "height": height,
            "byteLength": len(raw),
            "sha256": digest,
            "dataUrl": "data:image/svg+xml;base64," + base64.b64encode(raw).decode("ascii"),
            "storagePath": None if retained == "temporary" else "inline-debug-artifact",
            "retained": retained,
            "generatedAt": iso_now(),
            "warnings": ["Text preview fell back to SVG because Pillow rasterization was unavailable."],
        }


def render_lines_to_svg_data_url(
    lines: List[str],
    page_number: int,
    file_kind: str,
    render_kind: str,
    retained: str,
) -> Dict[str, Any]:
    width = 1240
    height = 1754
    card_margin = round(min(width, height) * 36 / 1240)
    card_radius = max(4, card_margin // 2)
    text_x = round(width * 82 / 1240)
    title_y = round(height * 86 / 1754)
    body_start_y = round(height * 158 / 1754)
    line_gap = round(height * 32 / 1754)
    font_size = 21
    escaped_title = html.escape(f"Resume visual import preview · page {page_number}")
    text_nodes: List[str] = []

    if not lines:
        lines = ["No readable text was available for this page preview."]

    for index, line in enumerate(lines[:MAX_VISION_LINES_PER_PAGE]):
        y = body_start_y + index * line_gap
        escaped_line = html.escape(truncate_svg_text(line))
        weight = "700" if index == 0 or line.upper() == line else "400"
        text_nodes.append(
            f'<text x="{text_x}" y="{y}" font-family="Arial, Helvetica, sans-serif" font-size="{font_size}" font-weight="{weight}" fill="#152033">{escaped_line}</text>'
        )

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        '<rect width="100%" height="100%" fill="#f8fafc"/>'
        f'<rect x="{card_margin}" y="{card_margin}" width="{width - 2 * card_margin}" height="{height - 2 * card_margin}" rx="{card_radius}" fill="#ffffff" stroke="#d8e0eb" stroke-width="2"/>'
        f'<text x="{text_x}" y="{title_y}" font-family="Arial, Helvetica, sans-serif" font-size="17" font-weight="700" fill="#64748b" letter-spacing="2">{escaped_title}</text>'
        + "".join(text_nodes)
        + '</svg>'
    )
    return encode_page_image(svg, lines, width, height, page_number, file_kind, render_kind, retained)


def iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def detect_retention_mode(request: Dict[str, Any]) -> str:
    raw = request.get("retention") or os.environ.get("NESTOR_RESUME_VISION_RETAIN_ARTIFACTS", "")
    normalized = str(raw).strip().lower()
    if normalized in {"debug", "debug_retained", "1", "true"}:
        return "debug_retained"
    if normalized in {"benchmark", "benchmark_retained"}:
        return "benchmark_retained"
    return "temporary"


def render_plain_or_markdown_images(file_path: str, file_kind: str, retained: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    text = extract_plain_text(file_path)
    render_kind = "markdown_rendered_preview" if file_kind == "markdown" else "text_rendered_preview"
    pages = split_text_into_pages(text)
    return [render_lines_to_svg_data_url(page, index + 1, file_kind, render_kind, retained) for index, page in enumerate(pages)], []


def render_docx_images(file_path: str, retained: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    text, _parser_kind, warnings = extract_docx_text(file_path)
    pages = split_text_into_pages(text)
    images = [render_lines_to_svg_data_url(page, index + 1, "docx", "docx_rendered_preview", retained) for index, page in enumerate(pages)]
    if text:
        warnings.append("DOCX visual import used a document-faithful text/table preview because no local DOCX-to-PDF renderer is bundled on this platform.")
    return images, warnings


def render_pdf_images(file_path: str, retained: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    try:
        import pypdfium2 as pdfium  # type: ignore

        pdf = pdfium.PdfDocument(file_path)
        images: List[Dict[str, Any]] = []
        try:
            for page_index in range(len(pdf)):
                page = pdf[page_index]
                try:
                    bitmap = page.render(scale=1.5)
                    try:
                        pil_image = bitmap.to_pil()
                        from io import BytesIO

                        output = BytesIO()
                        pil_image.save(output, format="PNG", optimize=True)
                        raw = output.getvalue()
                        digest = hashlib.sha256(raw).hexdigest()
                        images.append({
                            "id": f"vision_page_{page_index + 1}_{digest[:12]}",
                            "sourceResumeId": "resume_source_pending",
                            "sourceFileKind": "pdf",
                            "pageNumber": page_index + 1,
                            "renderKind": "pdf_page_image",
                            "mimeType": "image/png",
                            "width": int(pil_image.width),
                            "height": int(pil_image.height),
                            "byteLength": len(raw),
                            "sha256": digest,
                            "dataUrl": "data:image/png;base64," + base64.b64encode(raw).decode("ascii"),
                            "storagePath": None if retained == "temporary" else "inline-debug-artifact",
                            "retained": retained,
                            "generatedAt": iso_now(),
                            "warnings": [],
                        })
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        finally:
            pdf.close()
        return images, warnings
    except Exception as error:
        warnings.append(f"PDF page-faithful rendering was unavailable, so visual import used a rendered text preview: {error}")

    page_texts, text, _parser_kind, parse_warnings, _metadata = extract_pdf_text(file_path)
    warnings.extend(parse_warnings)
    if not page_texts and text:
        page_texts = [text]
    images = []
    page_counter = 0
    for page_text in (page_texts or [""]):
        for chunk in split_text_into_pages(page_text or ""):
            page_counter += 1
            images.append(
                render_lines_to_svg_data_url(
                    chunk,
                    page_counter,
                    "pdf",
                    "fallback_rendered_preview",
                    retained,
                )
            )
    return images, warnings


def build_vision_images_response(request: Dict[str, Any]) -> Dict[str, Any]:
    file_path = request.get("filePath")
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("Resume vision image request must include a non-empty filePath.")
    file_kind = request.get("fileKind") or detect_file_kind(file_path)
    source_resume_id = request.get("sourceResumeId") if isinstance(request.get("sourceResumeId"), str) else "resume_source_pending"
    run_id = request.get("runId") if isinstance(request.get("runId"), str) else "resume_vision_run_pending"
    artifact_id = request.get("artifactId") if isinstance(request.get("artifactId"), str) else f"resume_vision_artifact_{hashlib.sha256(file_path.encode('utf-8')).hexdigest()[:16]}"
    retained = detect_retention_mode(request)

    if file_kind in {"plain_text", "markdown"}:
        pages, warnings = render_plain_or_markdown_images(file_path, file_kind, retained)
    elif file_kind == "docx":
        pages, warnings = render_docx_images(file_path, retained)
    elif file_kind == "pdf":
        pages, warnings = render_pdf_images(file_path, retained)
    else:
        pages, warnings = [], ["Unsupported file type for local resume vision image generation."]

    patched_pages = [
        {
            **page,
            "sourceResumeId": source_resume_id,
        }
        for page in pages
    ]

    return {
        "ok": len(patched_pages) > 0,
        "artifact": {
            "id": artifact_id,
            "runId": run_id,
            "sourceResumeId": source_resume_id,
            "sourceFileKind": file_kind,
            "createdAt": iso_now(),
            "retained": retained,
            "pages": patched_pages,
            "warnings": warnings,
        },
        "warnings": warnings,
        "errorMessage": None if patched_pages else "No local resume page images could be generated.",
    }


def extract_plain_text(file_path: str) -> Optional[str]:
    return normalize_multiline_text(
        pathlib.Path(file_path).read_text(encoding="utf-8", errors="ignore"),
    )


def iter_docx_block_text(document: Any) -> List[str]:
    lines: List[str] = []
    seen_paragraphs: set[Any] = set()

    def append_text(value: str) -> None:
        normalized = normalize_inline_text(value)
        if normalized:
            lines.append(normalized)

    def walk_table(table: Any) -> None:
        for row in getattr(table, "rows", []):
            for cell in getattr(row, "cells", []):
                walk_container(cell)

    def walk_container(container: Any) -> None:
        for paragraph in getattr(container, "paragraphs", []):
            # Shared headers and merged cells may expose the same XML paragraph
            # more than once. Distinct paragraphs may legitimately repeat a job
            # title, employer, location, or date, so never deduplicate their text.
            element = getattr(paragraph, "_p", None)
            if element is not None:
                if element in seen_paragraphs:
                    continue
                seen_paragraphs.add(element)
            append_text(getattr(paragraph, "text", ""))

        for table in getattr(container, "tables", []):
            walk_table(table)

    walk_container(document)

    for section in getattr(document, "sections", []):
        walk_container(getattr(section, "header", None))
        walk_container(getattr(section, "first_page_header", None))
        walk_container(getattr(section, "even_page_header", None))
        walk_container(getattr(section, "footer", None))
        walk_container(getattr(section, "first_page_footer", None))
        walk_container(getattr(section, "even_page_footer", None))

    return lines


def extract_docx_text(file_path: str) -> Tuple[Optional[str], str, List[str]]:
    warnings: List[str] = []

    try:
        from docx import Document  # type: ignore

        document = Document(file_path)
        paragraphs = iter_docx_block_text(document)
        text = normalize_multiline_text(
            "\n".join([paragraph for paragraph in paragraphs if paragraph]),
        )
        return text, "local_docx", warnings
    except Exception:
        warnings.append(
            "python-docx is unavailable, so DOCX import stayed on the lightweight sidecar fallback.",
        )
        return None, "local_sidecar_fallback", warnings


def extract_pdf_text(
    file_path: str,
) -> Tuple[List[str], Optional[str], str, List[str], Dict[str, Any]]:
    warnings: List[str] = []
    metadata: Dict[str, Any] = {"availableCapabilities": []}

    try:
        import pdfplumber  # type: ignore

        page_texts: List[str] = []
        with pdfplumber.open(file_path) as pdf:
            for page in pdf.pages:
                page_text = normalize_multiline_text(
                    page.extract_text(x_tolerance=2, y_tolerance=3) or "",
                ) or ""
                page_texts.append(page_text)

        text = normalize_multiline_text(
            "\n\n".join(page_text for page_text in page_texts if page_text),
        )
        metadata["availableCapabilities"] = ["pdf_layout"]
        return page_texts, text, "local_pdf_layout", warnings, metadata
    except Exception:
        warnings.append(
            "pdfplumber is unavailable, so PDF import stayed on the lightweight sidecar fallback.",
        )

    try:
        from pypdf import PdfReader  # type: ignore

        reader = PdfReader(file_path)
        page_texts = [normalize_multiline_text(page.extract_text() or "") or "" for page in reader.pages]
        text = normalize_multiline_text(
            "\n\n".join(page_text for page_text in page_texts if page_text),
        )
        metadata["availableCapabilities"] = ["pdf_text_probe"]
        return page_texts, text, "local_pdf_text_probe", warnings, metadata
    except Exception:
        warnings.append(
            "pypdf is unavailable, so PDF import stayed on the lightweight sidecar fallback.",
        )

    return [], None, "local_sidecar_fallback", warnings, metadata


def create_blocks(
    page_number: int,
    text: Optional[str],
    parser_kind: str,
) -> List[Dict[str, Any]]:
    if not text:
        return []

    lines = [normalize_inline_text(line) for line in re.split(r"\r?\n", text)]
    lines = [line for line in lines if line]
    blocks: List[Dict[str, Any]] = []

    for index, line in enumerate(lines):
        blocks.append(
            {
                "id": f"page_{page_number}_block_{index + 1}",
                "pageNumber": page_number,
                "readingOrder": index,
                "text": line,
                "kind": classify_block_kind(line),
                "sectionHint": classify_section_hint(line),
                "bbox": None,
                "sourceParserKinds": [parser_kind],
                "sourceConfidence": 0.88,
                "lineIds": [f"page_{page_number}_line_{index + 1}"],
                "parserLineage": [parser_kind],
                "readingOrderConfidence": 0.9,
                "textSpan": None,
            },
        )

    return blocks


def build_pages(
    page_texts: List[str],
    parser_kind: str,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    pages: List[Dict[str, Any]] = []
    blocks: List[Dict[str, Any]] = []

    for page_number, page_text in enumerate(page_texts, start=1):
        blocks_for_page = create_blocks(page_number, page_text or None, parser_kind)
        line_count = len(
            [
                line
                for line in re.split(r"\r?\n", page_text or "")
                if normalize_inline_text(line)
            ],
        )
        quality = build_quality_signal(
            page_text or None,
            line_count=line_count,
            block_count=len(blocks_for_page),
            reading_order_confidence=0.9 if blocks_for_page else 0.0,
            native_text_coverage=1.0 if page_text else 0.0,
            ocr_confidence=None,
            column_likelihood=0.22 if len(blocks_for_page) > 4 else 0.08,
            image_coverage_ratio=0.0 if page_text else 1.0,
            invalid_unicode_ratio=compute_invalid_unicode_ratio(page_text or None),
        )
        pages.append(
            {
                "pageNumber": page_number,
                "text": page_text or "",
                "charCount": len(page_text or ""),
                "tokenCount": quality["tokenCount"],
                "quality": quality,
                "qualityWarnings": [],
                "usedOcr": False,
                "width": None,
                "height": None,
            },
        )
        blocks.extend(blocks_for_page)

    return pages, blocks


def extract_document(
    file_path: str,
    file_kind: str,
) -> Tuple[List[str], Optional[str], str, List[str], str, List[str], List[str]]:
    if file_kind in {"plain_text", "markdown"}:
        text = extract_plain_text(file_path)
        return [text] if text else [], text, "plain_text", [], "plain_text_native", ["text_input_available"], ["text_ingest"]

    if file_kind == "docx":
        text, parser_kind, warnings = extract_docx_text(file_path)
        return [text] if text else [], text, parser_kind, warnings, "docx_native", ["docx_sidecar_attempt"], ["docx_attempt"]

    if file_kind == "pdf":
        page_texts, text, parser_kind, warnings, metadata = extract_pdf_text(file_path)
        triage = ["python_sidecar_pdf_attempt", *metadata.get("availableCapabilities", [])]
        capabilities = ["pdf_attempt", *metadata.get("availableCapabilities", [])]
        return page_texts, text, parser_kind, warnings, "native_first", triage, capabilities

    return (
        [],
        None,
        "local_sidecar_fallback",
        ["Unsupported file type for python sidecar."],
        "unsupported_fallback",
        ["unsupported_file_kind"],
        ["unsupported_fallback"],
    )


def build_response(request: Dict[str, Any]) -> Dict[str, Any]:
    file_path = request.get("filePath")
    if not isinstance(file_path, str) or not file_path.strip():
        raise ValueError("Resume parser sidecar request must include a non-empty filePath.")
    file_kind = request.get("fileKind") or detect_file_kind(file_path)
    (
        page_texts,
        text,
        parser_kind,
        warnings,
        route_kind,
        triage_reasons,
        available_capabilities,
    ) = extract_document(file_path, file_kind)

    pages, blocks = build_pages(page_texts, parser_kind)
    aggregate_line_count = sum(page["quality"]["lineCount"] for page in pages)
    aggregate_reading_order = (
        sum((page["quality"]["readingOrderConfidence"] or 0.0) for page in pages) / len(pages)
        if pages
        else 0.0
    )
    native_text_coverage = (
        sum(1 for page in pages if page["charCount"] > 0) / len(pages)
        if pages
        else 0.0
    )
    image_coverage_ratio = (
        sum(1 for page in pages if page["charCount"] == 0) / len(pages)
        if pages
        else 1.0
    )
    column_likelihood = (
        max((page["quality"]["columnLikelihood"] or 0.0) for page in pages)
        if pages
        else None
    )
    quality = build_quality_signal(
        text,
        line_count=aggregate_line_count,
        block_count=len(blocks),
        reading_order_confidence=aggregate_reading_order,
        native_text_coverage=native_text_coverage,
        ocr_confidence=None,
        column_likelihood=column_likelihood,
        image_coverage_ratio=image_coverage_ratio,
        invalid_unicode_ratio=compute_invalid_unicode_ratio(text),
    )
    script_path = get_runtime_root()

    return {
        "requestId": request["requestId"],
        "ok": True,
        "primaryParserKind": parser_kind,
        "parserKinds": [parser_kind],
        "route": {
            "routeKind": route_kind,
            "triageReasons": triage_reasons,
            "preferredExecutors": request.get("preferredExecutors", []),
            "usedExecutors": [parser_kind],
        },
        "parserManifest": {
            "workerKind": "python_sidecar",
            "workerVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "manifestVersion": "019-python-sidecar-v1",
            "runtimeLabel": f"python {sys.version_info.major}.{sys.version_info.minor}",
            "availableCapabilities": ["routing_manifest", *available_capabilities],
            "executorVersions": {
                parser_kind: str(script_path.stat().st_mtime_ns),
            },
        },
        "quality": quality,
        "qualityWarnings": [],
        "warnings": warnings,
        "pages": pages,
        "blocks": blocks,
        "fullText": text,
        "errorMessage": None,
    }


def build_failure_response(request_id: str, error_message: str) -> Dict[str, Any]:
    return {
        "requestId": request_id,
        "ok": False,
        "primaryParserKind": None,
        "parserKinds": [],
        "route": None,
        "parserManifest": {
            "workerKind": "python_sidecar",
            "workerVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "manifestVersion": "019-python-sidecar-v1",
            "runtimeLabel": f"python {sys.version_info.major}.{sys.version_info.minor}",
            "availableCapabilities": [],
            "executorVersions": {},
        },
        "quality": {
            "score": 0,
            "textDensity": None,
            "tokenCount": 0,
            "lineCount": 0,
            "blockCount": 0,
            "columnLikelihood": None,
            "readingOrderConfidence": None,
            "nativeTextCoverage": None,
            "ocrConfidence": None,
            "imageCoverageRatio": None,
            "invalidUnicodeRatio": None,
        },
        "qualityWarnings": [],
        "warnings": [],
        "pages": [],
        "blocks": [],
        "fullText": None,
        "errorMessage": error_message,
    }


def build_vision_images_failure_response(request: Optional[Dict[str, Any]], error_message: str) -> Dict[str, Any]:
    request_id = request.get("requestId", "unknown_request") if request is not None else "unknown_request"
    run_id = request.get("runId") if request is not None and isinstance(request.get("runId"), str) else "resume_vision_run_pending"
    source_resume_id = request.get("sourceResumeId") if request is not None and isinstance(request.get("sourceResumeId"), str) else "resume_source_pending"
    source_file_kind = request.get("fileKind") if request is not None and isinstance(request.get("fileKind"), str) else "unknown"
    return {
        "requestId": request_id,
        "ok": False,
        "artifact": {
            "id": "resume_vision_artifact_error",
            "runId": run_id,
            "sourceResumeId": source_resume_id,
            "sourceFileKind": source_file_kind,
            "createdAt": iso_now(),
            "retained": "temporary",
            "pages": [],
            "warnings": [],
        },
        "warnings": [],
        "errorMessage": error_message,
    }


def main() -> int:
    raw_input = ""
    request: Optional[Dict[str, Any]] = None

    try:
        raw_input = sys.stdin.read()
        parsed = json.loads(raw_input)
        if isinstance(parsed, dict):
            request = parsed
        if request is None:
            raise ValueError(f"Expected a JSON object, got {type(parsed).__name__}")
        if request.get("operation") == "render_vision_images":
            response = build_vision_images_response(request)
        else:
            response = build_response(request)
    except Exception as error:  # pragma: no cover - defensive transport fallback
        if request is None:
            try:
                parsed = json.loads(raw_input)
                if isinstance(parsed, dict):
                    request = parsed
            except json.JSONDecodeError:
                pass
        request_id = request.get("requestId", "unknown_request") if request is not None else "unknown_request"
        operation = request.get("operation") if request is not None else None

        response = (
            build_vision_images_failure_response(request, str(error))
            if operation == "render_vision_images"
            else build_failure_response(request_id, str(error))
        )

    sys.stdout.write(json.dumps(response))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
