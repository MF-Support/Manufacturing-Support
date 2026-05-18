# Manufacturing Support Database

Local searchable manufacturing support database for parts, documents, vendors, BOM rows, Where Used records, and change history.

## Current Runtime

The current app is a Python standard-library web server with a SQLite FTS search index and a static HTML/CSS/JavaScript frontend.

Start locally:

```powershell
python omnify_search_app.py --source ".\data\Omnify_All_Parts_Cleaned" --db ".\omnify_search.sqlite" --port 8765 --open-browser
```

Then open:

```text
http://127.0.0.1:8765
```

## GitHub Safety

This repository is prepared so source code can be committed without private scrape output, local databases, cookies, or raw downloaded files. Keep the repository private unless the data model and UI contain no company-confidential information.

Do not commit:

- `.env`
- SQLite databases
- raw scrape captures
- cookies/session files
- cleaned export folders
- downloaded documents
- credentials or internal URLs

## Deployment Direction

For a secure hosted version, use:

- GitHub private repo for source control
- Supabase Postgres for structured records
- Supabase Storage for documents
- Supabase Auth and Row Level Security for access control
- Vercel, Netlify, Cloudflare Pages, or GitHub Pages for a static frontend

See [Secure Deployment](docs/SECURE_DEPLOYMENT.md) and [Supabase Migration](docs/SUPABASE_MIGRATION.md).

## Supabase Import

After running `supabase/schema.sql`, also run:

```text
supabase/002_import_keys.sql
```

Then test the importer:

```powershell
python scripts\import_to_supabase.py --dry-run --limit 25
```

## GitHub Pages

The static frontend in `omnify_search_static/` is deployed by `.github/workflows/pages.yml`.
Enable GitHub Pages in the repository settings and choose **GitHub Actions** as the source.

The frontend uses Supabase Auth, Postgres, and private Storage. Run `supabase/003_storage_policies.sql`
so authenticated users can create signed download links for uploaded documents.
