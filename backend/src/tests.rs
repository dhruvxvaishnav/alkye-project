use super::*;

const PASSWORD: &str = "Workspace123!";

fn state(development: bool) -> Arc<AppState> {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    initialize_database(&mut db).unwrap();
    Arc::new(AppState {
        db: Mutex::new(db),
        cache: Mutex::new(HashMap::new()),
        emails: Mutex::new(Vec::new()),
        secret: "backend-tests-only-signing-secret".into(),
        development,
    })
}
fn ok(result: ApiResult) -> Value {
    result.expect("API should succeed").0
}
fn status(result: ApiResult, expected: StatusCode) -> Value {
    let (actual, Json(body)) = result.expect_err("API should reject this request");
    assert_eq!(actual, expected, "{body}");
    body
}
fn bearer(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers
}
fn signed_headers(s: &AppState, user_id: i64) -> HeaderMap {
    let token = encode(
        &Header::default(),
        &Claims {
            sub: user_id,
            exp: now() + 3600,
        },
        &EncodingKey::from_secret(s.secret.as_bytes()),
    )
    .unwrap();
    bearer(&token)
}
async fn seeded() -> (Arc<AppState>, HeaderMap, HeaderMap, i64) {
    let s = state(true);
    let users = ok(seed_users(State(s.clone())).await);
    let admin_id = users["users"][0]["id"].as_i64().unwrap();
    let bond_id = users["users"][1]["id"].as_i64().unwrap();
    let admin = signed_headers(&s, admin_id);
    let bond = signed_headers(&s, bond_id);
    (s, admin, bond, bond_id)
}
async fn challenge(s: &Arc<AppState>, email: &str) -> (String, String) {
    let response = ok(login(
        State(s.clone()),
        Json(Login {
            email: email.into(),
            password: PASSWORD.into(),
        }),
    )
    .await);
    assert!(response.get("token").is_none());
    assert!(response.get("access_token").is_none());
    assert_eq!(response["expires_in"], 300);
    let id = response["login_challenge_id"].as_str().unwrap().to_owned();
    let delivery = ok(latest_email(
        State(s.clone()),
        Query(EmailQuery {
            email: Some(email.into()),
            login_challenge_id: Some(id.clone()),
        }),
    )
    .await);
    assert_eq!(delivery["login_challenge_id"], id);
    (id, delivery["code"].as_str().unwrap().into())
}
async fn verified(s: &Arc<AppState>, email: &str) -> HeaderMap {
    let (id, code) = challenge(s, email).await;
    let response = ok(verify(
        State(s.clone()),
        Json(Verification {
            login_challenge_id: id,
            code,
        }),
    )
    .await);
    assert_eq!(response["token"], response["access_token"]);
    bearer(response["access_token"].as_str().unwrap())
}
async fn task(s: &Arc<AppState>, headers: &HeaderMap, title: &str, priority: &str) -> i64 {
    ok(create_task(
        State(s.clone()),
        headers.clone(),
        Json(CreateTask {
            title: title.into(),
            description: "Integration test task".into(),
            priority: priority.into(),
            due_date: String::new(),
        }),
    )
    .await)["id"]
        .as_i64()
        .unwrap()
}

