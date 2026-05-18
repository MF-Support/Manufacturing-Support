#!/usr/bin/env python
"""Manufacturing Support Database local search app.

Indexes a cleaned manufacturing data export into SQLite FTS5 and serves a small
web UI for drilling from platform -> part -> detail sections.
"""

from __future__ import annotations

import argparse
import base64
import hmac
import json
import mimetypes
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parent


def env_path(name: str, fallback: Path) -> Path:
    value = os.environ.get(name, "").strip()
    return Path(value).expanduser() if value else fallback


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


DEFAULT_SOURCE = env_path("MSD_SOURCE_DIR", WORKSPACE / "data" / "Omnify_All_Parts_Cleaned")
DEFAULT_DB = env_path("MSD_DB_PATH", WORKSPACE / "omnify_search.sqlite")
STATIC_DIR = env_path("MSD_STATIC_DIR", WORKSPACE / "omnify_search_static")
SECTIONS = ("documents", "vendors", "parts_list_bom", "where_used", "changes_ecos")
SECTION_LABELS = {
    "documents": "Documents",
    "vendors": "Vendors",
    "parts_list_bom": "Parts List / BOM",
    "where_used": "Where Used",
    "changes_ecos": "Changes / ECOs",
    "overview": "Overview",
}
RELATED_PART_PREFIXES = {
    "238",
    "537",
    "538",
    "600",
    "638",
    "810",
    "845",
    "846",
    "860",
    "899",
    "900",
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


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
            if key.lower().endswith("links"):
                parts.append(clean_text(child))
            else:
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
        "where_used": ("Part Number", "Number", "Description", "Assembly"),
        "changes_ecos": ("Number", "Description", "Type", "Reason"),
    }.get(section, ())
    for key in preferred:
        val = display_value(row.get(key)) if isinstance(row, dict) else ""
        if val:
            return val[:180]
    return clean_text(row)[:180] or SECTION_LABELS.get(section, section)


def safe_int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def fts_query(text: str) -> str:
    terms = re.findall(r"[A-Za-z0-9]+", text.lower())
    return " AND ".join(f"{term}*" for term in terms)


def normalize_for_rank(value) -> str:
    text = clean_text(value).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def compact_for_rank(value) -> str:
    return re.sub(r"[^a-z0-9]+", "", clean_text(value).lower())


def related_family_key(part_number: str) -> str:
    value = (part_number or "").strip().upper()
    if value.startswith("S-"):
        value = value[2:]
    parts = value.split("-")
    if len(parts) >= 2 and parts[0] in RELATED_PART_PREFIXES:
        return f"FAMILY{parts[-1]}"
    return re.sub(r"[^A-Z0-9]+", "", value)


def related_variants(part_number: str) -> list[str]:
    value = (part_number or "").strip().upper()
    if not value:
        return []
    variants = {value}
    if value.startswith("S-"):
        variants.add(value[2:])
    else:
        variants.add(f"S-{value}")
    return sorted(variants)


def related_suffix(part_number: str) -> str:
    value = (part_number or "").strip().upper()
    if value.startswith("S-"):
        value = value[2:]
    parts = value.split("-")
    if len(parts) >= 2 and parts[0] in RELATED_PART_PREFIXES:
        return parts[-1]
    return ""


def record_rank_score(query: str, record: dict, hits: list[dict]) -> tuple:
    q_norm = normalize_for_rank(query)
    q_compact = compact_for_rank(query)
    part = normalize_for_rank(record.get("part_number"))
    part_compact = compact_for_rank(record.get("part_number"))
    description = normalize_for_rank(record.get("description"))
    titles = [normalize_for_rank(hit.get("title")) for hit in hits]
    title_compacts = [compact_for_rank(hit.get("title")) for hit in hits]
    best_fts = min(
        (hit.get("rank") for hit in hits if hit.get("rank") is not None),
        default=999.0,
    )

    if q_compact and part_compact == q_compact:
        bucket = 0
    elif q_norm and (description == q_norm or q_norm in titles or q_compact in title_compacts):
        bucket = 1
    elif q_compact and part_compact.startswith(q_compact):
        bucket = 2
    elif q_compact and q_compact in part_compact:
        bucket = 3
    elif q_norm and description.startswith(q_norm):
        bucket = 4
    elif q_norm and q_norm in description:
        bucket = 5
    else:
        bucket = 6

    return (
        bucket,
        best_fts,
        record.get("part_number") or "",
        record.get("description") or "",
        record.get("platform") or "",
    )


