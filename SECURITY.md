# Security

## Data Classification

Assume scraped manufacturing data, BOMs, ECOs, vendor records, and downloadable files are confidential unless cleared for broader distribution.

## Required Controls Before Hosting

- Use a private GitHub repository.
- Keep all secrets in environment variables or platform secret stores.
- Do not commit `.env`, cookies, SQLite databases, scraped files, or downloaded documents.
- Use HTTPS for every hosted environment.
- Require authentication for any non-local deployment.
- Use least-privilege database and storage policies.
- Enable Supabase Row Level Security before exposing the frontend.

## Local Python Server

The Python server is intended for local or trusted-network use. If it is made reachable beyond `127.0.0.1`, set:

```text
MSD_BASIC_AUTH_USER
MSD_BASIC_AUTH_PASSWORD
```

This is a basic protective layer, not a substitute for enterprise SSO, VPN, or Supabase Auth.

## Secret Rotation

If a password, cookie, token, or database credential was ever committed or shared, rotate it immediately and remove it from Git history before publishing the repository.
