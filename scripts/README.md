# Operator Scripts

## CSV Import

Imports bank transactions from CSV.
Operator-only — not callable from UI.

### Requirements
- Set `IMPORT_SECRET` env var
- Run from project root
- Requires database access

### Usage
```bash
npx tsx -r dotenv/config scripts/csv-import.ts \
  --org <orgId> \
  --bankAccount <bankAccountId> \
  --file <path/to/file.csv> \
  [--dry-run]
```

### Options
| Flag | Description |
|------|-------------|
| `--org` | Organization UUID (required) |
| `--bankAccount` | Bank account UUID (required) |
| `--file` | Path to CSV file (required) |
| `--dry-run` | Parse and validate only, no DB writes |

### Safety limits
- Max file size: 10MB
- Max rows: 10,000
- UUID validation on `--org` and `--bankAccount`

### Audit
Logs `csv_import_started` and `csv_import_finished` to `shared.audit_log`.

---

## Create Customer Org

Creates a new customer org, adds you as `service_operator`, generates a viewer invite for the customer.

### Requirements
- Set `IMPORT_SECRET` env var
- Set `OPERATOR_SECRET` env var
- Set `OPERATOR_EMAIL` env var (your email)
- Set `APP_URL` env var (for invite link)
- Run from project root
- Requires database access

### Usage
```bash
npx tsx -r dotenv/config scripts/create-org.ts \
  --secret $OPERATOR_SECRET \
  --name "Kunde A GmbH" \
  --slug "kunde-a" \
  --invite "owner@kunde-a.de" \
  [--print-link] [--force]
```

### Options
| Flag | Description |
|------|-------------|
| `--name` | Org display name (required) |
| `--slug` | Unique org slug, lowercase+hyphens only (required) |
| `--invite` | Customer email to invite as viewer (required) |
| `--print-link` | Print the invite URL (omitted by default for security) |
| `--force` | Replace an existing pending invite for the same email |

### Output
By default prints confirmation without the link. Use `--print-link` to display the invite URL.
Link expires in 7 days.

### Audit
Logs `service_operator_access_granted` to `shared.audit_log`.