class SearchIndex:
    def __init__(self, source: Path, db_path: Path):
        self.source = source.resolve()
        self.db_path = db_path.resolve()
        self.lock = threading.Lock()
        self.status = {
            "state": "idle",
            "message": "Ready",
            "started_at": None,
            "finished_at": None,
            "processed": 0,
            "total": 0,
            "records": 0,
            "section_rows": 0,
            "source": str(self.source),
            "db": str(self.db_path),
            "error": None,
        }
        self.worker: threading.Thread | None = None

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA temp_store=MEMORY")
        return conn

    def snapshot(self) -> dict:
        with self.lock:
            status = dict(self.status)
        if self.db_path.exists():
            try:
                with self.connect() as conn:
                    meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM meta")}
                    status.update({
                        "indexed_at": meta.get("indexed_at"),
                        "records": safe_int(meta.get("records"), status.get("records", 0)),
                        "section_rows": safe_int(meta.get("section_rows"), status.get("section_rows", 0)),
                        "platforms": safe_int(meta.get("platforms"), 0),
                    })
            except sqlite3.Error:
                pass
        return status

    def start_rebuild(self) -> bool:
        with self.lock:
            if self.worker and self.worker.is_alive():
                self.status["message"] = "Index rebuild is already running"
                return False
            self.worker = threading.Thread(target=self.build, name="omnify-indexer", daemon=True)
            self.worker.start()
            return True

    def build(self) -> None:
        start = time.time()
        try:
            files = list(self.source.rglob("breakdown.json"))
            with self.lock:
                self.status.update({
                    "state": "indexing",
                    "message": "Scanning breakdown files",
                    "started_at": now_iso(),
                    "finished_at": None,
                    "processed": 0,
                    "total": len(files),
                    "records": 0,
                    "section_rows": 0,
                    "error": None,
                })
            tmp_db = self.db_path.with_suffix(".building.sqlite")
            if tmp_db.exists():
                tmp_db.unlink()
            conn = sqlite3.connect(str(tmp_db))
            conn.row_factory = sqlite3.Row
            self.create_schema(conn)
            section_count = 0
            platform_names = set()
            for index, path in enumerate(files, start=1):
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
                record_id = self.insert_record(conn, data, path)
                platform_names.add(data.get("cleaned_platform") or data.get("platform") or "Unknown")
                for section in SECTIONS:
                    for row in data.get(section) or []:
                        if not isinstance(row, dict):
                            row = {"Value": row}
                        section_count += self.insert_section_row(conn, record_id, section, row)
                docs = data.get("downloaded_documents") or []
                for doc in docs:
                    if isinstance(doc, dict):
                        self.insert_file(conn, record_id, doc)
                if index % 200 == 0:
                    conn.commit()
                    with self.lock:
                        self.status.update({
                            "message": f"Indexed {index:,} of {len(files):,} breakdowns",
                            "processed": index,
                            "records": index,
                            "section_rows": section_count,
                        })
            conn.commit()
            self.refresh_platforms(conn)
            self.set_meta(conn, {
                "indexed_at": now_iso(),
                "source": str(self.source),
                "records": str(len(files)),
                "section_rows": str(section_count),
                "platforms": str(len(platform_names)),
                "elapsed_seconds": f"{time.time() - start:.1f}",
            })
            conn.commit()
            conn.close()
            if self.db_path.exists():
                self.db_path.unlink()
            tmp_db.replace(self.db_path)
            with self.lock:
                self.status.update({
                    "state": "ready",
                    "message": "Index ready",
                    "finished_at": now_iso(),
                    "processed": len(files),
                    "records": len(files),
                    "section_rows": section_count,
                })
        except Exception as exc:  # Keep the web server alive and report the issue.
            with self.lock:
                self.status.update({
                    "state": "error",
                    "message": "Index build failed",
                    "finished_at": now_iso(),
                    "error": repr(exc),
                })

    def create_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE records(
                record_id INTEGER PRIMARY KEY,
                platform TEXT,
                item_id TEXT,
                part_number TEXT,
                description TEXT,
                type TEXT,
                category TEXT,
                status TEXT,
                revision TEXT,
                lifecycle_status TEXT,
                url TEXT,
                output_folder TEXT,
                json_path TEXT,
                document_count INTEGER,
                vendor_count INTEGER,
                bom_count INTEGER,
                where_used_count INTEGER,
                eco_count INTEGER,
                downloaded_count INTEGER,
                aggregate_text TEXT
            );
            CREATE VIRTUAL TABLE record_fts USING fts5(
                record_id UNINDEXED,
                platform,
                part_number,
                description,
                text
            );
            CREATE TABLE section_rows(
                section_row_id INTEGER PRIMARY KEY,
                record_id INTEGER,
                section TEXT,
                title TEXT,
                body TEXT,
                row_json TEXT,
                FOREIGN KEY(record_id) REFERENCES records(record_id)
            );
            CREATE VIRTUAL TABLE section_fts USING fts5(
                section_row_id UNINDEXED,
                record_id UNINDEXED,
                section UNINDEXED,
                title,
                body
            );
            CREATE TABLE files(
                file_id INTEGER PRIMARY KEY,
                record_id INTEGER,
                name TEXT,
                url TEXT,
                file_path TEXT,
                bytes INTEGER,
                extension TEXT,
                FOREIGN KEY(record_id) REFERENCES records(record_id)
            );
            CREATE TABLE platforms(
                platform TEXT PRIMARY KEY,
                item_count INTEGER,
                document_count INTEGER,
                vendor_count INTEGER,
                bom_count INTEGER,
                where_used_count INTEGER,
                eco_count INTEGER
            );
            CREATE INDEX idx_records_platform ON records(platform);
            CREATE INDEX idx_records_part ON records(part_number);
            CREATE INDEX idx_sections_record ON section_rows(record_id);
            CREATE INDEX idx_sections_section ON section_rows(section);
            CREATE INDEX idx_files_record ON files(record_id);
            """
        )

    def insert_record(self, conn: sqlite3.Connection, data: dict, path: Path) -> int:
        aggregate_parts = [
            data.get("cleaned_platform") or data.get("platform"),
            data.get("part_number"),
            data.get("description"),
            data.get("type"),
            data.get("category"),
            data.get("status"),
            data.get("revision"),
            clean_text(data.get("project")),
        ]
        for section in SECTIONS:
            aggregate_parts.append(clean_text(data.get(section)))
        aggregate = " ".join(p for p in aggregate_parts if p)
        counts = {section: len(data.get(section) or []) for section in SECTIONS}
        downloaded_count = len(data.get("downloaded_documents") or [])
        cursor = conn.execute(
            """
            INSERT INTO records(
                platform, item_id, part_number, description, type, category, status,
                revision, lifecycle_status, url, output_folder, json_path,
                document_count, vendor_count, bom_count, where_used_count, eco_count,
                downloaded_count, aggregate_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.get("cleaned_platform") or data.get("platform") or "Unknown",
                data.get("item_id") or "",
                data.get("part_number") or "",
                data.get("description") or "",
                data.get("type") or "",
                data.get("category") or "",
                data.get("status") or "",
                data.get("revision") or "",
                data.get("lifecycle_status") or "",
                data.get("url") or "",
                data.get("output_folder") or "",
                str(path),
                counts["documents"],
                counts["vendors"],
                counts["parts_list_bom"],
                counts["where_used"],
                counts["changes_ecos"],
                downloaded_count,
                aggregate,
            ),
        )
        record_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO record_fts(record_id, platform, part_number, description, text) VALUES (?, ?, ?, ?, ?)",
            (record_id, data.get("cleaned_platform") or data.get("platform") or "", data.get("part_number") or "", data.get("description") or "", aggregate),
        )
        return record_id

    def insert_section_row(self, conn: sqlite3.Connection, record_id: int, section: str, row: dict) -> int:
        title = row_title(section, row)
        body = clean_text(row)
        cursor = conn.execute(
            "INSERT INTO section_rows(record_id, section, title, body, row_json) VALUES (?, ?, ?, ?, ?)",
            (record_id, section, title, body, json.dumps(row, ensure_ascii=False)),
        )
        section_row_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO section_fts(section_row_id, record_id, section, title, body) VALUES (?, ?, ?, ?, ?)",
            (section_row_id, record_id, section, title, body),
        )
        return 1

    def insert_file(self, conn: sqlite3.Connection, record_id: int, doc: dict) -> None:
        name = doc.get("name") or Path(doc.get("file") or "").name
        ext = Path(name).suffix.lower().lstrip(".")
        conn.execute(
            "INSERT INTO files(record_id, name, url, file_path, bytes, extension) VALUES (?, ?, ?, ?, ?, ?)",
            (record_id, name, doc.get("url") or "", doc.get("file") or "", safe_int(doc.get("bytes")), ext),
        )

    def refresh_platforms(self, conn: sqlite3.Connection) -> None:
        conn.execute("DELETE FROM platforms")
        conn.execute(
            """
            INSERT INTO platforms(
                platform, item_count, document_count, vendor_count, bom_count, where_used_count, eco_count
            )
            SELECT
                platform,
                COUNT(*),
                SUM(document_count),
                SUM(vendor_count),
                SUM(bom_count),
                SUM(where_used_count),
                SUM(eco_count)
            FROM records
            GROUP BY platform
            ORDER BY platform
            """
        )

    def set_meta(self, conn: sqlite3.Connection, values: dict[str, str]) -> None:
        for key, value in values.items():
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", (key, value))


