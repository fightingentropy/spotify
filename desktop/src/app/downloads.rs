use super::*;
use crate::download_tasks::{Request, Response, ResponseKind, Scope};
use crate::music_downloads::ReplayGainMode;
use crate::music_downloads::{JobStage, QueueState, TransferProgress};
use crate::ui::download_tools::ToolAction;
use crate::ui::downloads::{DownloadAction, DownloadTab, DownloadViewState};
use std::sync::Arc;

const CONCURRENT_DOWNLOADS: usize = 2;
const MAX_QUEUE: usize = 10_000;

pub(super) struct DownloadSession {
    generation: u64,
    loaded: bool,
    dirty: bool,
    last_save: Instant,
    playlist_attempts: std::collections::HashSet<u64>,
    playlist_in_flight: std::collections::HashSet<u64>,
    album_gain_attempts: std::collections::HashSet<u64>,
    album_gain_in_flight: std::collections::HashMap<u64, Vec<u64>>,
}
impl Default for DownloadSession {
    fn default() -> Self {
        Self {
            generation: 0,
            loaded: false,
            dirty: false,
            last_save: Instant::now(),
            playlist_attempts: Default::default(),
            playlist_in_flight: Default::default(),
            album_gain_attempts: Default::default(),
            album_gain_in_flight: Default::default(),
        }
    }
}

impl App {
    fn download_scope(&self) -> Option<Scope> {
        (!self.download_queue.account_id.is_empty()).then(|| Scope {
            account_id: self.download_queue.account_id.clone(),
            generation: self.download_session.generation,
        })
    }

    pub(super) fn flush_downloads(&mut self) {
        if !self.offline
            && self.download_session.loaded
            && !self.download_queue.account_id.is_empty()
        {
            self.download_queue.options = self.downloads.options.clone();
            self.download_queue.revision = self.download_queue.revision.saturating_add(1);
            if let Err(error) = self.download_queue.save(&self.dirs.state) {
                log::warn!("{error}");
            }
        }
        self.download_session.dirty = false;
    }

    pub(super) fn clear_download_session(&mut self) {
        self.flush_downloads();
        self.download_session.generation = self.download_session.generation.wrapping_add(1);
        self.download_session.loaded = false;
        self.download_session.playlist_attempts.clear();
        self.download_session.playlist_in_flight.clear();
        self.download_session.album_gain_attempts.clear();
        self.download_session.album_gain_in_flight.clear();
        self.download_queue = QueueState::default();
        self.downloads = DownloadViewState::default();
    }

    pub(super) fn load_download_session(&mut self, account: &str) {
        if account.is_empty() || self.download_queue.account_id == account {
            return;
        }
        self.clear_download_session();
        self.download_queue = QueueState::for_account(account);
        if let Some(scope) = self.download_scope() {
            self.backend
                .send(Command::Downloads(Request::Load { scope }));
        }
    }

