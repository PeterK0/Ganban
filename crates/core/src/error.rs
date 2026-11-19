use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Forbidden: {0}")]
    Forbidden(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    /// A caller error the client acts on, not just shows: `code` is stable and
    /// machine-readable (sent as `code` next to `error`), so the client never
    /// matches the English message. Maps to 400 like `InvalidInput`.
    #[error("Invalid input: {message}")]
    Refused { code: &'static str, message: String },

    /// The row changed since the caller read it, so its write was refused. `current`
    /// is the row as it is now, sent next to `error` and `code`, so the client can
    /// merge or ask without another read. Maps to 409.
    #[error("Conflict: {message}")]
    Conflict { code: &'static str, message: String, current: Box<serde_json::Value> },
}

/// `AppError::Refused` codes.
pub mod codes {
    /// Including a file in the AI overview needs `force`: it's over the size guard.
    pub const AI_FILE_TOO_LARGE: &str = "AI_FILE_TOO_LARGE";
    /// A task save carried the `updated_at` it was based on, and the task has
    /// changed since. The conflict carries the task as it is now.
    pub const TASK_CHANGED: &str = "TASK_CHANGED";
}

impl AppError {
    /// True for "the requested row does not exist" — lets transports map to 404
    /// without matching on the inner `sqlx` error themselves.
    pub fn is_not_found(&self) -> bool {
        matches!(self, AppError::NotFound(_)) || matches!(self, AppError::Database(sqlx::Error::RowNotFound))
    }

    /// True for caller/validation errors — lets transports map to 400.
    pub fn is_invalid_input(&self) -> bool {
        matches!(self, AppError::InvalidInput(_) | AppError::Refused { .. })
    }

    /// The machine-readable code of a refusal, if it has one.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            AppError::Refused { code, .. } | AppError::Conflict { code, .. } => Some(code),
            _ => None,
        }
    }

    /// The write was refused because the row changed underneath it — maps to 409.
    pub fn is_conflict(&self) -> bool {
        matches!(self, AppError::Conflict { .. })
    }

    /// What a conflict carries for the client: the row as it is now.
    pub fn current(&self) -> Option<&serde_json::Value> {
        match self {
            AppError::Conflict { current, .. } => Some(current),
            _ => None,
        }
    }

    /// Missing/invalid credentials — maps to 401.
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, AppError::Unauthorized(_))
    }

    /// Authenticated but not allowed — maps to 403.
    pub fn is_forbidden(&self) -> bool {
        matches!(self, AppError::Forbidden(_))
    }
}

// Convenience conversion for transports (e.g. Tauri commands) that surface
// errors as plain strings.
impl From<AppError> for String {
    fn from(error: AppError) -> Self {
        error.to_string()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
