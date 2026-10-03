//! Session cookies live in the OS credential store, never in settings or logs.
//! A single worker serializes writes and deletes, including through sign-out.
use keyring_core::api::CredentialStoreApi;
use std::sync::mpsc;
use tokio::sync::oneshot;

const SERVICE: &str = "xyz.streamarena.music.desktop";
enum Job {
    Read(oneshot::Sender<Result<Option<String>, String>>),
    Write(String, oneshot::Sender<Result<(), String>>),
    Delete(oneshot::Sender<Result<(), String>>),
}
#[derive(Clone)]
pub struct SessionStore {
    sender: mpsc::Sender<Job>,
}
impl SessionStore {
    pub fn new(origin: String) -> Self {
        let (sender, receiver) = mpsc::channel();
        std::thread::Builder::new().name("music-session-store".into()).spawn(move || {
            #[cfg(target_os = "macos")]
            let store = apple_native_keyring_store::keychain::Store::new();
            #[cfg(target_os = "linux")]
            let store = zbus_secret_service_keyring_store::Store::new();
            #[cfg(windows)]
            let store = windows_native_keyring_store::Store::new();
            while let Ok(job) = receiver.recv() {
                let entry = store.as_ref().map_err(|_| "The system credential store is unavailable.".to_string())
                    .and_then(|store| store.build(SERVICE, &origin, None).map_err(|_| "The system credential store is locked or unavailable.".to_string()));
                match job {
                    Job::Read(reply) => { let _ = reply.send(entry.and_then(|entry| match entry.get_secret() {
                        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "Stored session is invalid. Please sign in again.".into()),
                        Err(keyring_core::Error::NoEntry) => Ok(None),
                        Err(_) => Err("Could not restore your session from the system credential store.".into()),
                    })); }
                    Job::Write(cookie, reply) => { let _ = reply.send(entry.and_then(|entry| entry.set_secret(cookie.as_bytes())
                        .map_err(|_| "Signed in for this session. The system credential store could not save it.".into()))); }
                    Job::Delete(reply) => { let _ = reply.send(entry.and_then(|entry| match entry.delete_credential() {
                        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
                        Err(_) => Err("The saved credential could not be removed; automatic sign-in is disabled.".into()),
                    })); }
                }
            }
        }).expect("session-store thread");
        Self { sender }
    }
    pub async fn read(&self) -> Result<Option<String>, String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Job::Read(sender))
            .map_err(|_| "Session store stopped".to_string())?;
        receiver
            .await
            .map_err(|_| "Session store stopped".to_string())?
    }
    pub async fn write(&self, cookie: String) -> Result<(), String> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send(Job::Write(cookie, sender))
            .map_err(|_| "Session store stopped".to_string())?;
        receiver
            .await
            .map_err(|_| "Session store stopped".to_string())?
    }
    pub fn request_delete(&self) -> oneshot::Receiver<Result<(), String>> {
        let (sender, receiver) = oneshot::channel();
        let _ = self.sender.send(Job::Delete(sender));
        receiver
    }
}