    pub(super) fn handle_download_response(&mut self, response: Response) {
        if self.download_scope().as_ref() != Some(&response.scope) {
            return;
        }
        match response.kind {
            ResponseKind::Searched { request, result } => {
                if request != self.downloads.catalog_request {
                    return;
                }
                if result.is_ok() {
                    let input = self.downloads.catalog_query.trim().to_owned();
                    if !input.is_empty() {
                        self.downloads
                            .recent_inputs
                            .retain(|previous| previous != &input);
                        self.downloads.recent_inputs.insert(0, input);
                        self.downloads.recent_inputs.truncate(20);
                        self.download_queue.recent_inputs = self.downloads.recent_inputs.clone();
                        self.download_session.dirty = true;
                    }
                }
                self.downloads.catalog = match result {
                    Ok(page) => Loadable::Loaded(page),
                    Err(error) => Loadable::Failed(error),
                };
            }
            ResponseKind::Availability {
                request,
                track,
                result,
            } => {
                if request != self.downloads.availability_request
                    || self
                        .downloads
                        .availability_track
                        .as_ref()
                        .map(|value| &value.id)
                        != Some(&track.id)
                {
                    return;
                }
                self.downloads.availability = match result {
                    Ok(value) => Loadable::Loaded(value),
                    Err(error) => Loadable::Failed(error),
                };
            }
            ResponseKind::ToolsFiles(paths) => self.downloads.tools.add_paths(paths),
            ResponseKind::ToolsOutput(Some(path)) => self.downloads.tools.output_dir = path,
            ResponseKind::ToolsOutput(None) => {}
            ResponseKind::ToolsProgress { request, progress } => {
                if request == self.downloads.tools.request {
                    self.downloads.tools.progress = Some(progress);
                }
            }
            ResponseKind::ToolsFinished { request, result } => {
                if request == self.downloads.tools.request {
                    self.downloads.tools.accept(result);
                }
            }
            ResponseKind::ToolsFailed { request, error } => {
                if request == self.downloads.tools.request {
                    self.downloads.tools.busy = false;
                    self.downloads.tools.cancelling = false;
                    self.downloads.tools.error = Some(error);
                }
            }
            ResponseKind::PreferencesImported(result) => {
                self.downloads.preferences_busy = false;
                match result {
                    Ok(Some(options)) => {
                        self.downloads.tools.lyrics_options = options.lyrics.clone();
                        self.downloads.options = options;
                        self.download_session.dirty = true;
                        self.toast("Download settings imported.");
                    }
                    Ok(None) => {}
                    Err(error) => self.downloads.error = Some(error),
                }
            }
            ResponseKind::PreferencesExported(result) => {
                self.downloads.preferences_busy = false;
                match result {
                    Ok(Some(_)) => self.toast("Download settings exported."),
                    Ok(None) => {}
                    Err(error) => self.downloads.error = Some(error),
                }
            }
            ResponseKind::SourcesChecked(result) => {
                self.downloads.source_checks_busy = false;
                match result {
                    Ok(checks) => self.downloads.source_checks = checks,
                    Err(error) => self.downloads.error = Some(error),
                }
            }
            ResponseKind::AlbumGain { batch, ids, result } => {
                self.download_session.album_gain_in_flight.remove(&batch);
                for job in self
                    .download_queue
                    .jobs
                    .iter_mut()
                    .filter(|job| ids.contains(&job.id))
                {
                    match &result {
                        Ok(()) => {
                            if let Some(file) = job
                                .receipt
                                .as_mut()
                                .and_then(|receipt| receipt.file.as_mut())
                            {
                                file.album_gain_applied = true;
                            }
                            job.stage = JobStage::Completed;
                            job.error = None;
                        }
                        Err(error) => {
                            job.stage = JobStage::Failed;
                            job.error = Some(format!(
                                "Audio saved; album loudness could not finish: {error}"
                            ));
                        }
                    }
                }
                self.download_session.dirty = true;
            }
            ResponseKind::Loaded(result) => {
                // Only accept the initial load. A delayed disk response cannot
                // overwrite jobs or preferences changed in this session.
                if self.download_session.loaded {
                    return;
                }
                match result {
                    Ok(mut queue) if queue.account_id == response.scope.account_id => {
                        // A lookup may complete while the initial disk load is pending.
                        // Merge its inputs into restored history without losing either.
                        let restored_inputs = queue.recent_inputs.clone();
                        for input in self.downloads.recent_inputs.iter().rev() {
                            queue.recent_inputs.retain(|previous| previous != input);
                            queue.recent_inputs.insert(0, input.clone());
                        }
                        queue.recent_inputs.truncate(20);
                        self.download_session.dirty |= restored_inputs != queue.recent_inputs;
                        self.downloads.options = queue.options.clone();
                        self.downloads.tools.lyrics_options = queue.options.lyrics.clone();
                        self.downloads.recent_inputs = queue.recent_inputs.clone();
                        self.download_queue = queue;
                        self.download_session.loaded = true;
                        self.downloads.history_ready = true;
                        self.downloads.history_error = None;
                    }
                    Ok(_) => {
                        self.downloads.history_error =
                            Some("Download history belongs to a different account.".into())
                    }
                    Err(error) => self.downloads.history_error = Some(error),
                }
            }
            ResponseKind::Resolved { request, result } => {
                if request != self.downloads.lookup_request {
                    return;
                }
                match result {
                    Ok(collection) => {
                        let input = self.downloads.committed_query.trim().to_owned();
                        if !input.is_empty() {
                            self.downloads
                                .recent_inputs
                                .retain(|previous| previous != &input);
                            self.downloads.recent_inputs.insert(0, input);
                            self.downloads.recent_inputs.truncate(20);
                            self.download_queue.recent_inputs =
                                self.downloads.recent_inputs.clone();
                            self.download_session.dirty = true;
                        }
                        self.downloads.set_collection(Arc::new(collection));
                    }
                    Err(error) => self.downloads.metadata = Loadable::Failed(error),
                }
            }
            ResponseKind::Progress { id, progress } => {
                // Byte counters are transient. Persist stage transitions rather
                // than serializing a large history for every progress update.
                let changed_stage = self
                    .download_queue
                    .jobs
                    .iter()
                    .any(|job| job.id == id && job.stage != progress.stage);
                self.download_queue.update(id, progress);
                self.download_session.dirty |= changed_stage;
            }
            ResponseKind::Finished { id, receipt } => {
                let saved = receipt.library_song_id.is_some();
                self.download_queue.finish(id, receipt);
                self.download_session.dirty = true;
                if saved {
                    // A saved file should appear in All Songs without restarting.
                    self.home.top_songs = Loadable::NotLoaded;
                    self.home.top_songs_loading = false;
                    self.home.top_songs_complete = false;
                    self.home.top_songs_generation = self.home.top_songs_generation.wrapping_add(1);
                    self.playlist_pages.remove("streamarena-all");
                    if matches!(self.page(), Page::Playlist(id) if id == "streamarena-all") {
                        self.ensure_loaded(Page::Playlist("streamarena-all".into()));
                    }
                }
            }
            ResponseKind::Failed { id, error } => {
                if let Some(job) = self.download_queue.jobs.iter_mut().find(|job| job.id == id) {
                    job.stage = JobStage::Failed;
                    job.error = Some(error);
                    self.download_session.dirty = true;
                }
            }
            ResponseKind::FolderChosen(Some(folder)) => {
                self.downloads.options.output_dir = folder;
                self.download_session.dirty = true;
            }
            ResponseKind::FolderChosen(None) => {}
            ResponseKind::Playlist { batch, result } => {
                self.download_session.playlist_in_flight.remove(&batch);
                match result {
                    Ok(path) => {
                        for job in self
                            .download_queue
                            .jobs
                            .iter_mut()
                            .filter(|job| job.batch_id == batch)
                        {
                            if let Some(file) = job
                                .receipt
                                .as_mut()
                                .and_then(|receipt| receipt.file.as_mut())
                            {
                                if !file.sidecars.contains(&path) {
                                    file.sidecars.push(path.clone());
                                }
                            }
                        }
                        self.download_session.dirty = true;
                    }
                    Err(error) => {
                        self.downloads.error = Some(format!(
                            "Audio downloaded, but the playlist could not be written: {error}"
                        ))
                    }
                }
            }
            ResponseKind::SaveFailed(error) => {
                self.downloads.error = Some(error);
                self.download_session.dirty = true;
            }
        }
    }

