use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, patch, post},
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::Rng;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

type Failure = (StatusCode, Json<Value>);
type ApiResult = Result<Json<Value>, Failure>;
const CACHE_TTL: Duration = Duration::from_secs(60);
const CODE_TTL_SECONDS: u64 = 300;
const USER_COLUMNS: &str = "id,name,full_name,email,role,created_at,updated_at";

struct AppState {
    db: Mutex<Connection>,
    cache: Mutex<HashMap<i64, CachedTasks>>,
    // Raw codes are kept only in memory for the local development email endpoint.
    emails: Mutex<Vec<DevEmail>>,
    secret: String,
    development: bool,
}
struct CachedTasks {
    expires_at: Instant,
    tasks: Vec<Task>,
}
#[derive(Clone, Serialize)]
struct User {
    id: i64,
    name: String,
    full_name: String,
    email: String,
    role: String,
    created_at: String,
    updated_at: String,
}
#[derive(Clone, Serialize)]
struct Task {
    id: i64,
    title: String,
    description: String,
    status: String,
    priority: String,
    created_by_id: Option<i64>,
    assigned_to_id: Option<i64>,
    assigned_to: Option<String>,
    // Compatibility fields for the existing frontend.
    assignee_id: Option<i64>,
    assignee_name: Option<String>,
    due_date: String,
    created_at: String,
    updated_at: String,
}
#[derive(Clone, Serialize)]
struct DevEmail {
    email: String,
    login_challenge_id: String,
    code: String,
    sent_at: u64,
    expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct Claims {
    sub: i64,
    exp: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn err(status: StatusCode, message: &str) -> Failure {
    (status, Json(json!({"message": message})))
}
fn log_event(event: &str, mut fields: Value) {
    fields["timestamp"] = json!(now());
    fields["event"] = json!(event);
    let line = fields.to_string();
    println!("{line}");
    if let Err(error) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("dev-events.log")
        .and_then(|mut file| writeln!(file, "{line}"))
    {
        eprintln!("Unable to append event log: {error}");
    }
}
async fn log_requests(request: Request, next: Next) -> Response {
    let method = request.method().to_string();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    log_event(
        "api.response",
        json!({
            "method": method, "path": path, "status": response.status().as_u16(),
            "success": response.status().is_success(), "elapsed_ms": started.elapsed().as_millis(),
        }),
    );
    response
}
fn database_error(error: impl std::fmt::Display) -> Failure {
    log_event(
        "database.error",
        json!({"success": false, "error": error.to_string()}),
    );
    err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Unable to load workspace data. Please try again.",
    )
}
fn insertion_error(error: rusqlite::Error) -> Failure {
    if let rusqlite::Error::SqliteFailure(code, _) = &error
        && code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
    {
        return err(StatusCode::CONFLICT, "This email is already registered.");
    }
    database_error(error)
}
fn hash_secret(secret: &str) -> Result<String, Failure> {
    Argon2::default()
        .hash_password(secret.as_bytes(), &SaltString::generate(&mut OsRng))
        .map(|hash| hash.to_string())
        .map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Unable to protect account credentials.",
            )
        })
}
fn matches_secret(secret: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|parsed| {
        Argon2::default()
            .verify_password(secret.as_bytes(), &parsed)
            .is_ok()
    })
}
fn user_row(row: &Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get(0)?,
        name: row.get(1)?,
        full_name: row.get(2)?,
        email: row.get(3)?,
        role: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}
