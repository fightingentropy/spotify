//! Background work for the Downloads page, isolated from playback and drawing.
pub mod assets;
use crate::backend::{Event, Waker};
use crate::music_api::{
    MusicApi,
    downloads::{
        CatalogKind, CatalogPage, DownloadCollection, DownloadQuality, DownloadSource,
        DownloadSourceCheck, DownloadTrack, TrackAvailability,
    },
};
use crate::music_downloads::tools::{ToolsProgress, ToolsRequest, ToolsResult};
use crate::music_downloads::{
    Cancellation, DownloadJob, ExportReceipt, JobReceipt, QueueState, TrackMetadata,
    TransferProgress,
};
use crate::music_downloads::{ExportOptions, ProviderOptions};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc::Sender,
};
use tokio::sync::Mutex;
use tokio::task::{AbortHandle, Id, JoinSet};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Scope {
    pub account_id: String,
    pub generation: u64,
}

pub enum Request {
    Search {
        scope: Scope,
        request: u64,
        query: String,
        kind: CatalogKind,
        offset: u32,
    },
    Availability {
        scope: Scope,
        request: u64,
        track: DownloadTrack,
        source: DownloadSource,
        quality: DownloadQuality,
        providers: ProviderOptions,
    },
    Assets {
        scope: Scope,
        request: u64,
        assets: assets::AssetRequest,
    },
    PickToolsFiles {
        scope: Scope,
        selected: Pin<Box<dyn Future<Output = Option<Vec<rfd::FileHandle>>> + Send>>,
    },
    PickToolsOutput {
        scope: Scope,
        selected: Pin<Box<dyn Future<Output = Option<rfd::FileHandle>> + Send>>,
    },
    Tools {
        scope: Scope,
        request: u64,
        operation: ToolsRequest,
    },
    CancelAlbumGain {
        scope: Scope,
        batch: u64,
    },
    CancelTools {
        scope: Scope,
        request: u64,
    },
    ExportPreferences {
        scope: Scope,
        selected: Pin<Box<dyn Future<Output = Option<rfd::FileHandle>> + Send>>,
        options: ExportOptions,
    },
    ImportPreferences {
        scope: Scope,
        selected: Pin<Box<dyn Future<Output = Option<rfd::FileHandle>> + Send>>,
    },
    CheckSources {
        scope: Scope,
        providers: ProviderOptions,
    },
    AlbumGain {
        scope: Scope,
        batch: u64,
        ids: Vec<u64>,
        paths: Vec<PathBuf>,
    },
    Load {
        scope: Scope,
    },
    Recover {
        scope: Scope,
    },
    Playlist {
        scope: Scope,
        batch: u64,
        directory: PathBuf,
        title: String,
        tracks: Vec<(TrackMetadata, ExportReceipt)>,
    },
    Save {
        scope: Scope,
        queue: QueueState,
    },
    Resolve {
        scope: Scope,
        request: u64,
        input: String,
        maximum_artwork: bool,
    },
    Run {
        scope: Scope,
        job: DownloadJob,
    },
    Cancel {
        scope: Scope,
        id: u64,
    },
    ChooseFolder {
        scope: Scope,
        selected: Pin<Box<dyn Future<Output = Option<rfd::FileHandle>> + Send>>,
    },
}

pub struct Response {
    pub scope: Scope,
    pub kind: ResponseKind,
}

pub enum ResponseKind {
    Searched {
        request: u64,
        result: Result<CatalogPage, String>,
    },
    Availability {
        request: u64,
        track: DownloadTrack,
        result: Result<TrackAvailability, String>,
    },
    ToolsFiles(Vec<PathBuf>),
    ToolsOutput(Option<PathBuf>),
    ToolsProgress {
        request: u64,
        progress: ToolsProgress,
    },
    ToolsFinished {
        request: u64,
        result: ToolsResult,
    },
    ToolsFailed {
        request: u64,
        error: String,
    },
    PreferencesImported(Result<Option<ExportOptions>, String>),
    PreferencesExported(Result<Option<PathBuf>, String>),
    SourcesChecked(Result<Vec<DownloadSourceCheck>, String>),
    AlbumGain {
        batch: u64,
        ids: Vec<u64>,
        result: Result<(), String>,
    },
    Loaded(Result<QueueState, String>),
    Playlist {
        batch: u64,
        result: Result<PathBuf, String>,
    },
    Resolved {
        request: u64,
        result: Result<DownloadCollection, String>,
    },
    Progress {
        id: u64,
        progress: TransferProgress,
    },
    Finished {
        id: u64,
        receipt: JobReceipt,
    },
    Failed {
        id: u64,
        error: String,
    },
    FolderChosen(Option<PathBuf>),
    SaveFailed(String),
}