    pub(super) fn apply_download_action(&mut self, action: DownloadAction, ctx: &egui::Context) {
        let Some(scope) = self.download_scope() else {
            self.downloads.error = Some("Sign in to use Downloads.".into());
            return;
        };
        match action {
            DownloadAction::Find => {
                let query = self.downloads.query.trim();
                let action = if query.starts_with("https://")
                    || query.starts_with("http://")
                    || query.starts_with("spotify:")
                {
                    DownloadAction::Resolve
                } else {
                    DownloadAction::Search(0)
                };
                self.apply_download_action(action, ctx);
            }
            DownloadAction::Search(offset) => {
                let query = if offset == 0 {
                    self.downloads.query.trim().to_owned()
                } else {
                    self.downloads.catalog_query.clone()
                };
                if query.len() < 2 {
                    self.downloads.error = Some("Enter at least two characters to search.".into());
                    return;
                }
                self.downloads.catalog_query = query.clone();
                self.downloads.lookup_request = self.downloads.lookup_request.wrapping_add(1);
                if matches!(self.downloads.metadata, Loadable::Loading) {
                    self.downloads.metadata = Loadable::NotLoaded;
                }
                self.downloads.catalog_request = self.downloads.catalog_request.wrapping_add(1);
                self.downloads.show_catalog = true;
                self.downloads.catalog = Loadable::Loading;
                self.backend.send(Command::Downloads(Request::Search {
                    scope,
                    request: self.downloads.catalog_request,
                    query,
                    kind: self.downloads.catalog_kind,
                    offset,
                }));
            }
            DownloadAction::ResolveItem(input) => {
                self.downloads.query = input;
                self.apply_download_action(DownloadAction::Resolve, ctx);
            }
            DownloadAction::CheckAvailability(id) => {
                let Some(track) = self
                    .downloads
                    .metadata
                    .get()
                    .and_then(|collection| collection.tracks.iter().find(|track| track.id == id))
                    .cloned()
                else {
                    return;
                };
                self.downloads.availability_request =
                    self.downloads.availability_request.wrapping_add(1);
                self.downloads.availability_track = Some(track.clone());
                self.downloads.availability = Loadable::Loading;
                self.backend.send(Command::Downloads(Request::Availability {
                    scope,
                    request: self.downloads.availability_request,
                    track,
                    source: self.downloads.options.source,
                    quality: self.downloads.options.quality,
                    providers: self.downloads.options.providers.clone(),
                }));
            }
            DownloadAction::ExportAssets(_) | DownloadAction::ArtistImages(_) => {
                if !self.download_session.loaded || self.downloads.tools.busy {
                    return;
                }
                let (kind, artist_input) = match action {
                    DownloadAction::ExportAssets(kind) => (kind, None),
                    DownloadAction::ArtistImages(input) => (
                        crate::download_tasks::assets::AssetKind::Artwork,
                        Some(input),
                    ),
                    _ => unreachable!(),
                };
                let assets = crate::download_tasks::assets::AssetRequest {
                    kind,
                    tracks: self.downloads.selected_tracks(),
                    images: self
                        .downloads
                        .metadata
                        .get()
                        .map(|collection| collection.images.clone())
                        .unwrap_or_default(),
                    artist_input,
                    options: self.downloads.options.clone(),
                };
                self.downloads.tools.request = self.downloads.tools.request.wrapping_add(1);
                self.downloads.tools.busy = true;
                self.downloads.tools.cancelling = false;
                self.downloads.tools.progress = None;
                self.downloads.tools.error = None;
                self.downloads.tab = DownloadTab::Tools;
                self.backend.send(Command::Downloads(Request::Assets {
                    scope,
                    request: self.downloads.tools.request,
                    assets,
                }));
            }
            DownloadAction::Tools(action) => {
                self.apply_tools_action(action, scope);
            }
            DownloadAction::ExportPreferences | DownloadAction::ImportPreferences => {
                if self.offline || !self.download_session.loaded || self.downloads.preferences_busy
                {
                    return;
                }
                self.downloads.preferences_busy = true;
                self.downloads.error = None;
                let dialog = rfd::AsyncFileDialog::new().add_filter("JSON settings", &["json"]);
                let request = if matches!(action, DownloadAction::ExportPreferences) {
                    Request::ExportPreferences {
                        scope,
                        selected: Box::pin(
                            dialog
                                .set_title("Export download settings")
                                .set_file_name("Spotify download settings.json")
                                .save_file(),
                        ),
                        options: self.downloads.options.clone(),
                    }
                } else {
                    Request::ImportPreferences {
                        scope,
                        selected: Box::pin(
                            dialog.set_title("Import download settings").pick_file(),
                        ),
                    }
                };
                self.backend.send(Command::Downloads(request));
            }
            DownloadAction::CheckSources => {
                if self.downloads.source_checks_busy {
                    return;
                }
                if let Err(error) = self.downloads.options.providers.validate() {
                    self.downloads.error = Some(error);
                    return;
                }
                self.downloads.source_checks_busy = true;
                self.downloads.source_checks.clear();
                self.backend.send(Command::Downloads(Request::CheckSources {
                    scope,
                    providers: self.downloads.options.providers.clone(),
                }));
            }
            DownloadAction::ReloadHistory | DownloadAction::RecoverHistory => {
                if self.download_session.loaded || self.downloads.history_error.is_none() {
                    return;
                }
                self.downloads.history_error = None;
                let request = if matches!(action, DownloadAction::RecoverHistory) {
                    Request::Recover { scope }
                } else {
                    Request::Load { scope }
                };
                self.backend.send(Command::Downloads(request));
            }
            DownloadAction::Resolve => {
                let input = self.downloads.query.trim().to_owned();
                if input.len() < 2 {
                    self.downloads.error = Some("Enter a music search or Spotify link.".into());
                    return;
                }
                self.downloads.show_catalog = false;
                self.downloads.catalog_request = self.downloads.catalog_request.wrapping_add(1);
                self.downloads.catalog = Loadable::NotLoaded;
                self.downloads.committed_query = input.clone();
                self.downloads.lookup_request = self.downloads.lookup_request.wrapping_add(1);
                self.downloads.metadata = Loadable::Loading;
                self.downloads.error = None;
                self.backend.send(Command::Downloads(Request::Resolve {
                    scope,
                    request: self.downloads.lookup_request,
                    input,
                    maximum_artwork: self.downloads.options.max_artwork,
                }));
            }
            DownloadAction::ChooseFolder => {
                if self.offline || !self.download_session.loaded {
                    return;
                }
                // AppKit's file dialog must be constructed on the UI thread.
                let selected = rfd::AsyncFileDialog::new()
                    .set_title("Download destination")
                    .set_directory(&self.downloads.options.output_dir)
                    .pick_folder();
                self.backend.send(Command::Downloads(Request::ChooseFolder {
                    scope,
                    selected: Box::pin(selected),
                }));
            }
            DownloadAction::EnqueueSelected => {
                if let Err(error) = self.downloads.options.providers.validate() {
                    self.downloads.error = Some(error);
                    return;
                }
                if !self.download_session.loaded {
                    self.downloads.error =
                        Some("Download history is still loading. Try again shortly.".into());
                    return;
                }
                let tracks = self.downloads.selected_tracks();
                if tracks.is_empty() {
                    self.downloads.error = Some("Select at least one track.".into());
                    return;
                }
                if self.download_queue.jobs.len().saturating_add(tracks.len()) > MAX_QUEUE {
                    self.downloads.error = Some(
                        "Clear finished history before adding more than 10,000 downloads.".into(),
                    );
                    return;
                }
                let batch = self.download_queue.next_id.max(1);
                let title = self
                    .downloads
                    .metadata
                    .get()
                    .map(|collection| collection.title.clone())
                    .unwrap_or_else(|| "Downloads".into());
                let (collection_kind, collection_owner) = self
                    .downloads
                    .metadata
                    .get()
                    .map(|collection| (collection.kind.clone(), collection.owner.clone()))
                    .unwrap_or_default();
                let mut added = 0;
                for track in tracks {
                    if let Some(id) = self
                        .download_queue
                        .enqueue(track, self.downloads.options.clone())
                    {
                        if let Some(job) =
                            self.download_queue.jobs.iter_mut().find(|job| job.id == id)
                        {
                            job.batch_id = batch;
                            job.collection_title = title.clone();
                            job.collection_kind = collection_kind.clone();
                            job.collection_owner = collection_owner.clone();
                        }
                        added += 1;
                    }
                }
                self.download_queue.paused = false;
                self.download_session.dirty = true;
                self.downloads.tab = DownloadTab::Queue;
                self.downloads.error = None;
                self.toast(if added == 0 {
                    "Those tracks are already queued.".into()
                } else {
                    format!(
                        "Queued {added} {}",
                        if added == 1 { "track" } else { "tracks" }
                    )
                });
            }
            DownloadAction::Cancel(id) => {
                if let Some((&batch, _)) = self
                    .download_session
                    .album_gain_in_flight
                    .iter()
                    .find(|(_, ids)| ids.contains(&id))
                {
                    self.backend
                        .send(Command::Downloads(Request::CancelAlbumGain {
                            scope,
                            batch,
                        }));
                    if let Some(job) = self.download_queue.jobs.iter_mut().find(|job| job.id == id)
                    {
                        job.error = Some("Cancelling album loudness…".into());
                    }
                    return;
                }
                if let Some(job) = self.download_queue.jobs.iter_mut().find(|job| job.id == id) {
                    if job.stage == JobStage::Queued {
                        job.stage = JobStage::Cancelled;
                        job.error = None;
                    } else if job.stage.active() {
                        // Keep the slot occupied until the worker confirms it
                        // stopped. An accepted server save may still complete.
                        job.error = Some(if job.stage == JobStage::SavingLibrary {
                            "Finishing the library save already accepted by the server.".into()
                        } else {
                            "Cancelling…".into()
                        });
                        self.backend
                            .send(Command::Downloads(Request::Cancel { scope, id }));
                    }
                    self.download_session.dirty = true;
                }
            }
            DownloadAction::Retry(id) => {
                self.download_session.album_gain_attempts.clear();
                self.download_queue.retry(id);
                self.download_queue.paused = false;
                self.download_session.dirty = true;
            }
            DownloadAction::RetryFailed => {
                self.download_session.album_gain_attempts.clear();
                let ids: Vec<_> = self
                    .download_queue
                    .jobs
                    .iter()
                    .filter(|job| matches!(job.stage, JobStage::Failed | JobStage::Interrupted))
                    .map(|job| job.id)
                    .collect();
                for id in ids {
                    self.download_queue.retry(id);
                }
                self.download_queue.paused = false;
                self.download_session.dirty = true;
            }
            DownloadAction::PauseQueue => {
                self.download_queue.paused = true;
                self.download_session.dirty = true;
            }
            DownloadAction::ResumeQueue => {
                self.download_queue.paused = false;
                self.download_session.dirty = true;
            }
            DownloadAction::ClearFinished => {
                // A completed track remains part of its batch until the M3U8
                // export settles. Clearing history must not silently truncate
                // an album while its other tracks are still downloading.
                let mut batches: std::collections::HashMap<u64, (bool, bool, bool)> =
                    Default::default();
                for job in self
                    .download_queue
                    .jobs
                    .iter()
                    .filter(|job| job.batch_id != 0)
                {
                    let (finished, written, requested) =
                        batches.entry(job.batch_id).or_insert((true, false, false));
                    *finished &= job.stage == JobStage::Completed;
                    *requested |= job.options.create_playlist && job.options.destination.local();
                    *written |= job
                        .receipt
                        .as_ref()
                        .and_then(|receipt| receipt.file.as_ref())
                        .is_some_and(|file| {
                            file.sidecars.iter().any(|path| {
                                path.extension()
                                    .is_some_and(|extension| extension == "m3u8")
                            })
                        });
                }
                let required_batches: std::collections::HashSet<_> = batches
                    .into_iter()
                    .filter_map(|(batch, (finished, written, requested))| {
                        (requested
                            && !written
                            && (!finished
                                || !self.download_session.playlist_attempts.contains(&batch)
                                || self.download_session.playlist_in_flight.contains(&batch)))
                        .then_some(batch)
                    })
                    .collect();
                self.download_queue.jobs.retain(|job| {
                    job.stage != JobStage::Completed
                        || required_batches.contains(&job.batch_id)
                        || album_gain_needed(job)
                });
                if !required_batches.is_empty() {
                    self.toast(
                        "Kept completed tracks needed for an unfinished collection playlist.",
                    );
                }
                self.download_session.dirty = true;
            }
            DownloadAction::Reveal(path) => {
                if let Err(error) = reveal_file(&path) {
                    self.toast_error(format!("Could not reveal this file: {error}"));
                }
            }
            DownloadAction::OpenFile(path) => {
                if !path.is_file() {
                    self.toast_error("This downloaded file was moved or removed.");
                } else if let Err(error) = crate::opener::open(&path) {
                    self.toast_error(format!("Could not open this file: {error}"));
                }
            }
            DownloadAction::OpenLibrarySong(id) => self.apply(
                Action::PlayContext {
                    uri: format!("spotify:track:{id}"),
                    offset_uri: None,
                    offset_index: None,
                },
                ctx,
            ),
        }
        ctx.request_repaint();
    }

