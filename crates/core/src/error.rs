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
}

impl AppError {
    /// True for "the requested row does not exist" — lets transports map to 404
    /// without matching on the inner `sqlx` error themselves.
    pub fn is_not_found(&self) -> bool {
        matches!(self, AppError::NotFound(_))
            || matches!(self, AppError::Database(sqlx::Error::RowNotFound))
    }

    /// True for caller/validation errors — lets transports map to 400.
    pub fn is_invalid_input(&self) -> bool {
        matches!(self, AppError::InvalidInput(_))
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
