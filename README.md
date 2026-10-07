# Workly task workspace

React + Axum + SQLite with email-code 2FA, JWT sessions, Admin task/user management, staff task status updates, and user-scoped caching. Frontend task data always comes from Rust.

## Prerequisites

- **Current Rust stable and Cargo**, installed through [rustup](https://rustup.rs/). The backend uses Rust edition 2024 and let chains.
- **Node.js 20.19+ or 22.12+** and npm, as required by the installed Vite version. Install Node.js from [the official download page](https://nodejs.org/en/download).
- **Python 3**, only for the optional database seed/validation script.
- **curl**, for the API examples below.
- A **C compiler/linker**, needed to build Rust dependencies and bundled SQLite. On macOS, install Command Line Tools with `xcode-select --install` if they are missing. On Linux, install your distribution's build tools.

SQLite is bundled with the Rust dependency; a separate database service, SQLite installation, SMTP server, or Mailtrap account is not required.

From a terminal, confirm your tools are available:

```sh
rustc --version
cargo --version
node --version
npm --version
python3 --version
```

## Run locally

Copy `.env.example` to `.env` at the repository root and replace the signing-secret placeholder. The backend loads this file automatically, and Vite exposes only the `VITE_*` setting. Use the current Rust stable release (let chains require at least 1.88), and Node.js 20.19+ or 22.12+ for Vite.

```sh
cp .env.example .env
```

```sh
cd backend
cargo run
```

In another terminal:

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Vite proxies `/api` to `127.0.0.1:3001`. Run only one backend at a time. Port conflicts produce an actionable error instead of a panic. `API_PORT=3002 cargo run` selects another backend port; update the Vite proxy target to match if doing this.

## Complete environment setup

Open the project directory in your terminal. The following commands are for macOS/Linux shells; run the backend and frontend in separate terminals.

### Terminal 1 — backend

Run these commands from the project root:

```sh
cd backend
export APP_ENV=development
export API_PORT=3001
export DATABASE_PATH=workspace.db
export JWT_SECRET="$(openssl rand -hex 32)"
cargo run
```

The first run builds the Rust dependencies and creates/migrates `backend/workspace.db`. Wait for the `Workspace API: http://127.0.0.1:3001` message before using the frontend. The backend also loads the repository-root `.env` file automatically; exported environment variables take precedence.

Keep the same `JWT_SECRET` while restarting during a session. Generating a new secret invalidates existing JWTs. The value generated above is local to that terminal; set the same value in a new terminal if you want sessions to remain valid.

### Terminal 2 — frontend

Run these commands from the project root:

```sh
cd frontend
npm install
VITE_API_URL=/api npm run dev -- --port 5173
```

Open the URL printed by Vite, normally `http://localhost:5173`. If that frontend port is occupied, Vite may choose the next available port, such as the `5175` shown in the supplied screenshots. API requests still use the frontend's `/api` proxy to the backend on port `3001`.

### Terminal 3 — check availability

These commands are provided for you to run after starting the servers:

```sh
curl -sS http://127.0.0.1:3001/health
```

Expected response:

```json
{"status":"ok"}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_ENV` | `development` | `production` disables `/seed/users`, `/dev/email-logs/latest`, and legacy public registration. Use development mode for the local validation flow. |
| `API_PORT` | `3001` | Backend listening port. If changed, update the proxy target in `frontend/vite.config.js` and restart Vite. |
| `DATABASE_PATH` | `workspace.db` | SQLite file, relative to the backend process's working directory unless an absolute path is supplied. |
| `JWT_SECRET` | Generated on startup | JWT signing secret. Set a stable value to retain sessions across restarts. |
| `VITE_API_URL` | `/api` | Frontend API prefix. Leave this as `/api` for the existing local proxy setup. |

Stop a server with **Ctrl+C** in its terminal. After backend source changes, stop and rerun `cargo run`; the existing backend does not automatically reload. Only one backend should listen on a given port.

## Seed the database

### Seed the validation users only

With the backend running in development mode:

```sh
curl -sS -X POST http://127.0.0.1:3001/seed/users \
  -H 'Content-Type: application/json' \
  -d '{}'
```

This is the same action as **Set up local accounts** in the frontend. It creates or reuses these accounts:

| Name | Email | Role | Password for a newly seeded account |
| --- | --- | --- | --- |
| Admin | `admin@example.com` | `admin` | `Workspace123!` |
| James Bond | `jamesbond@example.com` | `staff` | `Workspace123!` |

Seeding is idempotent. It preserves existing passwords, does not create tasks, and does not delete data. The original development accounts with `@workspace.local` emails are migrated to the canonical emails while keeping their IDs and assignments.

### Seed the complete five-task validation dataset

Use a **new database file**, so the validation produces exactly five tasks and exactly three James Bond assignments. Do not delete your working database.

Stop your existing backend before using the same port. From the project root, start a backend against a database filename that has never been used:

```sh
cd backend
APP_ENV=development DATABASE_PATH=validation-demo.db cargo run
```

In another terminal, from the project root:

```sh
python3 scripts/validate.py
```

The script seeds the two accounts, completes both users' 2FA flows, creates five real database tasks, assigns three to James Bond, checks staff restrictions and caching, and prints the final James Bond response. It leaves the dataset available in `backend/validation-demo.db` for the frontend. It does not reset an existing workspace and stops if tasks are already present. For another run, select another unused database filename.

If the backend is on another port, point the script to it:

```sh
API_URL=http://127.0.0.1:3002 python3 scripts/validate.py
```

To return to your normal workspace, stop the validation backend and run the backend again with `DATABASE_PATH=workspace.db`.

## First-time user guide

### Admin: sign in and organize work

1. Start both servers, open the frontend, and click **Set up local accounts** if the validation accounts do not exist yet.
2. Click **Sign in**, enter `admin@example.com` and the seeded password, and select **Continue with email**.
3. On the verification screen, click **Get local verification code** or copy the six-digit code from the backend console. Select **Verify & sign in** within five minutes. A code can be used once.
4. Open **Tasks → Create task**. Enter a title, choose `high`, `medium`, or `low` priority, and optionally add a description and due date.
5. Select task checkboxes, choose **Assign tasks**, select a staff member, and confirm. A staff member already owning every selected task is omitted; mixed selections skip tasks already assigned to that person.
6. Use search and priority filters to find work. Click **Refresh** on the Tasks screen to retrieve saved changes from the API.
7. To add another staff member, follow the next section. Sign out with the button beside your sidebar profile when finished.

### Admin: create a new user

1. Open **Team members** while signed in as Admin.
2. Click **Create user**.
3. Enter the person's **Username**, **Email address**, and a **Password of at least eight characters**.
4. Submit the form. A success notification confirms that the account was saved to SQLite. The new staff member appears in the team list and assignment dropdown; Admin remains signed in.
5. Provide the new user with their sign-in email and password. They use the same two-factor verification flow as James Bond. The application does not send a separate invitation email.

The email must be unique. Staff cannot use the Admin-only create-user endpoint. Passwords are stored as hashes and are not returned by the API.

### Staff: access tasks and update progress

1. Open the frontend and sign in with the email/password supplied by Admin. For the seeded example, use `jamesbond@example.com` and `Workspace123!`.
2. Retrieve the code from the local verification button or backend console and complete 2FA.
3. Open **Tasks**. Only tasks assigned to your account are listed. An empty list means Admin has not assigned any work yet.
4. Use the status dropdown in the task row or task details to choose **To do**, **In progress**, or **Completed**. Wait for the save notification.
5. Admin can see the saved status and updated completed count after refreshing the Tasks screen.
6. Staff cannot create or assign tasks. Clicking **Create task** returns 403 and shows **The task creation rights are reserved for admins** in a snackbar.
7. Click **Refresh** again within the cache lifetime to see **Loaded from cache**. Assignments and status updates invalidate cached results so a new read can return fresh data.

### Retrieve a code with curl

Start a login:

```sh
curl -sS -X POST http://127.0.0.1:3001/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"Workspace123!"}'
```

Copy the returned `login_challenge_id`, then retrieve its development email record:

```sh
curl -sS --get http://127.0.0.1:3001/dev/email-logs/latest \
  --data-urlencode 'login_challenge_id=REPLACE_WITH_CHALLENGE_ID'
```

Submit the returned `code`:

```sh
curl -sS -X POST http://127.0.0.1:3001/auth/verify-2fa \
  -H 'Content-Type: application/json' \
  -d '{"login_challenge_id":"REPLACE_WITH_CHALLENGE_ID","code":"REPLACE_WITH_CODE"}'
```

Use the returned `access_token` for protected API calls:

```sh
curl -sS http://127.0.0.1:3001/tasks \
  -H 'Authorization: Bearer REPLACE_WITH_ADMIN_TOKEN'
```

For James Bond, sign in and verify separately, then call this endpoint twice with his token:

```sh
curl -sS http://127.0.0.1:3001/tasks/view-my-tasks \
  -H 'Authorization: Bearer REPLACE_WITH_JAMES_BOND_TOKEN'
```

The first read after a cold or invalidated cache returns `cache.hit: false`; a repeat read within 60 seconds returns `true`. Do not reuse a verification code or replace the login challenge with a JWT—the JWT is issued only after successful verification.

## Validation flow

Use a fresh SQLite database for the exactly-five-task validation. Existing workspaces and tasks are preserved; setup never deletes tasks or adds task fixtures.

1. Click **Set up local accounts**, or `POST /seed/users` with `{}`. This idempotently creates `admin@example.com` (Admin) and `jamesbond@example.com` (James Bond, staff). New accounts use `Workspace123!`; existing passwords are preserved.
2. Sign in as Admin. `/auth/login` returns only a challenge, never a JWT.
3. Read the six-digit verification code in the API console, click **Get local verification code**, or call `GET /dev/email-logs/latest?login_challenge_id=<challenge-id>`.
4. Submit the code to `/auth/verify-2fa`. The response includes `access_token`, the compatibility alias `token`, and `user`.
5. Create exactly five tasks as Admin, with high/medium/low priorities represented among the three tasks you will assign.
6. Select exactly three tasks and assign them to James Bond.
7. Sign out and log in as `jamesbond@example.com`, then verify his own code.
8. James's frontend displays exactly his three assigned tasks. Click **Create task**: the API returns 403 and a snackbar says **The task creation rights are reserved for admins**.
9. Click **Refresh** within 60 seconds. `GET /tasks/view-my-tasks` returns `cache.hit = true` after its first database read.

James can update assigned tasks to **To do**, **In progress**, or **Completed**. Changes persist and invalidate the cache. Admin sees these statuses and the completed count on Refresh.

For additional staff users, Admin opens **Team members → Create user** and enters a username, email, and password. Accounts are stored with Argon2 password hashes and can use the same login/2FA flow.

## API reference

Base URL: `http://127.0.0.1:3001`, or `/api` through Vite. JSON requests/responses. Protected calls use `Authorization: Bearer <access_token>`.

| Method | Endpoint | Access / body |
| --- | --- | --- |
| POST | `/seed/users` | Development only; `{}`; creates/reuses the two validation users, no tasks |
| POST | `/auth/login` | `{ "email": "admin@example.com", "password": "Workspace123!" }` → `login_challenge_id`, `expires_in: 300` |
| GET | `/dev/email-logs/latest` | Development only; optional `email` or `login_challenge_id` query; returns latest active email event/code |
| POST | `/auth/verify-2fa` | `{ "login_challenge_id": "…", "code": "123456" }` → `access_token`, `token`, `token_type`, `expires_in`, `user` |
| POST | `/auth/verify` | Compatibility alias for `/auth/verify-2fa` |
| POST | `/auth/register` | Legacy development-only registration route |
| GET | `/users` | Admin only |
| POST | `/users` | Admin only; `{ "name": "New user", "email": "user@example.com", "password": "AtLeast8Characters" }`. Also accepts `full_name`, `username`/`userName`, and `emailId` |
| GET | `/tasks` | Admin only; all database tasks |
| POST | `/tasks` | Admin only; `{ "title": "Prepare brief", "description": "…", "priority": "high", "due_date": "2026-10-12" }` |
| POST | `/tasks/assign` | Admin only; `{ "task_ids": [1,2,3], "user_id": 2 }`; `assigned_to_id` is an alias for `user_id` |
| PATCH | `/tasks/{task_id}/status` | Assigned staff or Admin; `{ "status": "in-progress" }`. Valid: `todo`, `in-progress`, `completed`; legacy `to-do` is normalized to `todo` |
| GET | `/tasks/view-my-tasks` | Authenticated; database-generated user-scoped tasks, summary and cache metadata |
| GET | `/health` | Public health check |

Example James Bond response (numeric IDs are generated by SQLite):

```json
{
  "user": {"email": "jamesbond@example.com", "role": "staff"},
  "tasks": [
    {"id": 3, "title": "Organize the design assets", "status": "todo", "priority": "low", "assigned_to": "jamesbond@example.com"},
    {"id": 2, "title": "Review the onboarding flow", "status": "todo", "priority": "medium", "assigned_to": "jamesbond@example.com"},
    {"id": 1, "title": "Prepare the project brief", "status": "todo", "priority": "high", "assigned_to": "jamesbond@example.com"}
  ],
  "summary": {"total_assigned_tasks": 3},
  "cache": {"hit": false, "ttl_seconds": 60}
}
```

Actual responses also include user names/timestamps and task description, creator ID, assignee ID, timestamps, due date, and compatibility fields for the existing UI. The sample above is documentation, not application data. Repeating the call before expiry returns the same tasks with `cache.hit: true`.

## Storage and 2FA

SQLite stores users (`full_name`, email, `hashed_password`, role, created/updated timestamps), tasks (`created_by_id`, `assigned_to_id`, status, priority, created/updated timestamps), `login_challenges`, and `email_logs`. Passwords and persisted verification codes use salted Argon2 hashes. Password hashes are never included in API responses.

Codes expire after **five minutes**, are single-use, and permit at most five attempts. Incorrect, expired, consumed, and exhausted challenges return 401. JWTs are issued only after verification and expire after one hour. Verification consumption is serialized with SQLite updates to prevent replay through concurrent requests.

Raw codes exist only in the API console and process memory used by the development email endpoint. Restarting the backend clears the raw-code lookup; start a new login if needed. Email event metadata and code hashes persist in SQLite. Startup redacts raw codes from the earlier `dev-emails.log` format; new log files never store raw codes.

SQL migration files are in `backend/migrations/`. Startup applies them in one SQLite transaction, records versions in `schema_migrations`, and upgrades legacy columns automatically; no migration CLI is needed. The next backend startup applies additive schema migrations without deleting users/tasks. Original `admin@workspace.local` and `james@workspace.local` validation accounts are upgraded to the canonical emails when `/seed/users` is called, keeping IDs, passwords, and assignments. Legacy `to-do` statuses become `todo`. Older user timestamps are initialized during migration because the original schema did not record them. Compatibility columns (`name`, `password_hash`, `assignee_id`) remain alongside the canonical data fields.

The backend binds to localhost. `APP_ENV=production` disables the seed, development email, and legacy public registration routes. The current email transport is console delivery; no SMTP service is required. `JWT_SECRET` selects a stable signing secret; otherwise startup generates a new one and old sessions expire. `DATABASE_PATH` selects the SQLite file (default `backend/workspace.db` when launched from `backend`).

The cache is an in-memory, process-local cache rather than Redis. It is cleared on restart and is suitable for one local backend instance. Multiple backend instances would need a shared cache/invalidation service. Assignment and status updates currently invalidate all local task-list entries, including every affected user.

## Logs

The console and `backend/dev-events.log` record structured JSON events:

- `email.delivery`: recipient email, challenge ID, delivery channel, success.
- `auth.verified`: email, success, JWT-issued flag, and the returned JWT in development mode.
- `tasks.view-my-tasks`: email, source (`database`/`cache`), and `cache.hit`.
- `api.response`: method, route, HTTP status, success/failure, elapsed milliseconds; includes staff `POST /tasks` failures with status 403 and parsing/authentication failures.

Raw verification codes appear only in separate console email events, never in `dev-events.log` or SQLite. These logs are ignored by Git.

## Validation script

The script has been updated for this contract. It is not run automatically.

With a fresh development database running, execute from the project root:

```sh
python3 scripts/validate.py
```

It seeds users idempotently, exercises challenge-before-JWT and code replay rejection, creates exactly five tasks, assigns exactly three, checks staff permissions/isolation and cache invalidation, and prints the final James Bond database response. It refuses to create tasks if the workspace already contains any. For another validation flow, start the backend with a different `DATABASE_PATH`; do not delete existing work.

## Screenshots

These supplied screenshots illustrate the UI. Some show an earlier workspace with six tasks and legacy `@workspace.local` account emails; they are not the expected output of the fresh five-task validation flow documented above.

### Sign in

![Login form with email, password, and two-step verification](docs/images/login.png)

### Admin task workspace

![Admin task list showing priorities, assignees, and due dates](docs/images/admin-task-workspace.png)

### Create a task

![Admin create-task form](docs/images/create-task.png)

### Team members

![Admin team members screen with Create user](docs/images/admin-team-members.png)

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Backend reports address already in use | Stop the existing backend before restarting, or choose another `API_PORT` and update Vite's proxy target. |
| Frontend cannot reach the API | Confirm `/health` responds, and that the proxy target matches the backend port. Read the backend terminal for errors. |
| Code expired, incorrect, or already used | Return to sign in, begin a new login challenge, and retrieve its new code. |
| Development email endpoint returns 404 | Start a fresh login before requesting a code, check the challenge ID, and use `APP_ENV=development`. A backend restart clears raw codes held in memory. |
| New user cannot sign in | Use their email rather than username, confirm the Admin-created account exists, and use the password supplied during creation. Existing seed passwords are not reset by reseeding. |
| Session expired after backend restart | Sign in again, or retain the same `JWT_SECRET` when restarting. |
| Validation script finds existing tasks | Use a new `DATABASE_PATH` instead of deleting existing work. |
| Screenshots differ from the current task count | Screenshots are UI examples. Live tasks and counts come from the selected SQLite database. |

## Tests and checks

```sh
bash scripts/test-backend.sh
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
cd backend
cargo fmt -- --check
cargo clippy --all-targets -- -D warnings
```

See [TESTING.md](TESTING.md) for coverage and isolation details, and [AI_USAGE.md](AI_USAGE.md) for the AI disclosure and human decisions.