    fn apply_tools_action(&mut self, action: ToolAction, scope: Scope) {
        let tools = &mut self.downloads.tools;
        match action {
            ToolAction::AddFiles | ToolAction::AddFolder => {
                if self.offline {
                    tools.error=Some("File dialogs are unavailable in demo mode. Open the normal app to use local audio and lyric files.".into());
                    return;
                }
                if tools.busy {
                    return;
                }
                let selected: std::pin::Pin<
                    Box<dyn std::future::Future<Output = Option<Vec<rfd::FileHandle>>> + Send>,
                > = if matches!(action, ToolAction::AddFolder) {
                    let folder = rfd::AsyncFileDialog::new()
                        .set_title("Choose audio folder")
                        .pick_folder();
                    Box::pin(async move { folder.await.map(|file| vec![file]) })
                } else {
                    Box::pin(
                        rfd::AsyncFileDialog::new()
                            .set_title("Choose audio or lyric files")
                            .add_filter(
                                "Audio and lyrics",
                                &[
                                    "flac", "mp3", "m4a", "aac", "opus", "ogg", "wav", "aiff",
                                    "aif", "alac", "wma", "lrc", "txt",
                                ],
                            )
                            .pick_files(),
                    )
                };
                self.backend
                    .send(Command::Downloads(Request::PickToolsFiles {
                        scope,
                        selected,
                    }));
            }
            ToolAction::ChooseOutput => {
                if self.offline {
                    tools.error=Some("File dialogs are unavailable in demo mode. Open the normal app to choose a local output folder.".into());
                    return;
                }
                if tools.busy {
                    return;
                }
                let selected = rfd::AsyncFileDialog::new()
                    .set_title("Save audio copies to")
                    .set_directory(&tools.output_dir)
                    .pick_folder();
                self.backend
                    .send(Command::Downloads(Request::PickToolsOutput {
                        scope,
                        selected: Box::pin(selected),
                    }));
            }
            ToolAction::Focus(path) => {
                if !tools.busy {
                    tools.focus(path);
                }
            }
            ToolAction::RemoveSelected => {
                if tools.busy {
                    return;
                }
                tools.paths.retain(|path| !tools.selected.contains(path));
                tools
                    .documents
                    .retain(|path, _| !tools.selected.contains(path));
                tools
                    .lyric_documents
                    .retain(|path, _| !tools.selected.contains(path));
                tools
                    .results
                    .retain(|file| !tools.selected.contains(&file.input));
                if tools
                    .focused
                    .as_ref()
                    .is_some_and(|path| tools.selected.contains(path))
                {
                    tools.focused = None;
                    tools.tags.clear();
                    tools.lyrics.clear();
                }
                tools.selected.clear();
                tools.result_focus = 0;
            }
            ToolAction::Run(operation) => {
                if tools.busy {
                    return;
                }
                let operation = match tools.build_request(operation) {
                    Ok(operation) => operation,
                    Err(error) => {
                        tools.error = Some(error);
                        return;
                    }
                };
                // The editor is authoritative here: users may have just changed
                // its language or CLI selection before pressing Translate.
                self.downloads.options.lyrics = tools.lyrics_options.clone();
                tools.request = tools.request.wrapping_add(1);
                tools.busy = true;
                tools.cancelling = false;
                tools.progress = None;
                tools.error = None;
                self.backend.send(Command::Downloads(Request::Tools {
                    scope,
                    request: tools.request,
                    operation,
                }));
            }
            ToolAction::Cancel => {
                if !tools.busy || tools.cancelling {
                    return;
                }
                tools.cancelling = true;
                self.backend.send(Command::Downloads(Request::CancelTools {
                    scope,
                    request: tools.request,
                }));
            }
        }
    }