#[derive(Clone)]
enum Pending {
    Other,
    Search(Scope, u64),
    Availability(Scope, u64, DownloadTrack),
    Tools(Scope, u64),
    AlbumGain(Scope, u64, Vec<u64>),
    Resolve(Scope, u64),
    Job(Scope, u64),
}

pub struct DownloadTasks {
    tasks: JoinSet<()>,
    pending: HashMap<Id, Pending>,
    active: HashMap<(Scope, u64), (AbortHandle, Cancellation)>,
    tools_active: HashMap<(Scope, u64), (AbortHandle, Cancellation)>,
    album_active: HashMap<(Scope, u64), Cancellation>,
    state_dir: PathBuf,
    events: Sender<Event>,
    waker: Waker,
    save_lock: Arc<Mutex<()>>,
    save_revision: Arc<AtomicU64>,
}

fn emit(events: &Sender<Event>, waker: &Waker, scope: Scope, kind: ResponseKind) {
    let _ = events.send(Event::Downloads(Box::new(Response { scope, kind })));
    waker.wake();
}

impl DownloadTasks {
    pub fn new(state_dir: PathBuf, events: Sender<Event>, waker: Waker) -> Self {
        Self {
            tasks: JoinSet::new(),
            pending: HashMap::new(),
            active: HashMap::new(),
            tools_active: HashMap::new(),
            album_active: HashMap::new(),
            state_dir,
            events,
            waker,
            save_lock: Arc::new(Mutex::new(())),
            save_revision: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn has_tasks(&self) -> bool {
        !self.tasks.is_empty()
    }

    fn spawn(
        &mut self,
        pending: Pending,
        future: impl Future<Output = ()> + Send + 'static,
    ) -> AbortHandle {
        let handle = self.tasks.spawn(future);
        self.pending.insert(handle.id(), pending);
        handle
    }

    pub async fn complete_one(&mut self) {
        let Some(result) = self.tasks.join_next_with_id().await else {
            return;
        };
        let (task_id, failed) = match result {
            Ok((id, ())) => (id, false),
            Err(error) => (error.id(), !error.is_cancelled()),
        };
        match self.pending.remove(&task_id) {
            Some(Pending::Tools(scope, request)) => {
                self.tools_active.remove(&(scope.clone(), request));
                if failed {
                    emit(
                        &self.events,
                        &self.waker,
                        scope,
                        ResponseKind::ToolsFailed {
                            request,
                            error:
                                "Audio tools stopped unexpectedly. Original files were preserved."
                                    .into(),
                        },
                    );
                }
            }
            Some(Pending::AlbumGain(scope, batch, ids)) => {
                self.album_active.remove(&(scope.clone(), batch));
                if failed {
                    emit(
                        &self.events,
                        &self.waker,
                        scope,
                        ResponseKind::AlbumGain {
                            batch,
                            ids,
                            result: Err("Album loudness processing stopped unexpectedly.".into()),
                        },
                    );
                }
            }
            Some(Pending::Job(scope, id)) => {
                let key = (scope.clone(), id);
                if self
                    .active
                    .get(&key)
                    .is_some_and(|(handle, _)| handle.id() == task_id)
                {
                    self.active.remove(&key);
                }
                if failed {
                    emit(
                        &self.events,
                        &self.waker,
                        scope,
                        ResponseKind::Failed {
                            id,
                            error: "This download stopped unexpectedly. Retry to continue.".into(),
                        },
                    );
                }
            }
            Some(Pending::Resolve(scope, request)) if failed => emit(
                &self.events,
                &self.waker,
                scope,
                ResponseKind::Resolved {
                    request,
                    result: Err("The lookup stopped unexpectedly. Try again.".into()),
                },
            ),
            Some(Pending::Search(scope, request)) if failed => emit(
                &self.events,
                &self.waker,
                scope,
                ResponseKind::Searched {
                    request,
                    result: Err("Catalog search stopped unexpectedly. Try again.".into()),
                },
            ),
            Some(Pending::Availability(scope, request, track)) if failed => emit(
                &self.events,
                &self.waker,
                scope,
                ResponseKind::Availability {
                    request,
                    track,
                    result: Err("Provider check stopped unexpectedly. Try again.".into()),
                },
            ),
            _ => {}
        }
    }

    pub fn cancel_all(&mut self) {
        for (_, token) in self.active.values() {
            token.cancel();
        }
        for (_, token) in self.tools_active.values() {
            token.cancel();
        }
        for token in self.album_active.values() {
            token.cancel();
        }
        self.tools_active.clear();
        self.album_active.clear();
        self.tasks.abort_all();
        self.active.clear();
        self.pending.clear();
    }

    pub fn handle(&mut self, request: Request, api: &MusicApi, account: &str) {
        let scope = match &request {
            Request::Search { scope, .. }
            | Request::Availability { scope, .. }
            | Request::Assets { scope, .. }
            | Request::PickToolsFiles { scope, .. }
            | Request::PickToolsOutput { scope, .. }
            | Request::Tools { scope, .. }
            | Request::CancelAlbumGain { scope, .. }
            | Request::CancelTools { scope, .. }
            | Request::ExportPreferences { scope, .. }
            | Request::ImportPreferences { scope, .. }
            | Request::CheckSources { scope, .. }
            | Request::AlbumGain { scope, .. }
            | Request::Load { scope }
            | Request::Recover { scope }
            | Request::Playlist { scope, .. }
            | Request::Save { scope, .. }
            | Request::Resolve { scope, .. }
            | Request::Run { scope, .. }
            | Request::Cancel { scope, .. }
            | Request::ChooseFolder { scope, .. } => scope,
        };
        if scope.account_id.is_empty() || scope.account_id != account {
            return;
        }
        let events = self.events.clone();
        let waker = self.waker.clone();
        match request {
            Request::Search {
                scope,
                request,
                query,
                kind,
                offset,
            } => {
                let api = api.clone();
                self.spawn(Pending::Search(scope.clone(), request), async move {
                    let result = api.search_download_catalog(&query, kind, offset).await;
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::Searched { request, result },
                    );
                });
            }
            Request::Availability {
                scope,
                request,
                track,
                source,
                quality,
                providers,
            } => {
                let api = api.clone();
                self.spawn(
                    Pending::Availability(scope.clone(), request, track.clone()),
                    async move {
                        let result = api
                            .download_availability(&track, source, quality, &providers)
                            .await;
                        emit(
                            &events,
                            &waker,
                            scope,
                            ResponseKind::Availability {
                                request,
                                track,
                                result,
                            },
                        );
                    },
                );
            }
            Request::Assets {
                scope,
                request,
                assets,
            } => {
                let key = (scope.clone(), request);
                if self.tools_active.contains_key(&key) {
                    return;
                }
                let token = Cancellation::default();
                let active_token = token.clone();
                let api = api.clone();
                let handle = self.spawn(Pending::Tools(scope.clone(), request), async move {
                    let progress_events = events.clone();
                    let progress_waker = waker.clone();
                    let progress_scope = scope.clone();
                    let progress = Arc::new(move |progress| {
                        emit(
                            &progress_events,
                            &progress_waker,
                            progress_scope.clone(),
                            ResponseKind::ToolsProgress { request, progress },
                        )
                    });
                    let result = assets::execute(assets, api, token, progress).await;
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::ToolsFinished { request, result },
                    );
                });
                self.tools_active.insert(key, (handle, active_token));
            }
            Request::PickToolsFiles { scope, selected } => {
                self.spawn(Pending::Other, async move {
                    let paths = selected
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .map(|file| file.path().to_owned())
                        .collect();
                    emit(&events, &waker, scope, ResponseKind::ToolsFiles(paths));
                });
            }
            Request::PickToolsOutput { scope, selected } => {
                self.spawn(Pending::Other, async move {
                    let path = selected.await.map(|file| file.path().to_owned());
                    emit(&events, &waker, scope, ResponseKind::ToolsOutput(path));
                });
            }
            Request::Tools {
                scope,
                request,
                operation,
            } => {
                let key = (scope.clone(), request);
                if self.tools_active.contains_key(&key) {
                    return;
                }
                let token = Cancellation::default();
                let active_token = token.clone();
                let api = api.clone();
                let handle = self.spawn(Pending::Tools(scope.clone(), request), async move {
                    let progress_events = events.clone();
                    let progress_waker = waker.clone();
                    let progress_scope = scope.clone();
                    let progress = Arc::new(move |progress| {
                        emit(
                            &progress_events,
                            &progress_waker,
                            progress_scope.clone(),
                            ResponseKind::ToolsProgress { request, progress },
                        )
                    });
                    let result = crate::music_downloads::tools::execute(
                        operation,
                        Some(api),
                        token,
                        progress,
                    )
                    .await;
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::ToolsFinished { request, result },
                    );
                });
                self.tools_active.insert(key, (handle, active_token));
            }
            Request::CancelAlbumGain { scope, batch } => {
                if let Some(token) = self.album_active.get(&(scope, batch)) {
                    token.cancel();
                }
            }
            Request::CancelTools { scope, request } => {
                if let Some((_, token)) = self.tools_active.get(&(scope, request)) {
                    token.cancel();
                }
            }
            Request::ExportPreferences {
                scope,
                selected,
                options,
            } => {
                self.spawn(Pending::Other, async move {
                    let result = if let Some(file) = selected.await {
                        let path = file.path().to_owned();
                        tokio::task::spawn_blocking(move || {
                            crate::music_downloads::write_preferences(&path, &options)
                                .map(|()| Some(path))
                        })
                        .await
                        .unwrap_or_else(|_| Err("Settings export stopped unexpectedly.".into()))
                    } else {
                        Ok(None)
                    };
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::PreferencesExported(result),
                    );
                });
            }
            Request::ImportPreferences { scope, selected } => {
                self.spawn(Pending::Other, async move {
                    let result = if let Some(file) = selected.await {
                        let path = file.path().to_owned();
                        tokio::task::spawn_blocking(move || {
                            crate::music_downloads::read_preferences(&path).map(Some)
                        })
                        .await
                        .unwrap_or_else(|_| Err("Settings import stopped unexpectedly.".into()))
                    } else {
                        Ok(None)
                    };
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::PreferencesImported(result),
                    );
                });
            }
            Request::CheckSources { scope, providers } => {
                let api = api.clone();
                self.spawn(Pending::Other, async move {
                    let result = api.check_download_sources(&providers).await;
                    emit(&events, &waker, scope, ResponseKind::SourcesChecked(result));
                });
            }
            Request::AlbumGain {
                scope,
                batch,
                ids,
                paths,
            } => {
                let key = (scope.clone(), batch);
                if self.album_active.contains_key(&key) {
                    return;
                }
                let token = Cancellation::default();
                self.album_active.insert(key, token.clone());
                self.spawn(
                    Pending::AlbumGain(scope.clone(), batch, ids.clone()),
                    async move {
                        let result = tokio::task::spawn_blocking(move || {
                            crate::music_downloads::tools::apply_album_replay_gain(&paths, &token)
                        })
                        .await
                        .unwrap_or_else(|_| {
                            Err("Album loudness processing stopped unexpectedly.".into())
                        });
                        emit(
                            &events,
                            &waker,
                            scope,
                            ResponseKind::AlbumGain { batch, ids, result },
                        );
                    },
                );
            }
            Request::Load { scope } => {
                let path = self.state_dir.clone();
                self.spawn(Pending::Other, async move {
                    let account_id = scope.account_id.clone();
                    let result =
                        tokio::task::spawn_blocking(move || QueueState::load(&path, &account_id))
                            .await
                            .unwrap_or_else(
                                |_| Err("Download history could not be loaded.".into()),
                            );
                    emit(&events, &waker, scope, ResponseKind::Loaded(result));
                });
            }
            Request::Recover { scope } => {
                let path = self.state_dir.clone();
                self.spawn(Pending::Other, async move {
                    let account_id = scope.account_id.clone();
                    let result =
                        tokio::task::spawn_blocking(move || recover_history(&path, &account_id))
                            .await
                            .unwrap_or_else(|_| {
                                Err("Download history could not be recovered.".into())
                            });
                    emit(&events, &waker, scope, ResponseKind::Loaded(result));
                });
            }
            Request::Playlist {
                scope,
                batch,
                directory,
                title,
                tracks,
            } => {
                self.spawn(Pending::Other, async move {
                    let result = tokio::task::spawn_blocking(move || {
                        crate::music_downloads::write_playlist(&directory, &title, &tracks)
                    })
                    .await
                    .unwrap_or_else(|_| Err("Playlist export stopped unexpectedly.".into()));
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::Playlist { batch, result },
                    );
                });
            }
            Request::Save { scope, queue } => {
                if queue.account_id != scope.account_id {
                    return;
                }
                let path = self.state_dir.clone();
                let lock = self.save_lock.clone();
                let current = self.save_revision.clone();
                let revision = current.fetch_add(1, Ordering::SeqCst) + 1;
                self.spawn(Pending::Other, async move {
                    let _guard = lock.lock().await;
                    if current.load(Ordering::SeqCst) != revision {
                        return;
                    }
                    let result = tokio::task::spawn_blocking(move || queue.save(&path))
                        .await
                        .unwrap_or_else(|_| Err("Download history could not be saved.".into()));
                    if let Err(error) = result {
                        emit(&events, &waker, scope, ResponseKind::SaveFailed(error));
                    }
                });
            }
            Request::Resolve {
                scope,
                request,
                input,
                maximum_artwork,
            } => {
                let api = api.clone();
                self.spawn(Pending::Resolve(scope.clone(), request), async move {
                    let result = api
                        .resolve_download_input_with_artwork(&input, maximum_artwork)
                        .await;
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::Resolved { request, result },
                    );
                });
            }
            Request::Run { scope, job } => {
                let key = (scope.clone(), job.id);
                if self
                    .active
                    .get(&key)
                    .is_some_and(|(handle, _)| !handle.is_finished())
                {
                    return;
                }
                let token = Cancellation::default();
                let active_token = token.clone();
                let api = api.clone();
                let id = job.id;
                let handle = self.spawn(Pending::Job(scope.clone(), id), async move {
                    let progress_events = events.clone();
                    let progress_waker = waker.clone();
                    let progress_scope = scope.clone();
                    let progress = Arc::new(move |progress| {
                        emit(
                            &progress_events,
                            &progress_waker,
                            progress_scope.clone(),
                            ResponseKind::Progress { id, progress },
                        )
                    });
                    let receipt =
                        crate::music_downloads::execute_job(api, job, token, progress).await;
                    emit(
                        &events,
                        &waker,
                        scope,
                        ResponseKind::Finished { id, receipt },
                    );
                });
                self.active.insert(key, (handle, active_token));
            }
            Request::Cancel { scope, id } => {
                if let Some((_, token)) = self.active.get(&(scope, id)) {
                    token.cancel();
                }
            }
            Request::ChooseFolder { scope, selected } => {
                self.spawn(Pending::Other, async move {
                    let folder = selected.await.map(|file| file.path().to_path_buf());
                    emit(&events, &waker, scope, ResponseKind::FolderChosen(folder));
                });
            }
        }
    }
}

