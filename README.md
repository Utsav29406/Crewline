# Crewline — Smart HRMS

Attendance, leave and payroll with **face recognition**, **geofencing** and a soft (neumorphic) UI.

**Stack:** React 18 + Vite · Node.js + Express 5 · PostgreSQL on [Neon](https://neon.tech) · face-api.js (TensorFlow.js) · Leaflet + OpenStreetMap

## Features

| Area | What it does |
|---|---|
| **Face punch-in** | Camera detects exactly one centred face, requires a **blink** (liveness against printed photos), then sends a 128-number face signature. The server matches it against the employee's enrolled samples. No photos are stored. |
| **Geofencing** | The server checks GPS position against the employee's assigned zone (or any active zone) using the haversine distance, allowing up to 30 m of GPS error. |
| **Verification log** | Every attempt, passed or rejected, is logged with its distance and face score so you can spot proxy attempts. |
| **Attendance** | Late arrival (shift start + grace), half day (under the minimum hours), worked hours, CSV export. |
| **Leaves** | Casual, sick, earned and unpaid leave. Yearly quotas, a balance check, overlap detection, and a count that skips Sundays and holidays. Approve or reject flow. |
| **Payroll** | Monthly payroll runs with PF and professional tax, publish to staff, payslips employees can view and print. CSV export. |
| **Tasks** | Admin/HR (and seniors, for the people who report to them) give tasks with priority, due date and estimate. Staff move them To do → In progress → Done; time comes from the desktop tracker. |
| **Desktop tracker** | Electron app in `tracker/` (Windows; Linux without screenshots). While someone is checked in it sends heartbeats, takes screenshots, starts a short break after 6 idle minutes and logs time to a task. The dashboard offers the right download for each computer. |
| **Daily attendance email** | Optional: each person is emailed their day (check-in, breaks, lunch, check-out) on punch-out, with an after-midnight backup run. |
| **Admin** | Employees, departments, holidays, geofences on a map (click to place, slider for the radius), attendance policy switches. |
| **Roles** | `admin` (everything), `hr` (manage people, approve leave), `employee` (self-service). |
| **UI** | Soft UI with light and dark themes. Responsive down to phone width. |

## Setup

### 1. Create the Neon database
1. Sign in at **console.neon.tech** and create a project (e.g. `crewline`).
2. Open **Connect**, pick the database, turn on **Connection pooling**, and copy the connection string.

### 2. Configure and run
```bash
npm run setup                       # installs root, server and client deps
cp server/.env.example server/.env  # then paste your Neon URL into DATABASE_URL
npm run seed                        # creates tables + demo data
npm run dev                         # API on :4000, web app on :5173
```
Open http://localhost:5173.

| Demo login | Password |
|---|---|
| admin@crewline.io | admin123 |
| hr@crewline.io | hr1234 |
| arjun@crewline.io | employee123 |

The seeded "Head Office" geofence is in Ahmedabad. Edit it from **Geofences → Use my location**, or turn geofencing off in **Settings** while testing.

### Environment (`server/.env`)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string (`?sslmode=require`) |
| `JWT_SECRET` | Long random string used to sign sessions |
| `FACE_MATCH_THRESHOLD` | Maximum face distance that counts as a match. Lower is stricter. Default `0.5`. |
| `APP_TIMEZONE` | Business timezone. It decides what "today" and "late" mean. Neon runs in UTC, so the app stamps times itself. (`TZ` is reserved on Vercel.) |
| `CRON_SECRET` | Vercel sends it to the cron routes (`/api/cron/...`) in `vercel.json`. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store for tracker screenshots and the tracker installers (`downloads/`). Added when the store is connected. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Outgoing mail for the daily attendance email (e.g. Gmail with an app password, port 465). |

## Deploying to Vercel
The project is set up for Vercel already. `api/index.js` runs the Express API as a serverless function, and the React build is served statically. Both run in Singapore (`sin1`), next to the Neon database.
```bash
vercel deploy --prod
```
The project's environment variables are listed above; `DATABASE_URL` comes from the Neon integration. A frontend-only copy is on Firebase Hosting: `npm run deploy:firebase` builds the client against the Vercel API and deploys it.

## Production on your own server
```bash
npm run build && npm start   # Express serves client/dist and the API on PORT
```
Camera and GPS only work over **HTTPS** (or on `localhost`), so deploy behind TLS.

## Project layout
```
server/src/
  schema.sql        Postgres schema (applied automatically on start / seed)
  db.js             pg pool, `?` placeholder helper, transactions
  routes/           auth, employees (+ face enroll), attendance, leaves, payroll, tasks, tracker, live, admin
  autoAttendance.js scheduled check-in/out helper (cron)
  dailyLog.js       daily attendance email
client/src/
  face.js           model loading, detection, blink (eye-aspect-ratio) liveness
  components/       FaceCapture, FenceMap, TrendChart, Layout, UI kit
  pages/            Dashboard, Punch, Attendance, Leaves, Tasks, Activity, Payroll, Employees, Geofences, Reports, Settings, Profile
client/public/models  face-api weights (served locally, ~7 MB)
tracker/            Electron desktop tracker (`npm run dist:win-zip`, `npm run dist:linux`)
```

## Security notes
- The server, not the browser, decides whether a punch passes the face match and the geofence.
- Blink liveness stops printed photos, but not a replayed video or a spoofed GPS position. For stronger anti-spoofing, add a server-side liveness model or a device attestation step, and use mock-location detection in a mobile app.
- An employee can enroll their own face once. Re-enrolling needs HR or an admin.