    fn finalize_album_gain(&mut self, scope: &Scope) {
        if self.download_queue.paused {
            return;
        }
        let mut groups: std::collections::BTreeMap<(u64, String, String), Vec<usize>> =
            Default::default();
        for (index, job) in self.download_queue.jobs.iter().enumerate() {
            if job.batch_id != 0
                && job.options.replay_gain
                && job.options.replay_gain_mode == ReplayGainMode::Album
                && job.options.destination.local()
            {
                groups
                    .entry((
                        job.batch_id,
                        if job.track.album.is_empty() {
                            job.track.id.clone()
                        } else {
                            job.track.album.to_lowercase()
                        },
                        if job.track.album_artist.is_empty() {
                            job.track.artists.join(", ").to_lowercase()
                        } else {
                            job.track.album_artist.to_lowercase()
                        },
                    ))
                    .or_default()
                    .push(index);
            }
        }
        for (_, indices) in groups {
            if indices
                .iter()
                .any(|&index| self.download_queue.jobs[index].stage != JobStage::Completed)
            {
                continue;
            }
            let pending: Vec<_> = indices
                .iter()
                .copied()
                .filter(|&index| album_gain_needed(&self.download_queue.jobs[index]))
                .collect();
            let Some(&first) = pending.first() else {
                continue;
            };
            let group_id = self.download_queue.jobs[first].id;
            if self
                .download_session
                .album_gain_attempts
                .contains(&group_id)
                || self
                    .download_session
                    .album_gain_in_flight
                    .contains_key(&group_id)
            {
                continue;
            }
            let expected = indices
                .iter()
                .map(|&index| self.download_queue.jobs[index].track.track_total as usize)
                .max()
                .unwrap_or(0);
            let partial = pending.len() != indices.len() || expected > indices.len();
            let mut paths = Vec::new();
            let mut ids = Vec::new();
            for index in pending {
                let job = &mut self.download_queue.jobs[index];
                if let Some(file) = job
                    .receipt
                    .as_mut()
                    .and_then(|receipt| receipt.file.as_mut())
                {
                    if partial {
                        file.warnings.push(
                            "Album ReplayGain covers the newly downloaded selection only.".into(),
                        );
                    }
                    paths.push(file.path.clone());
                    ids.push(job.id);
                    job.stage = JobStage::Processing;
                }
            }
            self.download_session.album_gain_attempts.insert(group_id);
            self.download_session
                .album_gain_in_flight
                .insert(group_id, ids.clone());
            self.backend.send(Command::Downloads(Request::AlbumGain {
                scope: scope.clone(),
                batch: group_id,
                ids,
                paths,
            }));
            self.download_session.dirty = true;
        }
    }

    pub(super) fn tick_downloads(&mut self, ctx: &egui::Context) {
        if !self.download_session.loaded {
            return;
        }
        let Some(scope) = self.download_scope() else {
            return;
        };
        if self.download_queue.options != self.downloads.options {
            self.download_queue.options = self.downloads.options.clone();
            self.download_session.dirty = true;
        }
        let active = self
            .download_queue
            .jobs
            .iter()
            .filter(|job| job.stage.active())
            .count();
        if !self.download_queue.paused {
            let pending: Vec<_> = self
                .download_queue
                .jobs
                .iter()
                .filter(|job| job.stage == JobStage::Queued)
                .take(CONCURRENT_DOWNLOADS.saturating_sub(active))
                .map(|job| job.id)
                .collect();
            for id in pending {
                self.download_queue.update(
                    id,
                    TransferProgress {
                        stage: JobStage::Resolving,
                        ..Default::default()
                    },
                );
                let job = self
                    .download_queue
                    .jobs
                    .iter()
                    .find(|job| job.id == id)
                    .expect("queued job")
                    .clone();
                self.backend.send(Command::Downloads(Request::Run {
                    scope: scope.clone(),
                    job,
                }));
                self.download_session.dirty = true;
            }
        }
        self.finalize_album_gain(&scope);
        // Only write a collection once all its selected tracks are safely on disk.
        // Persist the playlist in each receipt so a restart does not duplicate it.
        let batches: std::collections::HashSet<_> = self
            .download_queue
            .jobs
            .iter()
            .filter(|job| {
                job.batch_id != 0 && job.options.create_playlist && job.options.destination.local()
            })
            .map(|job| job.batch_id)
            .collect();
        for batch in batches {
            if self.download_session.playlist_attempts.contains(&batch) {
                continue;
            }
            let jobs: Vec<_> = self
                .download_queue
                .jobs
                .iter()
                .filter(|job| job.batch_id == batch)
                .collect();
            if jobs.is_empty() || jobs.iter().any(|job| job.stage != JobStage::Completed) {
                continue;
            }
            if jobs.iter().any(|job| {
                job.receipt
                    .as_ref()
                    .and_then(|receipt| receipt.file.as_ref())
                    .is_some_and(|file| {
                        file.sidecars
                            .iter()
                            .any(|path| path.extension().is_some_and(|ext| ext == "m3u8"))
                    })
            }) {
                continue;
            }
            let tracks = jobs
                .iter()
                .filter_map(|job| {
                    job.receipt
                        .as_ref()
                        .and_then(|receipt| receipt.file.clone())
                        .map(|file| {
                            (
                                crate::music_downloads::TrackMetadata::from(&job.track),
                                file,
                            )
                        })
                })
                .collect();
            self.backend.send(Command::Downloads(Request::Playlist {
                scope: scope.clone(),
                batch,
                directory: jobs[0].options.output_dir.clone(),
                title: jobs[0].collection_title.clone(),
                tracks,
            }));
            self.download_session.playlist_attempts.insert(batch);
            self.download_session.playlist_in_flight.insert(batch);
        }
        if self.download_session.dirty
            && self.download_session.last_save.elapsed() >= Duration::from_secs(1)
        {
            self.download_queue.revision = self.download_queue.revision.saturating_add(1);
            self.backend.send(Command::Downloads(Request::Save {
                scope,
                queue: self.download_queue.clone(),
            }));
            self.download_session.dirty = false;
            self.download_session.last_save = Instant::now();
        }
        if self.download_session.dirty || active > 0 {
            ctx.request_repaint_after(Duration::from_millis(250));
        }
    }
}

