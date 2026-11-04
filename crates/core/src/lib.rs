//! Ganban shared core.
//!
//! This crate holds the single source of truth for the data layer: the SQLite
//! schema/migrations, the domain models, and all business logic. Both the
//! desktop Tauri app (`src-tauri`) and the headless daemon (`crates/server`)
//! depend on it so the query/validation logic lives in exactly one place.
//!
//! The crate is deliberately free of any Tauri or HTTP concerns. It does not
//! know whether a request originated from a local `invoke` call or an HTTP
//! request — callers adapt `core::Result` to their own transport.

pub mod auth;
pub mod db;
pub mod domain_events;
pub mod error;
pub mod finance;
pub mod ics;
pub mod models;
pub mod ops;
pub mod assignments;
pub mod oracle;
pub mod quiz;
pub mod proposals;
pub mod protocols;
pub mod storage;
pub mod sync;
pub mod visibility;
pub mod workflows;

pub use db::{init_db, init_db_role, Db, Role};
pub use error::{AppError, Result};