fn authenticated(s: &AppState, headers: &HeaderMap) -> Result<User, Failure> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Please sign in to continue."))?;
    let claims = decode::<Claims>(
        token,
        &DecodingKey::from_secret(s.secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| {
        err(
            StatusCode::UNAUTHORIZED,
            "Your session expired. Please sign in again.",
        )
    })?
    .claims;
    s.db.lock()
        .map_err(database_error)?
        .query_row(
            &format!("SELECT {USER_COLUMNS} FROM users WHERE id=?"),
            [claims.sub],
            user_row,
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "User not found."))
}
fn admin(s: &AppState, headers: &HeaderMap) -> Result<User, Failure> {
    let user = authenticated(s, headers)?;
    if user.role != "admin" {
        return Err(err(
            StatusCode::FORBIDDEN,
            "Only admins can create or assign tasks. Your staff account can view tasks assigned to you.",
        ));
    }
    Ok(user)
}
fn validate_user(name: &str, email: &str, password: &str) -> Result<(), Failure> {
    let valid_email = email.split_once('@').is_some_and(|(local, domain)| {
        !local.is_empty() && domain.contains('.') && !domain.contains('@')
    }) && !email.chars().any(char::is_whitespace);
    if name.trim().is_empty() || !valid_email || password.len() < 8 {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Enter a username, valid email, and password of at least 8 characters.",
        ));
    }
    Ok(())
}
fn insert_user(
    db: &Connection,
    name: &str,
    email: &str,
    hash: &str,
    role: &str,
) -> Result<User, Failure> {
    db.execute(
        "INSERT INTO users(name,full_name,email,password_hash,hashed_password,role,created_at,updated_at)
         VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",
        params![name.trim(), name.trim(), email, hash, hash, role],
    ).map_err(insertion_error)?;
    db.query_row(
        &format!("SELECT {USER_COLUMNS} FROM users WHERE id=?"),
        [db.last_insert_rowid()],
        user_row,
    )
    .map_err(database_error)
}
#[derive(Deserialize)]
struct Registration {
    name: String,
    email: String,
    password: String,
    role: String,
}
async fn register(State(s): State<Arc<AppState>>, Json(body): Json<Registration>) -> ApiResult {
    if !s.development {
        return Err(err(StatusCode::NOT_FOUND, "Endpoint not available."));
    }
    let email = body.email.trim().to_lowercase();
    validate_user(&body.name, &email, &body.password)?;
    if !["admin", "staff"].contains(&body.role.as_str()) {
        return Err(err(StatusCode::BAD_REQUEST, "Choose admin or staff."));
    }
    let hash = hash_secret(&body.password)?;
    let db = s.db.lock().map_err(database_error)?;
    let admins: i64 = db
        .query_row("SELECT COUNT(*) FROM users WHERE role='admin'", [], |r| {
            r.get(0)
        })
        .map_err(database_error)?;
    if body.role == "admin" && admins > 0 {
        return Err(err(
            StatusCode::CONFLICT,
            "An admin already exists. Sign in with the existing admin account.",
        ));
    }
    Ok(Json(
        json!({"user": insert_user(&db, &body.name, &email, &hash, &body.role)?}),
    ))
}
async fn seed_users(State(s): State<Arc<AppState>>) -> ApiResult {
    if !s.development {
        return Err(err(StatusCode::NOT_FOUND, "Endpoint not available."));
    }
    let hash = hash_secret("Workspace123!")?;
    let mut cache = s.cache.lock().map_err(database_error)?;
    let mut db = s.db.lock().map_err(database_error)?;
    let tx = db.transaction().map_err(database_error)?;
    let mut users = Vec::new();
    for (name, email, legacy_email, role) in [
        (
            "Admin",
            "admin@example.com",
            "admin@workspace.local",
            "admin",
        ),
        (
            "James Bond",
            "jamesbond@example.com",
            "james@workspace.local",
            "staff",
        ),
    ] {
        let existing = tx
            .query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE email=?"),
                [email],
                user_row,
            )
            .optional()
            .map_err(database_error)?;
        if let Some(user) = existing {
            if user.role != role {
                return Err(err(
                    StatusCode::CONFLICT,
                    "A validation email already belongs to an account with a different role.",
                ));
            }
            users.push(user);
            continue;
        }
        // Upgrade original development accounts without changing their IDs, passwords, or task assignments.
        let migrated = tx.execute(
            "UPDATE users SET email=?,updated_at=CURRENT_TIMESTAMP WHERE email=? AND name=? AND role=?",
            params![email, legacy_email, name, role],
        ).map_err(database_error)?;
        let user = if migrated > 0 {
            tx.query_row(
                &format!("SELECT {USER_COLUMNS} FROM users WHERE email=?"),
                [email],
                user_row,
            )
            .map_err(database_error)?
        } else {
            insert_user(&tx, name, email, &hash, role)?
        };
        users.push(user);
    }
    tx.commit().map_err(database_error)?;
    cache.clear();
    Ok(Json(
        json!({"users": users, "message": "Validation users are ready. Existing passwords are preserved. No tasks were created."}),
    ))
}
#[derive(Deserialize)]
struct Login {
    email: String,
    password: String,
}
async fn login(State(s): State<Arc<AppState>>, Json(body): Json<Login>) -> ApiResult {
    let email = body.email.trim().to_lowercase();
    let (user, hash) = {
        let db = s.db.lock().map_err(database_error)?;
        db.query_row(
            &format!("SELECT {USER_COLUMNS},hashed_password FROM users WHERE email=?"),
            [email],
            |row| Ok((user_row(row)?, row.get::<_, String>(7)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Email or password is incorrect."))?
    };
    if !matches_secret(&body.password, &hash) {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "Email or password is incorrect.",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let code = format!("{:06}", rand::thread_rng().gen_range(0..1000000));
    let code_hash = hash_secret(&code)?;
    let sent_at = now();
    let expires_at = sent_at + CODE_TTL_SECONDS;
    {
        let mut db = s.db.lock().map_err(database_error)?;
        let tx = db.transaction().map_err(database_error)?;
        tx.execute(
            "INSERT INTO login_challenges(id,user_id,code_hash,expires_at) VALUES(?,?,?,?)",
            params![id, user.id, code_hash, expires_at],
        )
        .map_err(database_error)?;
        tx.execute("INSERT INTO email_logs(user_id,email,challenge_id,code_hash,sent_at,delivery_status) VALUES(?,?,?,?,?,'sent')",
            params![user.id, user.email, id, code_hash, sent_at]).map_err(database_error)?;
        tx.commit().map_err(database_error)?;
    }
    if s.development {
        let mut emails = s.emails.lock().map_err(database_error)?;
        emails.retain(|email| email.expires_at > sent_at);
        emails.push(DevEmail {
            email: user.email.clone(),
            login_challenge_id: id.clone(),
            code: code.clone(),
            sent_at,
            expires_at,
        });
    }
    log_event(
        "email.delivery",
        json!({"email": user.email, "success": true,
        "channel": "development-console", "login_challenge_id": id}),
    );
    // Console delivery is allowed; raw verification codes are never written to a file or SQLite.
    println!(
        "[DEV EMAIL] To: {} | Verification code: {} | Challenge: {}",
        user.email, code, id
    );
    Ok(Json(
        json!({"login_challenge_id": id, "expires_in": CODE_TTL_SECONDS,
        "message": "A verification code was sent to the development email console."}),
    ))
}
#[derive(Default, Deserialize)]
struct EmailQuery {
    email: Option<String>,
    login_challenge_id: Option<String>,
}
async fn latest_email(
    State(s): State<Arc<AppState>>,
    Query(query): Query<EmailQuery>,
) -> ApiResult {
    if !s.development {
        return Err(err(StatusCode::NOT_FOUND, "Endpoint not available."));
    }
    let emails = s.emails.lock().map_err(database_error)?;
    let email = emails
        .iter()
        .rev()
        .find(|email| {
            email.expires_at > now()
                && query
                    .email
                    .as_ref()
                    .is_none_or(|value| value.trim().eq_ignore_ascii_case(&email.email))
                && query
                    .login_challenge_id
                    .as_ref()
                    .is_none_or(|id| id == &email.login_challenge_id)
        })
        .ok_or_else(|| {
            err(
                StatusCode::NOT_FOUND,
                "No active development email found. Start login again.",
            )
        })?;
    Ok(Json(
        json!({"email": email.email, "login_challenge_id": email.login_challenge_id,
        "code": email.code, "verification_code": email.code, "sent_at": email.sent_at, "expires_at": email.expires_at}),
    ))
}
#[derive(Deserialize)]
struct Verification {
    #[serde(alias = "challenge_id")]
    login_challenge_id: String,
    #[serde(alias = "verification_code")]
    code: String,
}
async fn verify(State(s): State<Arc<AppState>>, Json(body): Json<Verification>) -> ApiResult {
    let db = s.db.lock().map_err(database_error)?;
    let challenge = db
        .query_row(
            "SELECT user_id,code_hash,expires_at,attempts,used_at FROM login_challenges WHERE id=?",
            [&body.login_challenge_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                    row.get::<_, u8>(3)?,
                    row.get::<_, Option<u64>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| {
            err(
                StatusCode::UNAUTHORIZED,
                "Invalid challenge. Please sign in again.",
            )
        })?;
    let (user_id, code_hash, expires_at, attempts, used_at) = challenge;
    if used_at.is_some() || expires_at <= now() || attempts >= 5 {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "Code already used, expired, or attempt limit reached. Please sign in again.",
        ));
    }
    db.execute(
        "UPDATE login_challenges SET attempts=attempts+1 WHERE id=?",
        [&body.login_challenge_id],
    )
    .map_err(database_error)?;
    if !matches_secret(&body.code, &code_hash) {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "That verification code is incorrect.",
        ));
    }
    let user = db
        .query_row(
            &format!("SELECT {USER_COLUMNS} FROM users WHERE id=?"),
            [user_id],
            user_row,
        )
        .map_err(database_error)?;
    let token = encode(
        &Header::default(),
        &Claims {
            sub: user.id,
            exp: now() + 3600,
        },
        &EncodingKey::from_secret(s.secret.as_bytes()),
    )
    .map_err(|_| {
        err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Unable to start the session.",
        )
    })?;
    db.execute(
        "UPDATE login_challenges SET used_at=? WHERE id=?",
        params![now(), body.login_challenge_id],
    )
    .map_err(database_error)?;
    let mut event = json!({"email": user.email, "success": true, "jwt_issued": true});
    if s.development {
        event["jwt"] = json!(token);
    }
    log_event("auth.verified", event);
    Ok(Json(
        json!({"token": token, "access_token": token, "token_type": "Bearer", "expires_in": 3600, "user": user}),
    ))
}
fn read_tasks(s: &AppState, user_id: Option<i64>) -> Result<Vec<Task>, Failure> {
    let db = s.db.lock().map_err(database_error)?;
    let mut query = db.prepare(
        "SELECT t.id,t.title,t.description,t.status,t.priority,t.created_by_id,t.assigned_to_id,
                u.email,u.full_name,t.due_date,t.created_at,t.updated_at
         FROM tasks t LEFT JOIN users u ON u.id=t.assigned_to_id
         WHERE (?1 IS NULL OR t.assigned_to_id=?1) ORDER BY t.id DESC",
    ).map_err(database_error)?;
    query
        .query_map([user_id], |row| {
            let assignee_id = row.get(6)?;
            Ok(Task {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                priority: row.get(4)?,
                created_by_id: row.get(5)?,
                assigned_to_id: assignee_id,
                assigned_to: row.get(7)?,
                assignee_id,
                assignee_name: row.get(8)?,
                due_date: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)
}
async fn tasks(State(s): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    admin(&s, &headers)?;
    Ok(Json(json!({"tasks": read_tasks(&s, None)?})))
}
async fn my_tasks(State(s): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    let user = authenticated(&s, &headers)?;
    let mut cache = s.cache.lock().map_err(database_error)?;
    if let Some(entry) = cache.get(&user.id)
        && Instant::now() < entry.expires_at
    {
        log_event(
            "tasks.view-my-tasks",
            json!({"email": user.email, "cache": {"hit": true}, "source": "cache"}),
        );
        return Ok(Json(json!({"user": user, "tasks": entry.tasks,
            "summary": {"total_assigned_tasks": entry.tasks.len()}, "cache": {"hit": true, "ttl_seconds": CACHE_TTL.as_secs()}})));
    }
    let tasks = read_tasks(&s, Some(user.id))?;
    log_event(
        "tasks.view-my-tasks",
        json!({"email": user.email, "cache": {"hit": false}, "source": "database"}),
    );
    cache.insert(
        user.id,
        CachedTasks {
            expires_at: Instant::now() + CACHE_TTL,
            tasks: tasks.clone(),
        },
    );
    Ok(Json(
        json!({"user": user, "summary": {"total_assigned_tasks": tasks.len()}, "tasks": tasks,
        "cache": {"hit": false, "ttl_seconds": CACHE_TTL.as_secs()}}),
    ))
}
#[derive(Deserialize)]
struct CreateTask {
    title: String,
    #[serde(default)]
    description: String,
    priority: String,
    #[serde(default)]
    due_date: String,
}
async fn create_task(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateTask>,
) -> ApiResult {
    let user = authenticated(&s, &headers)?;
    if user.role != "admin" {
        log_event(
            "tasks.create.denied",
            json!({"email": user.email, "role": user.role, "status": 403, "success": false}),
        );
        return Err(err(
            StatusCode::FORBIDDEN,
            "The task creation rights are reserved for admins",
        ));
    }
    if body.title.trim().is_empty() || !["low", "medium", "high"].contains(&body.priority.as_str())
    {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "A task title and valid priority are required.",
        ));
    }
    let db = s.db.lock().map_err(database_error)?;
    db.execute(
        "INSERT INTO tasks(title,description,priority,due_date,status,created_by_id,updated_at)
                VALUES(?,?,?,?,'todo',?,CURRENT_TIMESTAMP)",
        params![
            body.title.trim(),
            body.description,
            body.priority,
            body.due_date,
            user.id
        ],
    )
    .map_err(database_error)?;
    Ok(Json(
        json!({"id": db.last_insert_rowid(), "message": "Task created successfully."}),
    ))
}
#[derive(Deserialize)]
struct Assignment {
    task_ids: Vec<i64>,
    #[serde(alias = "assigned_to_id")]
    user_id: i64,
}
#[derive(Deserialize)]
struct StatusUpdate {
    status: String,
}
async fn update_status(
    State(s): State<Arc<AppState>>,
    Path(task_id): Path<i64>,
    headers: HeaderMap,
    Json(body): Json<StatusUpdate>,
) -> ApiResult {
    let user = authenticated(&s, &headers)?;
    let status = if body.status == "to-do" {
        "todo"
    } else {
        body.status.as_str()
    };
    if !["todo", "in-progress", "completed"].contains(&status) {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Choose To do, In progress, or Completed.",
        ));
    }
    let mut cache = s.cache.lock().map_err(database_error)?;
    let db = s.db.lock().map_err(database_error)?;
    let changed = db.execute(
        "UPDATE tasks SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (assigned_to_id=? OR ?)",
        params![status, task_id, user.id, user.role == "admin"],
    ).map_err(database_error)?;
    if changed == 0 {
        return Err(if user.role == "admin" {
            err(StatusCode::NOT_FOUND, "Task not found.")
        } else {
            err(
                StatusCode::FORBIDDEN,
                "You can only update tasks assigned to you.",
            )
        });
    }
    cache.clear();
    Ok(Json(
        json!({"task": {"id": task_id, "status": status}, "message": "Task status updated successfully."}),
    ))
}
async fn assign(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<Assignment>,
) -> ApiResult {
    admin(&s, &headers)?;
    if body.task_ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Select at least one task."));
    }
    let mut cache = s.cache.lock().map_err(database_error)?;
    let mut db = s.db.lock().map_err(database_error)?;
    let tx = db.transaction().map_err(database_error)?;
    let exists: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM users WHERE id=? AND role='staff'",
            [body.user_id],
            |row| row.get(0),
        )
        .map_err(database_error)?;
    if exists == 0 {
        return Err(err(StatusCode::BAD_REQUEST, "Select a staff member."));
    }
    for id in &body.task_ids {
        if tx.execute("UPDATE tasks SET assigned_to_id=?,assignee_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
            params![body.user_id, body.user_id, id]).map_err(database_error)? == 0
        { return Err(err(StatusCode::NOT_FOUND, "A selected task no longer exists.")); }
    }
    tx.commit().map_err(database_error)?;
    cache.clear();
    Ok(Json(
        json!({"message": "Tasks assigned successfully.", "assigned": body.task_ids.len()}),
    ))
}
async fn users(State(s): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult {
    admin(&s, &headers)?;
    let db = s.db.lock().map_err(database_error)?;
    let mut query = db
        .prepare(&format!("SELECT {USER_COLUMNS} FROM users ORDER BY id"))
        .map_err(database_error)?;
    let users = query
        .query_map([], user_row)
        .map_err(database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(database_error)?;
    Ok(Json(json!({"users": users})))
}
#[derive(Deserialize)]
struct CreateUser {
    #[serde(alias = "username", alias = "userName", alias = "full_name")]
    name: String,
    #[serde(alias = "emailId")]
    email: String,
    password: String,
}
async fn create_user(
    State(s): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CreateUser>,
) -> ApiResult {
    admin(&s, &headers)?;
    let email = body.email.trim().to_lowercase();
    validate_user(&body.name, &email, &body.password)?;
    let hash = hash_secret(&body.password)?;
    let db = s.db.lock().map_err(database_error)?;
    Ok(Json(
        json!({"user": insert_user(&db, &body.name, &email, &hash, "staff")?, "message": "User created successfully."}),
    ))
}

// Additive migration for existing workspaces; no users or tasks are deleted.
fn add_column(
    db: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<bool> {
    let exists = {
        let mut query = db.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = query
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        columns.iter().any(|value| value == column)
    };
    if !exists {
        db.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(!exists)
}
fn initialize_database(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute_batch(include_str!("../migrations/001_workspace.sql"))?;
    add_column(&tx, "users", "full_name", "TEXT NOT NULL DEFAULT ''")?;
    add_column(&tx, "users", "hashed_password", "TEXT NOT NULL DEFAULT ''")?;
    add_column(&tx, "users", "created_at", "TEXT NOT NULL DEFAULT ''")?;
    add_column(&tx, "users", "updated_at", "TEXT NOT NULL DEFAULT ''")?;
    add_column(
        &tx,
        "tasks",
        "created_by_id",
        "INTEGER REFERENCES users(id)",
    )?;
    if add_column(
        &tx,
        "tasks",
        "assigned_to_id",
        "INTEGER REFERENCES users(id)",
    )? {
        tx.execute("UPDATE tasks SET assigned_to_id=assignee_id", [])?;
    }
    add_column(&tx, "tasks", "updated_at", "TEXT NOT NULL DEFAULT ''")?;
    tx.execute_batch(
        "UPDATE users SET full_name=name WHERE full_name='';
         UPDATE users SET hashed_password=password_hash WHERE hashed_password='';
         UPDATE users SET created_at=CURRENT_TIMESTAMP WHERE created_at='';
         UPDATE users SET updated_at=created_at WHERE updated_at='';
         UPDATE tasks SET created_by_id=(SELECT MIN(id) FROM users WHERE role='admin') WHERE created_by_id IS NULL;
         UPDATE tasks SET updated_at=created_at WHERE updated_at='';
         UPDATE tasks SET status='todo' WHERE status='to-do';
        ",
    )?;
    tx.execute_batch(include_str!("../migrations/002_two_factor_auth.sql"))?;
    tx.commit()
}
fn redact_legacy_email_log() -> std::io::Result<()> {
    let path = std::path::Path::new("dev-emails.log");
    if !path.exists() {
        return Ok(());
    }
    let original = std::fs::read_to_string(path)?;
    let redacted = original
        .lines()
        .map(|line| {
            let mut fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() == 3
                && fields[2].len() == 6
                && fields[2].bytes().all(|byte| byte.is_ascii_digit())
            {
                fields[2] = "[expired-code-redacted]";
                fields.join(" ")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    if original != redacted {
        let temporary = path.with_extension("log.redacting");
        std::fs::write(&temporary, redacted)?;
        std::fs::rename(temporary, path)?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let port: u16 = std::env::var("API_PORT")
        .unwrap_or_else(|_| "3001".into())
        .parse()?;
    let address = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&address).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::AddrInUse {
            std::io::Error::new(error.kind(), format!(
                "{address} is already in use. A backend may already be running. Stop the existing instance before restarting, or choose another port with API_PORT=3002 cargo run."
            ))
        } else { error }
    })?;
    let mut db = Connection::open(std::env::var("DATABASE_PATH").unwrap_or("workspace.db".into()))?;
    db.execute_batch("PRAGMA foreign_keys=ON;")?;
    initialize_database(&mut db)?;
    redact_legacy_email_log()?;
    let development =
        std::env::var("APP_ENV").unwrap_or_else(|_| "development".into()) != "production";
    let state = Arc::new(AppState {
        db: Mutex::new(db),
        cache: Mutex::new(HashMap::new()),
        emails: Mutex::new(Vec::new()),
        secret: std::env::var("JWT_SECRET").unwrap_or_else(|_| Uuid::new_v4().to_string()),
        development,
    });
    let mut app = Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok"})) }))
        .route("/auth/login", post(login))
        .route("/auth/verify-2fa", post(verify))
        .route("/auth/verify", post(verify))
        .route("/users", get(users).post(create_user))
        .route("/tasks", get(tasks).post(create_task))
        .route("/tasks/{task_id}/status", patch(update_status))
        .route("/tasks/assign", post(assign))
        .route("/tasks/view-my-tasks", get(my_tasks));
    if development {
        app = app
            .route("/seed/users", post(seed_users))
            .route("/dev/email-logs/latest", get(latest_email))
            .route("/auth/register", post(register));
    }
    let app = app
        .layer(middleware::from_fn(log_requests))
        .with_state(state);
    println!(
        "Workspace API: http://{address} | Events: dev-events.log | Verification codes: console or /dev/email-logs/latest"
    );
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
