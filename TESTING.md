# Automated tests

Run both suites from the project root:

```sh
bash scripts/test-backend.sh
npm --prefix frontend test
```

For frontend watch mode:

```sh
npm --prefix frontend run test:watch
```

No dev server is required. The tests do not call your running backend or change `workspace.db`.

## Backend

`backend/src/tests.rs` contains 10 Rust handler integration tests. Each test creates an isolated in-memory SQLite database and invokes the real handlers, password hashing, JWT validation, migrations, and cache. The wrapper runs Cargo in a temporary directory and removes test event logs afterwards.

Coverage includes:

- The complete two-user, five-task, three-assignment validation flow and final James Bond response.
- No JWT before 2FA; hashed persisted codes; incorrect codes, expiry, single use, and attempt limits.
- Missing, invalid, and expired bearer tokens.
- Admin-only task creation, assignment, and user creation.
- Staff task ownership and status updates visible to Admin.
- Atomic assignment rollback, cache expiry, and invalidation after updates.
- Persistent staff accounts with hashed passwords and working login credentials.
- Idempotent seeding, development endpoint guards, and preservation of legacy workspace data.

`cd backend && cargo test` also runs the tests, but the wrapper keeps generated test logs out of the backend directory.

## Frontend

Vitest, jsdom, and React Testing Library run 23 tests across five files. The API client tests mock `fetch`; UI tests mock the API module, then exercise the actual React components through user interactions.

Coverage includes bearer headers, API errors, 2FA stages and loading, Admin task/user forms, staff 403 snackbars, API task rendering, cache metadata, page-specific actions, assignment filtering, status saves and failures, Admin status visibility, empty states, and expired sessions.

These are automated handler/component tests. They do not replace a browser test against a running Rust API.
