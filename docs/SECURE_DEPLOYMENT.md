# Secure Deployment

## Recommended Architecture

Use GitHub for code, Supabase for data, and a static hosting provider for the UI.

```text
Browser
  -> Static frontend
  -> Supabase Auth
  -> Supabase Postgres and Storage with Row Level Security
```

GitHub Pages can host the frontend if the app is converted to call Supabase directly. It cannot run the current Python/SQLite backend.

## Deployment Checklist

1. Create a private GitHub repository.
2. Commit only source files, docs, and configuration templates.
3. Confirm `.gitignore` excludes local data, databases, cookies, raw HTML captures, and scraped documents.
4. Move source data into Supabase Postgres and files into Supabase Storage.
5. Enable Supabase Auth.
6. Enable Row Level Security on every table and storage bucket.
7. Store secrets in the deployment platform, not in the repo.
8. Deploy the static frontend.
9. Test with a non-admin user account.
10. Run a final secret scan before making the repository or app available to others.

## Local/Network Deployment

For local or trusted network use, the current Python app can still be used:

```powershell
$env:MSD_SOURCE_DIR="M:\Manufacturing Support Database\Omnify_All_Parts_Cleaned"
$env:MSD_DB_PATH="M:\Manufacturing Support Database\omnify_search.sqlite"
$env:MSD_BASIC_AUTH_USER="viewer"
$env:MSD_BASIC_AUTH_PASSWORD="<set-a-strong-password>"
python omnify_search_app.py --host 127.0.0.1 --port 8765
```

Keep `--host 127.0.0.1` unless you intentionally want other machines to reach the server.

## GitHub Pages Notes

GitHub Pages only serves static files. To use it:

- Replace Python `/api/*` calls with Supabase queries or Supabase Edge Functions.
- Store documents in Supabase Storage.
- Use the Supabase anon key only with strict Row Level Security.
- Never put service-role keys in frontend code.