#[tokio::test]
async fn validation_flow_has_five_tasks_three_assignments_and_real_cache_hit() {
    let (s, _, _, bond_id) = seeded().await;
    let admin = verified(&s, "admin@example.com").await;
    let mut ids = Vec::new();
    for (index, priority) in ["high", "medium", "low", "high", "medium"]
        .iter()
        .enumerate()
    {
        ids.push(task(&s, &admin, &format!("Validation task {index}"), priority).await);
    }
    ok(assign(
        State(s.clone()),
        admin.clone(),
        Json(Assignment {
            task_ids: ids[..3].to_vec(),
            user_id: bond_id,
        }),
    )
    .await);
    let bond = verified(&s, "jamesbond@example.com").await;
    let denied = status(
        create_task(
            State(s.clone()),
            bond.clone(),
            Json(CreateTask {
                title: "Forbidden task".into(),
                description: String::new(),
                priority: "high".into(),
                due_date: String::new(),
            }),
        )
        .await,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        denied["message"],
        "The task creation rights are reserved for admins"
    );
    let first = ok(my_tasks(State(s.clone()), bond.clone()).await);
    assert_eq!(first["user"]["email"], "jamesbond@example.com");
    assert_eq!(first["user"]["role"], "staff");
    assert_eq!(first["summary"]["total_assigned_tasks"], 3);
    assert_eq!(first["cache"]["hit"], false);
    let rows = first["tasks"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!(row["status"], "todo");
        assert_eq!(row["assigned_to"], "jamesbond@example.com");
        assert_eq!(row["assigned_to_id"], bond_id);
        assert!(ids[..3].contains(&row["id"].as_i64().unwrap()));
    }
    let second = ok(my_tasks(State(s.clone()), bond).await);
    assert_eq!(second["cache"]["hit"], true);
    assert_eq!(first["tasks"], second["tasks"]);
    assert_eq!(
        ok(tasks(State(s), admin).await)["tasks"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[tokio::test]
async fn otp_is_hashed_persisted_single_use_and_does_not_accept_wrong_code() {
    let (s, _, _, _) = seeded().await;
    let (id, code) = challenge(&s, "admin@example.com").await;
    {
        let db = s.db.lock().unwrap();
        let hash: String = db
            .query_row(
                "SELECT code_hash FROM login_challenges WHERE id=?",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        let email_hash: String = db
            .query_row(
                "SELECT code_hash FROM email_logs WHERE challenge_id=?",
                [&id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(hash, code);
        assert!(hash.starts_with("$argon2"));
        assert!(matches_secret(&code, &hash));
        assert_eq!(hash, email_hash);
    }
    status(
        verify(
            State(s.clone()),
            Json(Verification {
                login_challenge_id: id.clone(),
                code: "invalid".into(),
            }),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    );
    let success = ok(verify(
        State(s.clone()),
        Json(Verification {
            login_challenge_id: id.clone(),
            code: code.clone(),
        }),
    )
    .await);
    assert!(success["access_token"].as_str().unwrap().split('.').count() == 3);
    status(
        verify(
            State(s.clone()),
            Json(Verification {
                login_challenge_id: id.clone(),
                code,
            }),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    );
    let used_at: Option<u64> =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT used_at FROM login_challenges WHERE id=?",
                [id],
                |r| r.get(0),
            )
            .unwrap();
    assert!(used_at.is_some());
}

#[tokio::test]
async fn expired_codes_and_five_failed_attempts_cannot_issue_jwt() {
    let (s, _, _, _) = seeded().await;
    let (id, code) = challenge(&s, "admin@example.com").await;
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE login_challenges SET expires_at=? WHERE id=?",
            params![now() - 1, id],
        )
        .unwrap();
    status(
        verify(
            State(s.clone()),
            Json(Verification {
                login_challenge_id: id,
                code,
            }),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    );
    let (id, code) = challenge(&s, "admin@example.com").await;
    for _ in 0..5 {
        status(
            verify(
                State(s.clone()),
                Json(Verification {
                    login_challenge_id: id.clone(),
                    code: "invalid".into(),
                }),
            )
            .await,
            StatusCode::UNAUTHORIZED,
        );
    }
    status(
        verify(
            State(s),
            Json(Verification {
                login_challenge_id: id,
                code,
            }),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    );
}

#[tokio::test]
async fn invalid_credentials_and_missing_or_expired_bearer_tokens_are_rejected() {
    let (s, admin, _, _) = seeded().await;
    status(
        login(
            State(s.clone()),
            Json(Login {
                email: "admin@example.com".into(),
                password: "wrong".into(),
            }),
        )
        .await,
        StatusCode::UNAUTHORIZED,
    );
    assert_eq!(s.emails.lock().unwrap().len(), 0);
    status(
        my_tasks(State(s.clone()), HeaderMap::new()).await,
        StatusCode::UNAUTHORIZED,
    );
    status(
        my_tasks(State(s.clone()), bearer("invalid-token")).await,
        StatusCode::UNAUTHORIZED,
    );
    let user = authenticated(&s, &admin).unwrap();
    let expired = encode(
        &Header::default(),
        &Claims {
            sub: user.id,
            exp: now() - 120,
        },
        &EncodingKey::from_secret(s.secret.as_bytes()),
    )
    .unwrap();
    status(
        my_tasks(State(s), bearer(&expired)).await,
        StatusCode::UNAUTHORIZED,
    );
}

#[tokio::test]
async fn status_updates_are_owner_scoped_visible_to_admin_and_invalidate_cache() {
    let (s, admin, bond, bond_id) = seeded().await;
    let owned = task(&s, &admin, "Owned task", "high").await;
    let unassigned = task(&s, &admin, "Unassigned task", "low").await;
    ok(assign(
        State(s.clone()),
        admin.clone(),
        Json(Assignment {
            task_ids: vec![owned],
            user_id: bond_id,
        }),
    )
    .await);
    ok(my_tasks(State(s.clone()), bond.clone()).await);
    for new_status in ["in-progress", "completed"] {
        ok(update_status(
            State(s.clone()),
            Path(owned),
            bond.clone(),
            Json(StatusUpdate {
                status: new_status.into(),
            }),
        )
        .await);
        let personal = ok(my_tasks(State(s.clone()), bond.clone()).await);
        assert_eq!(personal["cache"]["hit"], false);
        assert_eq!(personal["tasks"][0]["status"], new_status);
        let all = ok(tasks(State(s.clone()), admin.clone()).await);
        assert_eq!(
            all["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == owned)
                .unwrap()["status"],
            new_status
        );
    }
    status(
        update_status(
            State(s.clone()),
            Path(unassigned),
            bond.clone(),
            Json(StatusUpdate {
                status: "completed".into(),
            }),
        )
        .await,
        StatusCode::FORBIDDEN,
    );
    status(
        update_status(
            State(s.clone()),
            Path(owned),
            bond,
            Json(StatusUpdate {
                status: "invalid".into(),
            }),
        )
        .await,
        StatusCode::BAD_REQUEST,
    );
    assert_eq!(
        read_tasks(&s, None)
            .unwrap()
            .iter()
            .find(|t| t.id == unassigned)
            .unwrap()
            .status,
        "todo"
    );
}

#[tokio::test]
async fn assignment_is_atomic_and_staff_cannot_assign_or_list_all_tasks() {
    let (s, admin, bond, bond_id) = seeded().await;
    let id = task(&s, &admin, "Assignment task", "medium").await;
    status(
        assign(
            State(s.clone()),
            admin,
            Json(Assignment {
                task_ids: vec![id, 999999],
                user_id: bond_id,
            }),
        )
        .await,
        StatusCode::NOT_FOUND,
    );
    assert_eq!(read_tasks(&s, None).unwrap()[0].assigned_to_id, None);
    status(
        assign(
            State(s.clone()),
            bond.clone(),
            Json(Assignment {
                task_ids: vec![id],
                user_id: bond_id,
            }),
        )
        .await,
        StatusCode::FORBIDDEN,
    );
    status(
        tasks(State(s.clone()), bond.clone()).await,
        StatusCode::FORBIDDEN,
    );
    status(
        users(State(s.clone()), bond.clone()).await,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        ok(my_tasks(State(s), bond).await)["summary"]["total_assigned_tasks"],
        0
    );
}

#[tokio::test]
async fn cache_expiry_forces_a_database_read_without_waiting() {
    let (s, admin, bond, bond_id) = seeded().await;
    let id = task(&s, &admin, "Cache expiry task", "medium").await;
    ok(assign(
        State(s.clone()),
        admin,
        Json(Assignment {
            task_ids: vec![id],
            user_id: bond_id,
        }),
    )
    .await);
    ok(my_tasks(State(s.clone()), bond.clone()).await);
    assert_eq!(
        ok(my_tasks(State(s.clone()), bond.clone()).await)["cache"]["hit"],
        true
    );
    s.cache
        .lock()
        .unwrap()
        .get_mut(&bond_id)
        .unwrap()
        .expires_at = Instant::now() - Duration::from_secs(1);
    s.db.lock()
        .unwrap()
        .execute(
            "UPDATE tasks SET title='Updated in database' WHERE id=?",
            [id],
        )
        .unwrap();
    let refreshed = ok(my_tasks(State(s), bond).await);
    assert_eq!(refreshed["cache"]["hit"], false);
    assert_eq!(refreshed["tasks"][0]["title"], "Updated in database");
}

#[tokio::test]
async fn admin_created_users_persist_with_hashed_passwords_and_can_login() {
    let (s, admin, bond, _) = seeded().await;
    let body = || CreateUser {
        name: "New Staff".into(),
        email: "NEW@example.com".into(),
        password: "NewPassword123!".into(),
    };
    status(
        create_user(State(s.clone()), bond, Json(body())).await,
        StatusCode::FORBIDDEN,
    );
    let created = ok(create_user(State(s.clone()), admin.clone(), Json(body())).await);
    assert_eq!(created["user"]["email"], "new@example.com");
    assert_eq!(created["user"]["role"], "staff");
    assert!(created["user"].get("hashed_password").is_none());
    let hash: String =
        s.db.lock()
            .unwrap()
            .query_row(
                "SELECT hashed_password FROM users WHERE email='new@example.com'",
                [],
                |r| r.get(0),
            )
            .unwrap();
    assert!(matches_secret("NewPassword123!", &hash));
    assert_ne!(hash, "NewPassword123!");
    ok(login(
        State(s.clone()),
        Json(Login {
            email: "new@example.com".into(),
            password: "NewPassword123!".into(),
        }),
    )
    .await);
    status(
        create_user(State(s.clone()), admin, Json(body())).await,
        StatusCode::CONFLICT,
    );
}

#[tokio::test]
async fn seeding_is_idempotent_and_development_endpoints_are_disabled_in_production() {
    let s = state(true);
    let first = ok(seed_users(State(s.clone())).await);
    let second = ok(seed_users(State(s.clone())).await);
    assert_eq!(first["users"], second["users"]);
    assert_eq!(
        s.db.lock()
            .unwrap()
            .query_row("SELECT count(*) FROM users", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert!(read_tasks(&s, None).unwrap().is_empty());
    let production = state(false);
    status(
        seed_users(State(production.clone())).await,
        StatusCode::NOT_FOUND,
    );
    status(
        latest_email(State(production), Query(EmailQuery::default())).await,
        StatusCode::NOT_FOUND,
    );
}

#[test]
fn migration_preserves_legacy_users_tasks_passwords_and_assignments() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,role TEXT);
        CREATE TABLE tasks(id INTEGER PRIMARY KEY,title TEXT,description TEXT,priority TEXT,status TEXT,due_date TEXT,assignee_id INTEGER,created_at TEXT);
        INSERT INTO users VALUES(1,'Admin','admin@workspace.local','existing-password-hash','admin');
        INSERT INTO users VALUES(2,'James Bond','james@workspace.local','staff-password-hash','staff');
        INSERT INTO tasks VALUES(5,'Keep this task','Original description','high','to-do','',2,'2026-01-01 12:00:00');").unwrap();
    initialize_database(&mut db).unwrap();
    initialize_database(&mut db).unwrap();
    let user = db
        .query_row(
            "SELECT full_name,hashed_password FROM users WHERE id=2",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap();
    assert_eq!(user, ("James Bond".into(), "staff-password-hash".into()));
    let task = db
        .query_row(
            "SELECT title,status,created_by_id,assigned_to_id,created_at FROM tasks WHERE id=5",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        task,
        (
            "Keep this task".into(),
            "todo".into(),
            1,
            2,
            "2026-01-01 12:00:00".into()
        )
    );
}
