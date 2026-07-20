# FieldTrack Backend — Setup Guide

## Why plain SQL migrations (not Prisma/Drizzle)?

Plain SQL was chosen deliberately:
- **Full transparency** — every column, index, and FK is exactly what you read in `schema.sql`. Nothing is generated or hidden.
- **Easier to review** — the whole team can read and understand the schema without learning an ORM's DSL.
- **Stage 11 readiness** — adding photo capture columns and manager hierarchy later is a trivial `ALTER TABLE` in the same file.
- Prisma/Drizzle would add value for *type-safe query builders* — we'll layer that in Phase 2 once the schema stabilises.

---

## Step 1 — Find/reset your PostgreSQL password

**Option A — Reset via pg_ctl (recommended):**
1. Stop the PostgreSQL service from Windows Services (`postgresql-x64-18`)
2. Open a Command Prompt as Administrator:
```
"C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" -D "C:\Program Files\PostgreSQL\18\data" start
```
3. Then connect using Windows trust auth:
```
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres
```
4. Once connected, reset the password:
```sql
ALTER USER postgres PASSWORD 'postgres';
\q
```

**Option B — Check `pg_hba.conf`:**
- File is at: `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`
- Temporarily set auth method to `trust`, restart service, connect, reset password, revert to `md5`.

---

## Step 2 — Set your password in `.env`

Open [.env](file:///c:/Users/sanja/OneDrive/Desktop/Winfomi/FIELD_SALES/backend/.env) and set:
```
DB_PASSWORD=your_actual_password
```

---

## Step 3 — Run migration and seed

```bash
cd backend
node src/db/migrate.js   # Creates "fieldtrack" DB + all 4 tables
node src/db/seed.js      # Inserts 3 employees + 3 dealers
```

**Verify in psql:**
```sql
\c fieldtrack
SELECT * FROM dealers;
SELECT username, role FROM employees;
```

---

## Step 4 — Start the backend

```bash
npm run dev      # nodemon (auto-restart on changes)
# or
npm start        # plain node
```

Server starts at: **http://localhost:3001**

---

## Step 5 — Test with the .http file

Open [fieldtrack.http](file:///c:/Users/sanja/OneDrive/Desktop/Winfomi/FIELD_SALES/backend/fieldtrack.http) in VS Code with the **REST Client** extension.

**Test sequence:**
1. Run `### Login as rep` → copy the `accessToken` value
2. Paste it into `@token = PASTE_ACCESS_TOKEN_HERE` at the top
3. Run the full flow: Day check-in → Dealer check-in → Dealer check-out → Day check-out

---

## Stage "Done When" Checklist

### Stage 3 — Database schema
- [x] 4 tables created with correct columns and FK constraints (`schema.sql`)
- [x] Indexes on `employee_id`, `dealer_id`, `created_at`
- [x] Seed script inserts 3 real dealers + 3 employees
- [x] Migration tool choice explained above (plain SQL, no ORM)

### Stage 4 — Authentication
- [x] `POST /api/auth/login` — returns JWT on valid credentials
- [x] `POST /api/auth/login` — returns 401 on bad credentials (not 500)
- [x] `POST /api/auth/refresh` — exchanges refresh token
- [x] `requireAuth` middleware — 401 on missing/invalid token
- [x] `requireRole('manager')` — 403 for wrong role
- [x] `.http` test file covers all auth scenarios

### Stage 5 — Core API + Haversine
- [x] `POST /api/attendance/check-in` — records GPS + creates attendance row
- [x] `POST /api/attendance/check-out` — calculates `total_duration_minutes`
- [x] `POST /api/visits/check-in` — Haversine `distance_from_previous_km`
- [x] `POST /api/visits/check-out` — radius check + required justification if `out_of_radius`
- [x] `GET /api/dealers` — with `?search=` param
- [x] `GET /api/attendance/today` — restores full day state
- [x] **9/9 Haversine unit tests passing**
- [x] Radius tolerance configurable via `CHECKIN_RADIUS_METERS` env var OR `dealers.radius_meters` column

### Stage 10 — Dashboard API
- [x] `GET /api/dashboard/today` — manager-only, all reps' live status + last coordinates
