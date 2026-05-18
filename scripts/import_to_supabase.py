#!/usr/bin/env python
"""Import cleaned manufacturing support data into Supabase.

Uses only the Python standard library. Run locally with a Supabase service-role
key. Never expose the service-role key in browser code.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


SECTIONS = ("vendors", "parts_list_bom", "where_used", "changes_ecos")
RELATED_PART_PREFIXES = {"238", "537", "538", "600", "638", "810", "845", "846", "860", "899", "900"}
DROP_RAW_KEYS = {
    "output_folder",
    "source_breakdown_json",
}
DROP_DOC_KEYS = {
    "file",
    "source_file",
}


def clean_text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(clean_text(v) for v in value)
    if isinstance(value, dict):
        parts = []
        for key, child in value.items():
            parts.append(str(key))
            parts.append(clean_text(child))
        return " ".join(parts)
    return str(value)


def display_value(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value)
    return clean_text(value)


def row_title(section: str, row: dict) -> str:
    preferred = {
        "documents": ("File", "Title", "Type", "Vault"),
        "vendors": ("Vendor", "Name", "Part Number", "Manufacturer", "Supplier"),
        "parts_list_bom": ("Part Number", "Number", "RefDes", "Reference Designator", "Description"),
        "where_used": ("Part Number", "Number", "Description", "Assembly", "BOM Part Number"),
        "changes_ecos": ("Number", "Description", "Type", "Reason"),
    }.get(section, ())
    for key in preferred:
        val = display_value(row.get(key)) if isinstance(row, dict) else ""
        if val:
            return val[:180]
    return clean_text(row)[:180] or section


def related_family_key(part_number: str) -> str:
    value = (part_number or "").strip().upper()
    if value.startswith("S-"):
        value = value[2:]
    parts = value.split("-")
    if len(parts) >= 2 and parts[0] in RELATED_PART_PREFIXES:
        return f"FAMILY{parts[-1]}"
    return re.sub(r"[^A-Z0-9]+", "", value)


def safe_storage_name(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|]+", "_", value or "")
    value = re.sub(r"\s+", " ", value).strip()
    return value or "unnamed"


def strip_local_paths(value):
    if isinstance(value, dict):
        return {k: strip_local_paths(v) for k, v in value.items() if k not in DROP_RAW_KEYS and k not in DROP_DOC_KEYS}
    if isinstance(value, list):
        return [strip_local_paths(v) for v in value]
    if isinstance(value, str) and re.match(r"^[A-Za-z]:\\", value):
        return ""
    return value


class SupabaseClient:
    def __init__(self, url: str, service_key: str, dry_run: bool = False):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.dry_run = dry_run

    def request(self, method: str, path: str, payload=None, headers=None):
        if self.dry_run:
            return []
        url = f"{self.url}{path}"
        data = None
        request_headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
        }
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {url} failed: {exc.code} {detail}") from exc
        if not body:
            return None
        return json.loads(body.decode("utf-8"))

    def upsert(self, table: str, rows: list[dict], conflict: str, returning: bool = False):
        if not rows:
            return []
        query = urllib.parse.urlencode({"on_conflict": conflict})
        prefer = "resolution=merge-duplicates"
        if returning:
            prefer += ",return=representation"
        else:
            prefer += ",return=minimal"
        return self.request("POST", f"/rest/v1/{table}?{query}", rows, headers={"Prefer": prefer}) or []

    def upload_file(self, bucket: str, storage_path: str, file_path: Path, overwrite: bool = True) -> None:
        if self.dry_run:
            return
        encoded_path = "/".join(urllib.parse.quote(part) for part in storage_path.split("/"))
        url = f"{self.url}/storage/v1/object/{urllib.parse.quote(bucket)}/{encoded_path}"
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        headers = {
            "apikey": self.service_key,
            "Authorization": f"Bearer {self.service_key}",
            "Content-Type": content_type,
            "x-upsert": "true" if overwrite else "false",
        }
        request = urllib.request.Request(url, data=file_path.read_bytes(), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Upload {storage_path} failed: {exc.code} {detail}") from exc


def chunks(items: list, size: int):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def load_breakdowns(source: Path, limit: int = 0) -> list[Path]:
    paths = sorted(source.rglob("breakdown.json"))
    return paths[:limit] if limit else paths


def platform_name(data: dict) -> str:
    return data.get("cleaned_platform") or data.get("platform") or "Unknown"


def document_row_for_file(doc: dict, rows: list[dict]) -> dict:
    name = (doc.get("name") or Path(doc.get("file") or "").name).lower()
    for row in rows:
        if str(row.get("File") or "").lower() == name or str(row.get("Title") or "").lower() == name:
            return row
    return {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Import cleaned data into Supabase")
    parser.add_argument("--source", default=os.environ.get("MSD_SOURCE_DIR", "./data/Omnify_All_Parts_Cleaned"))
    parser.add_argument("--url", default=os.environ.get("SUPABASE_URL", ""))
    parser.add_argument("--service-role-key", default=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""))
    parser.add_argument("--bucket", default=os.environ.get("SUPABASE_STORAGE_BUCKET", "manufacturing-documents"))
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--skip-files", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    if not source.exists():
        print(f"Source folder not found: {source}", file=sys.stderr)
        return 2
    if not args.dry_run and (not args.url or not args.service_role_key):
        print("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.", file=sys.stderr)
        return 2

    paths = load_breakdowns(source, args.limit)
    print(f"Found {len(paths):,} breakdown files")
    client = SupabaseClient(args.url, args.service_role_key, args.dry_run)

    platform_names = sorted({platform_name(json.loads(path.read_text(encoding="utf-8"))) for path in paths})
    platform_rows = [{"name": name} for name in platform_names]
    platform_map: dict[str, int] = {}
    if args.dry_run:
        platform_map = {name: index + 1 for index, name in enumerate(platform_names)}
    else:
        for batch in chunks(platform_rows, args.batch_size):
            returned = client.upsert("platforms", batch, "name", returning=True)
            for row in returned:
                platform_map[row["name"]] = row["id"]
    print(f"Prepared {len(platform_map):,} platforms")

    imported_items = 0
    imported_sections = 0
    imported_docs = 0
    uploaded_files = 0

    for batch_number, batch_paths in enumerate(chunks(paths, args.batch_size), start=1):
        item_payloads = []
        batch_data = []
        for path in batch_paths:
            data = json.loads(path.read_text(encoding="utf-8"))
            rel_key = path.relative_to(source).as_posix()
            name = platform_name(data)
            item_payloads.append({
                "source_key": rel_key,
                "platform_id": platform_map.get(name),
                "item_id": str(data.get("item_id") or ""),
                "part_number": str(data.get("part_number") or ""),
                "description": str(data.get("description") or ""),
                "type": str(data.get("type") or ""),
                "category": str(data.get("category") or ""),
                "status": str(data.get("status") or ""),
                "revision": str(data.get("revision") or ""),
                "related_family_key": related_family_key(str(data.get("part_number") or "")),
                "raw": strip_local_paths(data),
            })
            batch_data.append((path, data, rel_key))

        if args.dry_run:
            returned_items = [{"id": imported_items + index + 1, "source_key": row["source_key"]} for index, row in enumerate(item_payloads)]
        else:
            returned_items = client.upsert("items", item_payloads, "source_key", returning=True)
        item_id_by_source = {row["source_key"]: row["id"] for row in returned_items}
        imported_items += len(item_payloads)

        section_payloads = []
        document_payloads = []
        for path, data, source_key in batch_data:
            supabase_item_id = item_id_by_source[source_key]
            for section in SECTIONS:
                for row in data.get(section) or []:
                    section_payloads.append({
                        "item_id": supabase_item_id,
                        "section": section,
                        "title": row_title(section, row),
                        "body": clean_text(row),
                        "row_data": strip_local_paths(row),
                    })

            document_rows = data.get("documents") or []
            for doc in data.get("downloaded_documents") or []:
                file_path = Path(doc.get("file") or "")
                file_name = doc.get("name") or file_path.name
                row = document_row_for_file(doc, document_rows)
                platform = safe_storage_name(platform_name(data))
                part = safe_storage_name(str(data.get("part_number") or "unknown-part"))
                storage_path = f"{platform}/{part}/{safe_storage_name(file_name)}"
                document_payloads.append({
                    "item_id": supabase_item_id,
                    "file_name": file_name,
                    "title": row.get("Title") or "",
                    "document_type": row.get("Type") or Path(file_name).suffix.lower().lstrip("."),
                    "vault": row.get("Vault") or "",
                    "storage_path": storage_path,
                    "metadata": strip_local_paths({**doc, "row": row}),
                })
                if not args.skip_files and file_path.exists():
                    client.upload_file(args.bucket, storage_path, file_path)
                    uploaded_files += 1

        for section_batch in chunks(section_payloads, args.batch_size):
            client.upsert("section_rows", section_batch, "item_id,section,title")
        for doc_batch in chunks(document_payloads, args.batch_size):
            client.upsert("documents", doc_batch, "item_id,file_name")
        imported_sections += len(section_payloads)
        imported_docs += len(document_payloads)

        print(
            f"Batch {batch_number}: items={imported_items:,}, "
            f"section_rows={imported_sections:,}, documents={imported_docs:,}, files={uploaded_files:,}"
        )
        time.sleep(0.05)

    print("Import complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