fn album_gain_needed(job: &crate::music_downloads::DownloadJob) -> bool {
    job.batch_id != 0
        && job.options.replay_gain
        && job.options.replay_gain_mode == ReplayGainMode::Album
        && job.options.destination.local()
        && job
            .receipt
            .as_ref()
            .and_then(|receipt| receipt.file.as_ref())
            .is_some_and(|file| !file.skipped && !file.album_gain_applied)
}

fn reveal_file(path: &std::path::Path) -> std::io::Result<()> {
    if !path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "File was moved or removed",
        ));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        crate::opener::open(path.parent().unwrap_or(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_api::downloads::{DownloadCollection, DownloadTrack};
    use crate::music_downloads::{JobReceipt, OutputFormat};

    fn app_with_downloads(loaded: bool) -> App {
        let mut app = super::super::tests::headless_app();
        // Exercise the real UI integration without network work or native output.
        app.backend.set_offline(true);
        app.backend.shutdown();
        app.offline = true;
        app.download_queue = QueueState::for_account("current-download-account");
        app.download_session.generation = 11;
        app.download_session.loaded = loaded;
        app.downloads.history_ready = loaded;
        app
    }

    fn track(id: &str) -> DownloadTrack {
        DownloadTrack {
            id: id.into(),
            title: id.into(),
            ..Default::default()
        }
    }

    fn enqueue(app: &mut App, id: &str) -> u64 {
        app.download_queue
            .enqueue(track(id), app.download_queue.options.clone())
            .unwrap()
    }

    #[test]
    fn inline_translation_preferences_survive_run_and_restore_from_saved_settings() {
        use crate::music_downloads::{LyricsOptions, LyricsTranslationProvider};
        use crate::ui::download_tools::ToolOperation;
        let mut app = app_with_downloads(false);
        let mut restored = QueueState::for_account("current-download-account");
        restored.options.lyrics = LyricsOptions {
            translation_provider: LyricsTranslationProvider::Codex,
            language: "French".into(),
            ..Default::default()
        };
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::Loaded(Ok(restored)),
        });
        assert_eq!(app.downloads.tools.lyrics_options.language, "French");
        let mut imported = app.downloads.options.clone();
        imported.lyrics.language = "German".into();
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::PreferencesImported(Ok(Some(imported))),
        });
        assert_eq!(app.downloads.tools.lyrics_options.language, "German");
        app.downloads.tools.focused = Some(std::path::PathBuf::from("/test/local-lyrics.lrc"));
        app.downloads.tools.lyrics = "[00:01.00]Synthetic line".into();
        app.downloads.tools.lyrics_options = LyricsOptions {
            translation_provider: LyricsTranslationProvider::Claude,
            language: "Italian".into(),
            fallback: false,
            title_fallback: false,
        };
        let edited = app.downloads.tools.lyrics_options.clone();
        app.apply_download_action(
            DownloadAction::Tools(ToolAction::Run(ToolOperation::TranslateLyrics)),
            &egui::Context::default(),
        );
        assert!(app.downloads.tools.busy);
        assert_eq!(app.downloads.tools.lyrics_options, edited);
        assert_eq!(app.downloads.options.lyrics, edited);
        app.tick_downloads(&egui::Context::default());
        assert_eq!(app.download_queue.options.lyrics, edited);
    }

    #[test]
    fn demo_file_dialogs_explain_isolation_instead_of_silently_ignoring_clicks() {
        let mut app = app_with_downloads(true);
        let ctx = egui::Context::default();
        for action in [
            ToolAction::AddFiles,
            ToolAction::AddFolder,
            ToolAction::ChooseOutput,
        ] {
            app.downloads.tools.error = None;
            app.apply_download_action(DownloadAction::Tools(action), &ctx);
            assert!(
                app.downloads
                    .tools
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("demo mode")
            );
            assert!(!app.downloads.tools.busy);
        }
    }

    #[test]
    fn catalog_and_availability_ignore_superseded_requests() {
        use crate::music_api::downloads::{CatalogPage, TrackAvailability};
        let mut app = app_with_downloads(true);
        let ctx = egui::Context::default();
        app.downloads.query = "First query".into();
        app.apply_download_action(DownloadAction::Search(0), &ctx);
        let old = app.downloads.catalog_request;
        app.downloads.query = "Second query".into();
        app.apply_download_action(DownloadAction::Search(0), &ctx);
        let current = app.downloads.catalog_request;
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::Searched {
                request: old,
                result: Ok(CatalogPage::default()),
            },
        });
        assert!(matches!(app.downloads.catalog, Loadable::Loading));
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::Searched {
                request: current,
                result: Ok(CatalogPage {
                    offset: 25,
                    ..Default::default()
                }),
            },
        });
        assert_eq!(app.downloads.catalog.get().unwrap().offset, 25);
        app.downloads.query = "Unsubmitted text".into();
        app.apply_download_action(DownloadAction::Search(25), &ctx);
        assert_eq!(app.downloads.catalog_query, "Second query");
        app.downloads.set_collection(Arc::new(DownloadCollection {
            tracks: vec![track("a"), track("b")],
            ..Default::default()
        }));
        app.apply_download_action(DownloadAction::CheckAvailability("a".into()), &ctx);
        let old = app.downloads.availability_request;
        app.apply_download_action(DownloadAction::CheckAvailability("b".into()), &ctx);
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::Availability {
                request: old,
                track: track("a"),
                result: Ok(TrackAvailability::default()),
            },
        });
        assert!(matches!(app.downloads.availability, Loadable::Loading));
        assert_eq!(app.downloads.availability_track.as_ref().unwrap().id, "b");
    }

    #[test]
    fn stale_account_and_generation_responses_cannot_change_current_downloads() {
        let mut app = app_with_downloads(false);
        let id = enqueue(&mut app, "current-track");
        app.downloads.lookup_request = 7;
        app.downloads.set_collection(Arc::new(DownloadCollection {
            title: "Current result".into(),
            tracks: vec![track("current-result")],
            ..Default::default()
        }));
        let original_folder = app.downloads.options.output_dir.clone();
        let stale_scopes = [
            Scope {
                account_id: "previous-account".into(),
                generation: 11,
            },
            Scope {
                account_id: "current-download-account".into(),
                generation: 10,
            },
        ];
        for scope in stale_scopes {
            app.handle_download_response(Response {
                scope: scope.clone(),
                kind: ResponseKind::Loaded(Ok(QueueState::for_account(scope.account_id.clone()))),
            });
            app.handle_download_response(Response {
                scope: scope.clone(),
                kind: ResponseKind::Resolved {
                    request: 7,
                    result: Ok(DownloadCollection {
                        title: "Stale result".into(),
                        tracks: vec![track("stale-track")],
                        ..Default::default()
                    }),
                },
            });
            app.handle_download_response(Response {
                scope: scope.clone(),
                kind: ResponseKind::Progress {
                    id,
                    progress: TransferProgress {
                        stage: JobStage::Downloading,
                        received: 999,
                        total: Some(1000),
                    },
                },
            });
            app.handle_download_response(Response {
                scope: scope.clone(),
                kind: ResponseKind::FolderChosen(Some(std::path::PathBuf::from(
                    "/stale-download-folder",
                ))),
            });
            app.handle_download_response(Response {
                scope,
                kind: ResponseKind::SaveFailed("An old account failed to save".into()),
            });
        }
        assert!(!app.download_session.loaded);
        assert!(!app.downloads.history_ready);
        assert!(!app.download_session.dirty);
        assert_eq!(app.download_queue.account_id, "current-download-account");
        assert_eq!(app.download_queue.jobs.len(), 1);
        assert_eq!(app.download_queue.jobs[0].stage, JobStage::Queued);
        assert_eq!(app.download_queue.jobs[0].progress.received, 0);
        assert_eq!(
            app.downloads.metadata.get().unwrap().title,
            "Current result"
        );
        assert_eq!(app.downloads.options.output_dir, original_folder);
        assert!(app.downloads.error.is_none());
    }

    #[test]
    fn queue_runs_at_most_two_tracks_and_pause_holds_remaining_tracks() {
        let mut app = app_with_downloads(true);
        let ctx = egui::Context::default();
        let ids: Vec<_> = (0..5)
            .map(|index| enqueue(&mut app, &format!("track-{index}")))
            .collect();
        app.download_queue.paused = true;
        app.tick_downloads(&ctx);
        assert!(
            app.download_queue
                .jobs
                .iter()
                .all(|job| job.stage == JobStage::Queued)
        );

        app.download_queue.paused = false;
        app.tick_downloads(&ctx);
        app.tick_downloads(&ctx);
        assert_eq!(
            app.download_queue
                .jobs
                .iter()
                .filter(|job| job.stage.active())
                .map(|job| job.id)
                .collect::<Vec<_>>(),
            ids[..2]
        );

        app.download_queue.paused = true;
        app.handle_download_response(Response {
            scope: app.download_scope().unwrap(),
            kind: ResponseKind::Finished {
                id: ids[0],
                receipt: JobReceipt {
                    library_song_id: Some("saved-track".into()),
                    ..Default::default()
                },
            },
        });
        app.tick_downloads(&ctx);
        assert_eq!(app.download_queue.jobs[0].stage, JobStage::Completed);
        assert!(app.download_queue.jobs[1].stage.active());
        assert!(
            app.download_queue.jobs[2..]
                .iter()
                .all(|job| job.stage == JobStage::Queued)
        );

        app.download_queue.paused = false;
        app.tick_downloads(&ctx);
        assert_eq!(
            app.download_queue
                .jobs
                .iter()
                .filter(|job| job.stage.active())
                .map(|job| job.id)
                .collect::<Vec<_>>(),
            ids[1..3]
        );
    }

    #[test]
    fn retry_failed_preserves_cancelled_completed_and_active_downloads() {
        let mut app = app_with_downloads(true);
        let stages = [
            JobStage::Failed,
            JobStage::Interrupted,
            JobStage::Cancelled,
            JobStage::Completed,
            JobStage::Downloading,
        ];
        for (index, stage) in stages.into_iter().enumerate() {
            enqueue(&mut app, &format!("retry-{index}"));
            app.download_queue.jobs[index].stage = stage;
        }
        app.download_queue.jobs[2].error = Some("Cancelled by you".into());
        app.download_queue.jobs[3].receipt = Some(JobReceipt {
            library_song_id: Some("already-saved".into()),
            ..Default::default()
        });
        app.download_queue.paused = true;
        app.apply_download_action(DownloadAction::RetryFailed, &egui::Context::default());
        assert_eq!(
            app.download_queue
                .jobs
                .iter()
                .map(|job| job.stage)
                .collect::<Vec<_>>(),
            [
                JobStage::Queued,
                JobStage::Queued,
                JobStage::Cancelled,
                JobStage::Completed,
                JobStage::Downloading
            ]
        );
        assert_eq!(
            app.download_queue.jobs[2].error.as_deref(),
            Some("Cancelled by you")
        );
        assert_eq!(
            app.download_queue.jobs[3]
                .receipt
                .as_ref()
                .unwrap()
                .library_song_id
                .as_deref(),
            Some("already-saved")
        );
        assert!(!app.download_queue.paused);
    }

    #[test]
    fn initial_history_load_gates_folder_changes_and_enqueue_without_losing_saved_options() {
        let mut app = app_with_downloads(false);
        let ctx = egui::Context::default();
        app.downloads.set_collection(Arc::new(DownloadCollection {
            tracks: vec![track("selected-track")],
            ..Default::default()
        }));
        app.downloads.options.format = OutputFormat::Mp3;
        let original_folder = app.downloads.options.output_dir.clone();
        // With offline=false, the initial-load guard itself must prevent AppKit
        // from constructing a folder dialog on this headless test thread.
        app.offline = false;
        app.apply_download_action(DownloadAction::ChooseFolder, &ctx);
        app.offline = true;
        app.apply_download_action(DownloadAction::EnqueueSelected, &ctx);
        app.tick_downloads(&ctx);
        assert!(app.download_queue.jobs.is_empty());
        assert_eq!(app.downloads.options.output_dir, original_folder);
        assert_eq!(app.download_queue.options.format, OutputFormat::Original);
        assert!(!app.download_session.dirty);
        assert!(
            app.downloads
                .error
                .as_deref()
                .unwrap()
                .contains("still loading")
        );

        let scope = app.download_scope().unwrap();
        let mut saved = QueueState::for_account(scope.account_id.clone());
        saved.options.format = OutputFormat::Alac;
        saved.enqueue(track("already-in-history"), saved.options.clone());
        app.handle_download_response(Response {
            scope,
            kind: ResponseKind::Loaded(Ok(saved)),
        });
        assert!(app.download_session.loaded);
        assert!(app.downloads.history_ready);
        assert_eq!(app.downloads.options.format, OutputFormat::Alac);
        app.apply_download_action(DownloadAction::EnqueueSelected, &ctx);
        assert_eq!(
            app.download_queue
                .jobs
                .iter()
                .map(|job| job.track.id.as_str())
                .collect::<Vec<_>>(),
            ["already-in-history", "selected-track"]
        );
        assert_eq!(
            app.download_queue.jobs[1].options.format,
            OutputFormat::Alac
        );
    }

    #[test]
    fn clearing_completed_history_preserves_unfinished_and_inflight_playlist_batches() {
        let mut app = app_with_downloads(true);
        let ctx = egui::Context::default();
        let first = enqueue(&mut app, "album-first");
        let second = enqueue(&mut app, "album-second");
        for job in &mut app.download_queue.jobs {
            job.batch_id = first;
            job.options.create_playlist = true;
        }
        app.download_queue.jobs[0].stage = JobStage::Completed;
        app.apply_download_action(DownloadAction::ClearFinished, &ctx);
        assert_eq!(
            app.download_queue.jobs.len(),
            2,
            "first track remains part of unfinished album"
        );
        app.download_queue.jobs[1].stage = JobStage::Completed;
        app.download_session.playlist_attempts.insert(first);
        app.download_session.playlist_in_flight.insert(first);
        app.apply_download_action(DownloadAction::ClearFinished, &ctx);
        assert_eq!(
            app.download_queue
                .jobs
                .iter()
                .map(|job| job.id)
                .collect::<Vec<_>>(),
            [first, second]
        );
        // A completed failed playlist attempt must not trap history forever.
        app.download_session.playlist_in_flight.remove(&first);
        app.apply_download_action(DownloadAction::ClearFinished, &ctx);
        assert!(app.download_queue.jobs.is_empty());
    }
    #[test]
    fn tools_ignore_old_runs_and_finish_only_the_matching_request() {
        use crate::music_downloads::tools::{ToolsProgress, ToolsResult};
        use crate::ui::download_tools::{ToolAction, ToolOperation};
        let mut app = app_with_downloads(true);
        let path = std::path::PathBuf::from("/test-fixtures/selected.flac");
        app.downloads.tools.add_paths([path.clone()]);
        let scope = app.download_scope().unwrap();
        app.apply_tools_action(ToolAction::Run(ToolOperation::Inspect), scope.clone());
        let request = app.downloads.tools.request;
        assert!(app.downloads.tools.busy);
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::ToolsProgress {
                request: request.wrapping_sub(1),
                progress: ToolsProgress {
                    completed: 1,
                    total: 1,
                    path: Some(path),
                    stage: "Old run".into(),
                },
            },
        });
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::ToolsFinished {
                request: request.wrapping_sub(1),
                result: ToolsResult::default(),
            },
        });
        assert!(app.downloads.tools.busy);
        assert!(app.downloads.tools.progress.is_none());
        app.apply_tools_action(ToolAction::RemoveSelected, scope.clone());
        assert_eq!(
            app.downloads.tools.paths.len(),
            1,
            "working inputs cannot be removed mid-operation"
        );
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::ToolsFinished {
                request,
                result: ToolsResult::default(),
            },
        });
        assert!(!app.downloads.tools.busy);
        app.apply_tools_action(ToolAction::RemoveSelected, scope);
        assert!(app.downloads.tools.paths.is_empty());
    }

    #[test]
    fn recent_lookups_use_committed_query_and_merge_with_initial_disk_history() {
        let mut app = app_with_downloads(false);
        let ctx = egui::Context::default();
        let scope = app.download_scope().unwrap();
        app.downloads.query = "The original lookup".into();
        app.apply_download_action(DownloadAction::Resolve, &ctx);
        let request = app.downloads.lookup_request;
        app.downloads.query = "Still typing something else".into();
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::Resolved {
                request,
                result: Ok(DownloadCollection {
                    tracks: vec![track("resolved")],
                    ..Default::default()
                }),
            },
        });
        let mut disk = QueueState::for_account(scope.account_id.clone());
        disk.recent_inputs = vec!["Older lookup".into()];
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::Loaded(Ok(disk)),
        });
        assert_eq!(
            app.downloads.recent_inputs,
            ["The original lookup", "Older lookup"]
        );
        assert_eq!(
            app.download_queue.recent_inputs,
            app.downloads.recent_inputs
        );
        app.handle_download_response(Response {
            scope,
            kind: ResponseKind::Resolved {
                request: request.wrapping_sub(1),
                result: Ok(DownloadCollection::default()),
            },
        });
        assert_eq!(
            app.download_queue.recent_inputs,
            ["The original lookup", "Older lookup"]
        );
        assert!(app.download_session.dirty);
    }

    #[test]
    fn album_gain_finalizes_new_files_per_album_and_preserves_retryable_receipts() {
        use crate::music_downloads::{AudioQuality, ExportReceipt};
        let mut app = app_with_downloads(true);
        let ids: Vec<_> = (0..4)
            .map(|index| enqueue(&mut app, &format!("gain-{index}")))
            .collect();
        for (index, job) in app.download_queue.jobs.iter_mut().enumerate() {
            job.batch_id = ids[0];
            job.track.album = if index == 3 {
                "Second album"
            } else {
                "First album"
            }
            .into();
            job.track.album_artist = "Artist".into();
            job.track.track_total = if index == 3 { 1 } else { 3 };
            job.options.replay_gain = true;
            job.options.replay_gain_mode = ReplayGainMode::Album;
            job.stage = JobStage::Completed;
            job.receipt = Some(JobReceipt {
                file: Some(ExportReceipt {
                    path: std::path::PathBuf::from(format!("/test-fixtures/gain-{index}.flac")),
                    bytes: 123,
                    album_gain_applied: false,
                    quality: AudioQuality::default(),
                    source_quality: AudioQuality::default(),
                    source: None,
                    skipped: index == 2,
                    sidecars: Vec::new(),
                    warnings: Vec::new(),
                }),
                ..Default::default()
            });
        }
        let scope = app.download_scope().unwrap();
        app.finalize_album_gain(&scope);
        assert_eq!(app.download_session.album_gain_in_flight.len(), 2);
        assert_eq!(app.download_session.album_gain_in_flight[&ids[0]], ids[..2]);
        assert_eq!(
            app.download_session.album_gain_in_flight[&ids[3]],
            vec![ids[3]]
        );
        assert_eq!(
            app.download_queue.jobs[2].stage,
            JobStage::Completed,
            "existing skipped file is never retagged"
        );
        assert!(
            app.download_queue.jobs[0]
                .receipt
                .as_ref()
                .unwrap()
                .file
                .as_ref()
                .unwrap()
                .warnings
                .iter()
                .any(|warning| warning.contains("selection only"))
        );
        app.handle_download_response(Response {
            scope: scope.clone(),
            kind: ResponseKind::AlbumGain {
                batch: ids[0],
                ids: ids[..2].to_vec(),
                result: Ok(()),
            },
        });
        assert!(app.download_queue.jobs[..2].iter().all(|job| {
            job.stage == JobStage::Completed
                && job
                    .receipt
                    .as_ref()
                    .unwrap()
                    .file
                    .as_ref()
                    .unwrap()
                    .album_gain_applied
        }));
        app.handle_download_response(Response {
            scope,
            kind: ResponseKind::AlbumGain {
                batch: ids[3],
                ids: vec![ids[3]],
                result: Err("test encoder error".into()),
            },
        });
        let failed = &app.download_queue.jobs[3];
        assert_eq!(failed.stage, JobStage::Failed);
        assert!(
            failed.receipt.as_ref().unwrap().file.is_some(),
            "a failed gain pass retains its downloaded file"
        );
        assert!(
            !failed
                .receipt
                .as_ref()
                .unwrap()
                .file
                .as_ref()
                .unwrap()
                .album_gain_applied
        );
        app.apply_download_action(DownloadAction::RetryFailed, &egui::Context::default());
        assert!(app.download_session.album_gain_attempts.is_empty());
        assert_eq!(app.download_queue.jobs[3].stage, JobStage::Queued);
    }
}
