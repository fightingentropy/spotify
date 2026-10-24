//! Types shared by the music API and the interface: errors, play requests,
//! and the data models.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use thiserror::Error;

pub mod models;

#[derive(Clone, Debug, Error)]
pub enum ApiError {
    #[error("not signed in")]
    NotSignedIn,
    #[error("{message}")]
    Status { status: u16, message: String },
    #[error("network error: {0}")]
    Network(String),
    #[error("unexpected response from Spotify: {0}")]
    Decode(String),
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_decode() {
            Self::Decode(error.to_string())
        } else {
            Self::Network(error.to_string())
        }
    }
}

pub type Result<T> = std::result::Result<T, ApiError>;

/// What to start playing.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PlayRequest {
    pub context_uri: Option<String>,
    pub uris: Vec<String>,
    pub offset_uri: Option<String>,
    pub offset_position: Option<u32>,
    pub position_ms: u32,
}

impl PlayRequest {
    pub fn context(uri: impl Into<String>) -> Self {
        Self {
            context_uri: Some(uri.into()),
            ..Self::default()
        }
    }

    pub fn tracks(uris: Vec<String>) -> Self {
        Self {
            uris,
            ..Self::default()
        }
    }

    pub fn starting_at_uri(mut self, uri: impl Into<String>) -> Self {
        self.offset_uri = Some(uri.into());
        self
    }

    pub fn starting_at_index(mut self, index: u32) -> Self {
        self.offset_position = Some(index);
        self
    }
}

/// Live view of the client's traffic, shared with the interface so it can
/// show that the app is talking to the server rather than being slow itself.
pub struct NetActivity {
    started_at: Instant,
    in_flight: AtomicUsize,
    /// Milliseconds since `started_at` when the oldest current burst began.
    busy_since_ms: AtomicU64,
}

impl Default for NetActivity {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
            in_flight: AtomicUsize::new(0),
            busy_since_ms: AtomicU64::new(0),
        }
    }
}

impl NetActivity {
    fn now_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// Requests have been in flight continuously for at least `for_at_least`.
    pub fn busy(&self, for_at_least: Duration) -> bool {
        self.in_flight.load(Ordering::SeqCst) > 0
            && self
                .now_ms()
                .saturating_sub(self.busy_since_ms.load(Ordering::SeqCst))
                >= for_at_least.as_millis() as u64
    }
}
