# TODO

## Migrations

1. Generate sql file:

```
npx drizzle-kit generate:sqlite
```

2. Execute query

```
npx wrangler d1 execute zensync-prod-d1 --remote --file=migrations/<filename>>
```
