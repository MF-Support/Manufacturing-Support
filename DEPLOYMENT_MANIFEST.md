# Deployment Manifest

Commit these files for the current secure local/server version:

```text
.dockerignore
.env.example
.gitignore
DEPLOYMENT_MANIFEST.md
README.md
README_NETWORK_DEPLOYMENT.md
README_OMNIFY_SEARCH_APP.md
SECURITY.md
Build Shared Database.bat
Launch Manufacturing Support Database.bat
start_omnify_search.bat
omnify_search_app.py
omnify_search_static/
docs/
supabase/
scripts/import_to_supabase.py
```

Do not commit raw scrape captures, local databases, cookies, cleaned data exports, downloaded documents, or scraper/probe scripts unless they have been reviewed, scrubbed, and approved.

Before pushing:

```powershell
rg -n -i "password|cookie|token|secret|service_role|private key|C:\\Users|Downloads|internal-host|internal-user" .
```

Expected matches should be limited to documentation warnings, environment variable names, or ignored local-only files.