impl Drop for DownloadTasks {
    fn drop(&mut self) {
        self.cancel_all();
    }
}

// Only called by the explicit recovery button, before this session accepts jobs.
// Preserve the exact unreadable data beside its replacement for manual recovery.
fn recover_history(directory: &std::path::Path, account: &str) -> Result<QueueState, String> {
    let path = QueueState::path(directory, account);
    if path.exists() {
        let backup = path.with_extension(format!("unreadable-{}.json", rand::random::<u64>()));
        std::fs::rename(&path, &backup)
            .map_err(|error| format!("Could not back up download history: {error}"))?;
    }
    let queue = QueueState::for_account(account);
    queue.save(directory)?;
    Ok(queue)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_preserves_unreadable_history_before_starting_fresh() {
        let dir =
            std::env::temp_dir().join(format!("spotify-recover-test-{}", rand::random::<u64>()));
        let path = QueueState::path(&dir, "account");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"incomplete old history").unwrap();
        let queue = recover_history(&dir, "account").unwrap();
        assert_eq!(queue.account_id, "account");
        assert!(queue.jobs.is_empty());
        let files: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(files.len(), 2);
        let backup = files.iter().find(|file| file.path() != path).unwrap();
        assert_eq!(
            std::fs::read(backup.path()).unwrap(),
            b"incomplete old history"
        );
        assert!(QueueState::load(&dir, "account").is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