class OmnifyHandler(BaseHTTPRequestHandler):
    server_version = "ManufacturingSupportDatabase/1.0"

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), fmt % args))

    @property
    def app(self) -> SearchIndex:
        return self.server.index  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def is_authorized(self) -> bool:
        user = getattr(self.server, "auth_user", "")  # type: ignore[attr-defined]
        password = getattr(self.server, "auth_password", "")  # type: ignore[attr-defined]
        if not user or not password:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
        except Exception:
            return False
        supplied_user, sep, supplied_password = decoded.partition(":")
        return bool(sep) and hmac.compare_digest(supplied_user, user) and hmac.compare_digest(supplied_password, password)

    def require_authorization(self) -> bool:
        if self.is_authorized():
            return True
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Manufacturing Support Database"')
        self.end_headers()
        return False

    def do_GET(self) -> None:
        if not self.require_authorization():
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            self.route_api(parsed)
            return
        if parsed.path == "/" or parsed.path == "":
            self.serve_static(STATIC_DIR / "index.html", "text/html; charset=utf-8")
            return
        static_path = (STATIC_DIR / parsed.path.lstrip("/")).resolve()
        try:
            static_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.serve_static(static_path)

    def do_POST(self) -> None:
        if not self.require_authorization():
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/reindex":
            started = self.app.start_rebuild()
            self.json_response({"started": started, "status": self.app.snapshot()})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def route_api(self, parsed) -> None:
        params = urllib.parse.parse_qs(parsed.query)
        path = parsed.path
        try:
            if path == "/api/status":
                self.json_response(self.app.snapshot())
            elif path == "/api/platforms":
                self.api_platforms()
            elif path == "/api/search":
                self.api_search(params)
            elif path == "/api/item":
                self.api_item(params)
            elif path == "/api/resolve":
                self.api_resolve(params)
            elif path == "/api/file":
                self.api_file(params)
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
        except sqlite3.Error as exc:
            self.json_response({"error": str(exc), "status": self.app.snapshot()}, status=500)

    def api_platforms(self) -> None:
        with self.app.connect() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM platforms ORDER BY platform")]
        self.json_response({"platforms": rows})

    def api_search(self, params: dict) -> None:
        query = (params.get("q", [""])[0] or "").strip()
        platform = (params.get("platform", [""])[0] or "").strip()
        section = (params.get("section", ["all"])[0] or "all").strip()
        limit = min(max(safe_int(params.get("limit", ["80"])[0], 80), 1), 250)
        fts = fts_query(query)
        with self.app.connect() as conn:
            if not query:
                sql = "SELECT * FROM records"
                args: list = []
                if platform:
                    sql += " WHERE platform = ?"
                    args.append(platform)
                sql += " ORDER BY platform, part_number LIMIT ?"
                args.append(limit)
                records = [dict(r) for r in conn.execute(sql, args)]
                self.json_response({"query": query, "records": records, "hits": [], "total": len(records)})
                return
            records_by_id: dict[int, dict] = {}
            hits: list[dict] = []
            priority_ids: list[int] = []
            exact_sql = """
                SELECT r.*, 0.0 AS rank
                FROM records r
                WHERE (lower(r.part_number) = lower(?) OR lower(r.description) = lower(?))
            """
            exact_args: list = [query, query]
            if platform:
                exact_sql += " AND r.platform = ?"
                exact_args.append(platform)
            for row in conn.execute(exact_sql, exact_args):
                rec = dict(row)
                rid = rec["record_id"]
                records_by_id[rid] = rec
                if rid not in priority_ids:
                    priority_ids.append(rid)
                hits.append({
                    "record_id": rid,
                    "section": "overview",
                    "title": rec.get("part_number") or rec.get("description"),
                    "body": rec.get("aggregate_text", "")[:1200],
                    "rank": rec.get("rank"),
                    "trail": [query, rec.get("platform"), "Overview"],
                })
            exact_section_sql = """
                SELECT sr.section_row_id, sr.record_id, sr.section, sr.title, sr.body, sr.row_json,
                       r.platform, r.part_number, r.description, r.type, r.category, r.status,
                       r.revision, r.document_count, r.vendor_count, r.bom_count, r.where_used_count, r.eco_count,
                       0.0 AS rank
                FROM section_rows sr
                JOIN records r ON r.record_id = sr.record_id
                WHERE lower(sr.title) = lower(?)
            """
            exact_section_args: list = [query]
            if platform:
                exact_section_sql += " AND r.platform = ?"
                exact_section_args.append(platform)
            if section and section != "all":
                exact_section_sql += " AND sr.section = ?"
                exact_section_args.append(section)
            for row in conn.execute(exact_section_sql, exact_section_args):
                hit = dict(row)
                rid = hit["record_id"]
                if rid not in records_by_id:
                    records_by_id[rid] = self.record_by_id(conn, rid)
                if rid not in priority_ids:
                    priority_ids.append(rid)
                hit["trail"] = [query, hit.get("platform"), SECTION_LABELS.get(hit.get("section"), hit.get("section"))]
                hits.append(hit)
            record_args: list = [fts]
            record_sql = """
                SELECT r.*, bm25(record_fts) AS rank
                FROM record_fts
                JOIN records r ON r.record_id = record_fts.record_id
                WHERE record_fts MATCH ?
            """
            if platform:
                record_sql += " AND r.platform = ?"
                record_args.append(platform)
            record_sql += " ORDER BY rank LIMIT ?"
            record_args.append(limit)
            for row in conn.execute(record_sql, record_args):
                rec = dict(row)
                rid = rec["record_id"]
                records_by_id[rid] = rec
                hits.append({
                    "record_id": rid,
                    "section": "overview",
                    "title": rec.get("part_number") or rec.get("description"),
                    "body": rec.get("aggregate_text", "")[:1200],
                    "rank": rec.get("rank"),
                    "trail": [query, rec.get("platform"), "Overview"],
                })
            section_args: list = [fts]
            section_sql = """
                SELECT sr.section_row_id, sr.record_id, sr.section, sr.title, sr.body, sr.row_json,
                       r.platform, r.part_number, r.description, r.type, r.category, r.status,
                       r.revision, r.document_count, r.vendor_count, r.bom_count, r.where_used_count, r.eco_count,
                       bm25(section_fts) AS rank
                FROM section_fts
                JOIN section_rows sr ON sr.section_row_id = section_fts.section_row_id
                JOIN records r ON r.record_id = sr.record_id
                WHERE section_fts MATCH ?
            """
            if platform:
                section_sql += " AND r.platform = ?"
                section_args.append(platform)
            if section and section != "all":
                section_sql += " AND sr.section = ?"
                section_args.append(section)
            section_sql += " ORDER BY rank LIMIT ?"
            section_args.append(limit * 3)
            for row in conn.execute(section_sql, section_args):
                hit = dict(row)
                rid = hit["record_id"]
                if rid not in records_by_id:
                    records_by_id[rid] = self.record_by_id(conn, rid)
                hit["trail"] = [query, hit.get("platform"), SECTION_LABELS.get(hit.get("section"), hit.get("section"))]
                hits.append(hit)
            hits_by_record: dict[int, list[dict]] = {}
            for hit in hits:
                hits_by_record.setdefault(hit["record_id"], []).append(hit)
            ranked_ids = []
            seen = set()
            for rid in priority_ids:
                if rid in records_by_id and rid not in seen:
                    ranked_ids.append(rid)
                    seen.add(rid)
            for rid in sorted(
                records_by_id,
                key=lambda record_id: record_rank_score(query, records_by_id[record_id], hits_by_record.get(record_id, [])),
            ):
                if rid not in seen:
                    ranked_ids.append(rid)
                    seen.add(rid)
                if len(ranked_ids) >= limit:
                    break
            records = [records_by_id[rid] for rid in ranked_ids if rid in records_by_id]
            records = self.combine_related_records(conn, records)
            ranked_record_ids = {rid: index for index, rid in enumerate(ranked_ids)}
            hits.sort(key=lambda h: (ranked_record_ids.get(h["record_id"], limit + 1), h.get("rank") if h.get("rank") is not None else 999))
            self.json_response({"query": query, "records": records, "hits": hits[: limit * 3], "total": len(records)})

    def record_by_id(self, conn: sqlite3.Connection, record_id: int) -> dict:
        row = conn.execute("SELECT * FROM records WHERE record_id = ?", (record_id,)).fetchone()
        return dict(row) if row else {}

    def related_records(self, conn: sqlite3.Connection, record: dict, limit: int = 18) -> list[dict]:
        part_number = record.get("part_number") or ""
        variants = related_variants(part_number)
        if not variants:
            return []
        placeholders = ",".join("?" for _ in variants)
        suffix = related_suffix(part_number)
        suffix_clause = ""
        suffix_args: list[str] = []
        if suffix:
            prefix_placeholders = ",".join("?" for _ in RELATED_PART_PREFIXES)
            suffix_clause = f"""
                OR (
                    part_number LIKE ?
                    AND upper(substr(part_number, 1, instr(part_number, '-') - 1)) IN ({prefix_placeholders})
                )
                OR part_number = ?
            """
            suffix_args = [f"%-{suffix}", *sorted(RELATED_PART_PREFIXES), f"S-538-{suffix}"]
        rows = [
            dict(r)
            for r in conn.execute(
                f"""
                SELECT
                    record_id, platform, part_number, description, type, category, status, revision,
                    document_count, vendor_count, bom_count, where_used_count, eco_count
                FROM records
                WHERE upper(part_number) IN ({placeholders})
                {suffix_clause}
                ORDER BY
                    CASE WHEN record_id = ? THEN 0 ELSE 1 END,
                    CASE
                        WHEN upper(part_number) LIKE 'S-%' THEN 2
                        WHEN part_number LIKE '538-%' OR part_number LIKE '537-%' THEN 1
                        WHEN part_number LIKE '238-%' THEN 3
                        WHEN part_number LIKE '810-%' OR part_number LIKE '860-%' THEN 4
                        WHEN part_number LIKE '900-%' THEN 5
                        WHEN part_number LIKE '899-%' THEN 6
                        ELSE 7
                    END,
                    part_number,
                    platform
                LIMIT ?
                """,
                [*variants, *suffix_args, record.get("record_id"), limit],
            )
        ]
        deduped = []
        seen: set[tuple[str, str]] = set()
        for row in rows:
            key = ((row.get("part_number") or "").upper(), normalize_for_rank(row.get("description")))
            if key in seen:
                continue
            seen.add(key)
            row["relationship"] = "Current item" if row.get("record_id") == record.get("record_id") else self.related_label(row)
            deduped.append(row)
        return deduped

    def related_label(self, record: dict) -> str:
        part_number = (record.get("part_number") or "").upper()
        item_type = record.get("type") or ""
        description = (record.get("description") or "").lower()
        if part_number.startswith("S-") or "schematic" in description:
            return "Schematic"
        if "pcb" in description:
            return "PCB"
        if "assembly" in item_type.lower() or "assembly" in description:
            return "Assembly"
        return item_type or "Related"

    def combine_related_records(self, conn: sqlite3.Connection, records: list[dict]) -> list[dict]:
        combined: list[dict] = []
        seen_keys: set[str] = set()
        by_key: dict[str, list[dict]] = {}
        for record in records:
            key = related_family_key(record.get("part_number") or "")
            if not key:
                combined.append(record)
                continue
            by_key.setdefault(key, []).append(record)
        for record in records:
            key = related_family_key(record.get("part_number") or "")
            if key and key in seen_keys:
                continue
            if key:
                seen_keys.add(key)
            related = self.related_records(conn, record)
            if related:
                record["related_items"] = related
                record["related_count"] = len([item for item in related if item.get("record_id") != record.get("record_id")])
            combined.append(record)
        return combined

    def api_resolve(self, params: dict) -> None:
        item_id = (params.get("item_id", [""])[0] or "").strip()
        part_number = (params.get("part_number", [""])[0] or "").strip()
        with self.app.connect() as conn:
            row = None
            if item_id:
                row = conn.execute(
                    """
                    SELECT record_id, platform, part_number, description
                    FROM records
                    WHERE item_id = ?
                    ORDER BY
                        CASE WHEN platform = 'Components' THEN 1 ELSE 0 END,
                        platform,
                        part_number
                    LIMIT 1
                    """,
                    (item_id,),
                ).fetchone()
            if row is None and part_number:
                row = conn.execute(
                    """
                    SELECT record_id, platform, part_number, description
                    FROM records
                    WHERE lower(part_number) = lower(?)
                    ORDER BY
                        CASE WHEN platform = 'Components' THEN 1 ELSE 0 END,
                        platform,
                        part_number
                    LIMIT 1
                    """,
                    (part_number,),
                ).fetchone()
        if not row:
            self.json_response({"found": False})
            return
        self.json_response({"found": True, "record": dict(row)})

    def api_item(self, params: dict) -> None:
        record_id = safe_int(params.get("id", ["0"])[0])
        with self.app.connect() as conn:
            record = self.record_by_id(conn, record_id)
            if not record:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            sections = {}
            for section in SECTIONS:
                rows = []
                for row in conn.execute(
                    "SELECT section_row_id, title, body, row_json FROM section_rows WHERE record_id = ? AND section = ?",
                    (record_id, section),
                ):
                    item = dict(row)
                    try:
                        item["row"] = json.loads(item.pop("row_json"))
                    except json.JSONDecodeError:
                        item["row"] = {}
                    rows.append(item)
                sections[section] = rows
            files = [dict(r) for r in conn.execute("SELECT * FROM files WHERE record_id = ? ORDER BY name", (record_id,))]
            related = self.related_records(conn, record)
        raw = {}
        try:
            raw = json.loads(Path(record["json_path"]).read_text(encoding="utf-8"))
        except Exception:
            pass
        self.json_response({"record": record, "sections": sections, "files": files, "related": related, "raw": raw})

    def api_file(self, params: dict) -> None:
        path_value = params.get("path", [""])[0]
        if not path_value:
            self.send_error(HTTPStatus.BAD_REQUEST)
            return
        path = Path(path_value).resolve()
        try:
            path.relative_to(self.app.source)
        except ValueError:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.send_header("Content-Disposition", f"inline; filename={urllib.parse.quote(path.name)}")
        self.end_headers()
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def serve_static(self, path: Path, content_type: str | None = None) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def json_response(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_server(
    index: SearchIndex,
    host: str,
    port: int,
    open_browser: bool = False,
    auth_user: str = "",
    auth_password: str = "",
) -> None:
    class Server(ThreadingHTTPServer):
        daemon_threads = True

    server = Server((host, port), OmnifyHandler)
    server.index = index  # type: ignore[attr-defined]
    server.auth_user = auth_user  # type: ignore[attr-defined]
    server.auth_password = auth_password  # type: ignore[attr-defined]
    actual_host, actual_port = server.server_address[:2]
    display_host = "127.0.0.1" if actual_host in ("", "0.0.0.0") else actual_host
    url = f"http://{display_host}:{actual_port}"
    print(f"Manufacturing Support Database: {url}")
    print(f"Source: {index.source}")
    print(f"Database: {index.db_path}")
    print("Authentication: enabled" if auth_user and auth_password else "Authentication: disabled")
    if open_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    server.serve_forever()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the Manufacturing Support Database app")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Cleaned source data folder")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite search database path")
    parser.add_argument("--host", default=os.environ.get("MSD_BIND_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MSD_PORT", "8765")))
    parser.add_argument("--rebuild", action="store_true", help="Rebuild the index")
    parser.add_argument("--build-only", action="store_true", help="Build the index and exit")
    parser.add_argument("--open-browser", action="store_true", default=env_bool("MSD_OPEN_BROWSER"), help="Open the app in the default browser")
    parser.add_argument("--auth-user", default=os.environ.get("MSD_BASIC_AUTH_USER", ""), help="Optional HTTP Basic Auth username")
    parser.add_argument("--auth-password", default=os.environ.get("MSD_BASIC_AUTH_PASSWORD", ""), help="Optional HTTP Basic Auth password")
    args = parser.parse_args()

    source = Path(args.source)
    db_path = Path(args.db)
    if not source.exists():
        print(f"Source folder not found: {source}", file=sys.stderr)
        return 2
    index = SearchIndex(source, db_path)
    if args.build_only:
        index.build()
        snap = index.snapshot()
        print(json.dumps(snap, indent=2))
        return 0 if snap.get("state") != "error" else 1
    if args.rebuild or not db_path.exists():
        index.start_rebuild()
    run_server(index, args.host, args.port, args.open_browser, args.auth_user, args.auth_password)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
