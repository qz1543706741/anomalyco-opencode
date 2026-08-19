# Effect Drizzle MySQL

- Keep this package generic: Drizzle + Effect + mysql2 only.
- Do not add OpenCode tables, migrations, or domain repositories here.
- Own pool acquisition and shutdown; callers own queries and transactions.
