# PulseCheck

PulseCheck is a Node.js application. Express owns the HTTP API and serves the static frontend. The frontend is authored with the Next.js Pages Router and exported to HTML, CSS, and JavaScript assets during the build.

## Request flow

```text
Browser ──> Node.js Express ──> Firebase Authentication / Firestore
                    │
                    ├── serves exported files from out/
                    ├── validates API requests and sessions
                    └── handles scheduled Vercel Function requests
```

Locally, `node server.js` starts an Express listener. On Vercel, `api/[...path].js` exports the same Express application as a Node.js Function. It does not call `listen()` in production and does not require a continuously running process. Vercel rewrites requests to that function, which serves the static files in `out/` and handles `/api/*` routes.

## Technology

- Node.js 22 or newer and Express 5 for the request server.
- Next.js Pages Router, React, Tailwind CSS, Recharts, and Lucide React for the static frontend.
- Firebase Authentication and Firebase Admin SDK for identity and server access.
- Cloud Firestore for monitors, checks, incidents, analytics, notification tasks, and published status data.
- Zod for request validation, Nodemailer for SMTP, and Firebase Cloud Messaging for browser push.
- Vercel for static asset delivery, Node.js Functions, and cron scheduling.

## Run locally

1. Create a Firebase project and register a Web app.
2. In Firebase Authentication, enable Email/Password, configure email verification and password reset templates, and add your local and production domains to authorized domains.
3. Create a Cloud Firestore database. Deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI.
4. Create a service account with Firebase Authentication and Firestore permissions. Do not commit its JSON key.
5. Copy `.env.example` to `.env.local`. Add the Firebase Web configuration, Admin project ID/email/private key, `CRON_SECRET`, and `APP_ORIGIN`. Add SMTP values to enable email and a Firebase Web Push certificate to enable browser push.
6. Run `npm install`, `npm run build`, and `npm start`. The build exports the pages into `out/` and writes the Firebase Messaging service worker when its public configuration is present.
7. Open `http://localhost:3000`.

The Firebase Admin private key may contain escaped `\\n` line breaks. The Admin initializer normalizes them.

## Vercel deployment

1. Import the project into Vercel. The Function runtime is pinned to Node.js 22 for Firebase Admin compatibility.
2. Add the `.env.example` values to Vercel's Development, Preview, and Production environments. Set `APP_ORIGIN` to the exact public origin for each environment. Never add the service account JSON file.
3. Deploy with `vercel --prod`. `vercel.json` builds the static export, packages it into the Express Function, and sends page, asset, API, and cron requests through the Node.js handler. Express serves the exported files from `out/`.
4. Confirm `/api/health`, check the Vercel Cron page, and verify that `/`, `/dashboard`, `/settings`, and `/status?slug=...` load.
5. Test account registration, email verification, login, password reset, a monitor outage and recovery, SMTP or webhook delivery, browser push, analytics, and public status page visibility in a non-production project.

The included Vercel Hobby configuration runs monitoring, notification delivery, and analytics once per day because Hobby permits daily cron schedules. It sets `MIN_MONITOR_INTERVAL_SECONDS=86400` and `MAX_MONITORS_PER_USER=12`; the dashboard and API enforce those limits. This fits the daily execution budget for the included monitor batch size. Vercel plans that permit more frequent cron schedules can change the cron expressions and set the minimum interval to a supported value such as 60, 300, 600, 1800, or 3600 seconds. A 30-second schedule is not supported. Cron work is paginated and bounded, uses expiring leases, and resumes on later invocations.

## Node.js routes

Express routes live in `server/app.js`; reusable backend services live under `src/lib/`:

- `/api/auth/session` creates and clears HTTP-only session cookies.
- `/api/users/profile`, `/api/monitors`, `/api/incidents`, `/api/notifications`, `/api/status-pages`, and `/api/analytics` are authenticated APIs. Private ownership is derived from a verified Firebase token or session cookie.
- `/api/cron/monitor`, `/api/cron/notifications`, and `/api/cron/analytics` require `Authorization: Bearer $CRON_SECRET`.
- `/api/health` is a public health check.

The Express API validates monitor data, keeps custom headers out of API responses, checks webhook target DNS and redirects, and stores webhook secrets and FCM tokens in server-only Firestore documents. Public status pages read from a separate collection containing approved public fields.

## Firestore data

Private user records are stored under `users/{uid}`. Monitor checks and aggregates are stored under `monitors/{monitorId}` for scheduled querying. Incidents have an `updates` subcollection; private copies support owner-only realtime listeners. Notification tasks use `Pending`, `Processing`, `Delivered`, and `Failed` states with idempotency keys, leases, bounded retries, and exponential backoff. Analytics are aggregated into UTC hourly and daily buckets. Downtime is an estimate based on failed checks and the configured interval.

Admin SDK access bypasses Security Rules, so each API checks ownership. Browser Firestore access is read-only and restricted to the authenticated owner's user subtree. Public status documents contain only published names, descriptions, and monitor health.

## Checks

`npm run build` verifies that all expected frontend pages export successfully. `npm test` runs the Node test suite for monitor validation, SSRF address screening, static page serving, the health route, private API authorization, and cron authorization. Firebase Auth, Firestore, SMTP, Vercel cron, and FCM still require valid project configuration for end-to-end checks. In particular, enable Email/Password in Firebase Authentication and add the deployed Vercel domain to Firebase's authorized domains before testing sign-in.
