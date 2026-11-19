//! Write transactions under load. The pool hands out several connections to one WAL
//! database, so a transaction that reads and then writes can find that another
//! connection committed in between. A deferred one (`db.begin()`) then fails at once
//! with SQLITE_BUSY_SNAPSHOT, and the busy timeout doesn't help. `begin_write` takes the
//! write lock at its start, so it waits its turn instead.

use ganban_core::{db::begin_write, init_db, Db};
use std::path::PathBuf;
use std::time::Duration;

fn temp_db(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("ganban_contention_{tag}_{}.db", std::process::id()));
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", p.display()));
    }
    p
}

/// Reads the counter, pauses so another writer can commit, then writes it back plus one.
async fn bump(db: &Db) -> ganban_core::error::Result<()> {
    let mut tx = begin_write(db).await?;
    let n: i64 = sqlx::query_scalar("SELECT n FROM counter WHERE id = 1").fetch_one(&mut *tx).await?;
    tokio::time::sleep(Duration::from_millis(1)).await;
    sqlx::query("UPDATE counter SET n = ? WHERE id = 1").bind(n + 1).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_read_then_write_transactions_all_succeed() {
    let path = temp_db("rw");
    let db = init_db(&path).await.unwrap();
    sqlx::query("CREATE TABLE counter (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)").execute(&db).await.unwrap();
    sqlx::query("INSERT INTO counter (id, n) VALUES (1, 0)").execute(&db).await.unwrap();

    const TASKS: i64 = 16;
    const ROUNDS: i64 = 10;
    let mut handles = Vec::new();
    for _ in 0..TASKS {
        let db = db.clone();
        handles.push(tokio::spawn(async move {
            for _ in 0..ROUNDS {
                bump(&db).await?;
            }
            Ok::<_, ganban_core::error::AppError>(())
        }));
    }
    let mut failures = Vec::new();
    for h in handles {
        if let Err(e) = h.await.unwrap() {
            failures.push(e.to_string());
        }
    }
    assert!(failures.is_empty(), "{} writers failed, first: {}", failures.len(), failures[0]);

    // No write was lost either: each read saw the previous commit.
    let n: i64 = sqlx::query_scalar("SELECT n FROM counter WHERE id = 1").fetch_one(&db).await.unwrap();
    assert_eq!(n, TASKS * ROUNDS);

    db.close().await;
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
    }
}
