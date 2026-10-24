//! Bridge between the UI thread and asynchronous work.
//!
//! egui runs on the main thread and must never block. A dedicated tokio
//! runtime hosts the librespot engine, the Web API client, sign-in, and
//! artwork fetches; the two sides talk through channels. Every event wakes
//! the interface with `request_repaint`, so the app stays event-driven and
//! idle when nothing is happening.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;

use crate::api::models::*;
use crate::api::{ApiError, ApiSource, NetActivity, PlayRequest};
use crate::credentials::Lease as CredentialLease;
use crate::credentials::Slot as CredentialSlot;
use crate::http::Http;
use crate::images::ArtLoader;
use crate::model::PlaylistCache;
use crate::paths::AppDirs;
use crate::player::{Engine, EngineConfig, LocalState, PlayerCommand};
use crate::settings::ProxyConfig;

pub type ApiResult<T> = Result<T, ApiError>;

pub const PLAYLIST_PAGE_SIZE: u32 = 50;

#[derive(Clone, Debug, PartialEq)]
pub enum AuthStatus {
    Starting,
    SignedOut,
    WaitingForBrowser { url: String },
    Connecting,
    Connected { username: String },
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RemoteAction {
    Play,
    Pause,
    Next,
    Previous,
    Seek,
    Volume,
    Shuffle,
    Repeat,
}

/// Which of the two readers of the recently-played endpoint an answer
/// belongs to: the shelf on Home, or the Recents tab in the queue panel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecentsFor {
    Home,
    Panel,
}

#[derive(Clone, Debug)]
pub enum ApiRequest {
    Me,
    Devices,
    PlaybackState {
        seq: u64,
    },
    Queue {
        seq: u64,
    },
    RecentlyPlayed {
        /// Request owner. Home and Recents use separate generation counters,
        /// so generation alone cannot route the response.
        who: RecentsFor,
        generation: u64,
        before: Option<String>,
        limit: u32,
    },
    TopTracks {
        offset: u32,
        full: bool,
        generation: u64,
    },
    TopArtists {
        generation: u64,
    },
    Recommendations {
        seed_tracks: Vec<String>,
        seed_artists: Vec<String>,
        generation: u64,
    },
    Discover {
        term: String,
        generation: u64,
    },
    /// The owner's YouTube Music Home shelves, from our music API only.
    YouTubeHome {
        generation: u64,
    },
    MyPlaylists {
        offset: u32,
        generation: u64,
    },
    Playlist {
        id: String,
        generation: u64,
    },
    PlaylistItems {
        id: String,
        offset: u32,
        generation: u64,
    },
    /// A slice of a playlist read only for who added its songs; the rows
    /// on screen stay untouched.
    PlaylistSample {
        id: String,
        offset: u32,
        generation: u64,
    },
    CreatePlaylist {
        name: String,
        public: bool,
        description: String,
    },
    UploadPlaylistCover {
        id: String,
        request: u64,
        previous_urls: Vec<String>,
        cover: crate::playlist_cover::Cover,
    },
    UpdatePlaylist {
        id: String,
        name: Option<String>,
        description: Option<String>,
        public: Option<bool>,
    },
    CheckPlaylistDuplicates {
        playlist_id: String,
        playlist_name: String,
        items: Vec<PlayableItem>,
        position: Option<u32>,
    },
    AddToPlaylist {
        playlist_id: String,
        playlist_name: String,
        uris: Vec<String>,
        position: Option<u32>,
    },
    RemoveFromPlaylist {
        playlist_id: String,
        uris: Vec<String>,
        snapshot_id: Option<String>,
    },
    ReorderPlaylist {
        playlist_id: String,
        range_start: u32,
        insert_before: u32,
        snapshot_id: Option<String>,
    },
    FollowPlaylist {
        id: String,
        follow: bool,
    },
    SavedTracks {
        offset: u32,
        generation: u64,
    },
    SavedAlbums {
        offset: u32,
    },
    FollowedArtists {
        after: Option<String>,
    },
    SavedShows {
        offset: u32,
    },
    SavedEpisodes {
        offset: u32,
    },
    SetSaved {
        uris: Vec<String>,
        saved: bool,
    },
    Contains {
        uris: Vec<String>,
    },
    Search {
        query: String,
        serial: u64,
    },
    SearchCatalogue {
        query: String,
        serial: u64,
    },
    SearchPlaylists {
        query: String,
        serial: u64,
    },
    Artist {
        id: String,
    },
    ArtistTopTracks {
        id: String,
    },
    ArtistAlbums {
        id: String,
        groups: String,
        offset: u32,
    },
    RelatedArtists {
        id: String,
    },
    Album {
        id: String,
    },
    AlbumTracks {
        id: String,
        offset: u32,
        generation: u64,
    },
    AlbumQueueTracks {
        id: String,
        offset: u32,
        request: u64,
    },
    Show {
        id: String,
    },
    ShowEpisodes {
        id: String,
        offset: u32,
    },
    /// The newest episodes of a few saved podcasts, for Home. The shows
    /// are read one after another, not all at once.
    HomeEpisodes {
        shows: Vec<Show>,
        generation: u64,
    },
    Track {
        id: String,
    },
    /// One episode, asked for by a link to it: the podcast it belongs to
    /// is the page that opens.
    Episode {
        id: String,
    },
    Remote {
        action: RemoteAction,
        device_id: Option<String>,
        play: Option<PlayRequest>,
        position_ms: u32,
        percent: u8,
        flag: bool,
        repeat: String,
    },
    Transfer {
        device_id: String,
        play: bool,
    },
    /// Shuffle on, then start the context, one after the other: sent as two
    /// independent requests they race, and shuffle sometimes lost.
    ShufflePlay {
        device_id: Option<String>,
        play: PlayRequest,
    },
    AddToQueue {
        uri: String,
        device_id: Option<String>,
        label: String,
    },
    AddManyToQueue {
        request: u64,
        uris: Vec<String>,
        device_id: Option<String>,
    },
}

#[derive(Debug)]
pub enum ApiResponse {
    Me(ApiResult<User>),
    Devices(ApiResult<Vec<Device>>),
    PlaybackState {
        seq: u64,
        result: ApiResult<Option<PlaybackState>>,
    },
    Queue {
        seq: u64,
        result: ApiResult<Queue>,
    },
    RecentlyPlayed {
        who: RecentsFor,
        generation: u64,
        limit: u32,
        result: ApiResult<CursorPage<PlayHistory>>,
    },
    TopTracks {
        offset: u32,
        full: bool,
        generation: u64,
        result: ApiResult<Page<Track>>,
    },
    TopArtists {
        generation: u64,
        result: ApiResult<Vec<Artist>>,
    },
    Recommendations {
        generation: u64,
        result: ApiResult<Vec<Track>>,
    },
    Discover {
        term: String,
        generation: u64,
        result: ApiResult<Vec<Playlist>>,
    },
    YouTubeHome {
        generation: u64,
        result: ApiResult<Vec<HomeShelf>>,
    },
    MyPlaylists {
        offset: u32,
        generation: u64,
        result: ApiResult<Page<Playlist>>,
    },
    Playlist {
        id: String,
        generation: u64,
        result: ApiResult<Playlist>,
    },
    PlaylistItems {
        id: String,
        offset: u32,
        generation: u64,
        result: ApiResult<Page<PlaylistItem>>,
    },
    PlaylistSample {
        id: String,
        generation: u64,
        result: ApiResult<Page<PlaylistItem>>,
    },
    PlaylistCreated(ApiResult<Playlist>),
    PlaylistCoverUploaded {
        id: String,
        request: u64,
        previous_urls: Vec<String>,
        cover: crate::playlist_cover::Cover,
        result: ApiResult<()>,
    },
    PlaylistUpdated {
        id: String,
        result: ApiResult<()>,
    },
    PlaylistDuplicatesChecked {
        playlist_id: String,
        playlist_name: String,
        items: Vec<PlayableItem>,
        position: Option<u32>,
        result: ApiResult<Vec<String>>,
    },
    PlaylistItemsChanged {
        id: String,
        message: String,
        result: ApiResult<Option<String>>,
    },
    PlaylistFollowChanged {
        id: String,
        followed: bool,
        result: ApiResult<()>,
    },
    SavedTracks {
        offset: u32,
        generation: u64,
        account_id: Option<String>,
        result: ApiResult<Page<SavedTrack>>,
    },
    SavedAlbums {
        offset: u32,
        result: ApiResult<Page<SavedAlbum>>,
    },
    FollowedArtists {
        after: Option<String>,
        result: ApiResult<CursorPage<Artist>>,
    },
    SavedShows {
        offset: u32,
        result: ApiResult<Page<SavedShow>>,
    },
    SavedEpisodes {
        offset: u32,
        result: ApiResult<Page<SavedEpisode>>,
    },
    SavedChanged {
        uris: Vec<String>,
        saved: bool,
        result: ApiResult<()>,
    },
    Contains {
        uris: Vec<String>,
        result: ApiResult<Vec<bool>>,
    },
    SearchStarted {
        query: String,
        serial: u64,
        split: bool,
    },
    Search {
        query: String,
        serial: u64,
        result: ApiResult<SearchResults>,
    },
    SearchPlaylists {
        query: String,
        serial: u64,
        result: ApiResult<Page<Playlist>>,
    },
    Artist {
        id: String,
        result: ApiResult<Artist>,
    },
    ArtistTopTracks {
        id: String,
        result: ApiResult<Vec<Track>>,
    },
    ArtistAlbums {
        id: String,
        groups: String,
        offset: u32,
        result: ApiResult<Page<Album>>,
    },
    RelatedArtists {
        id: String,
        result: ApiResult<Vec<Artist>>,
    },
    Album {
        id: String,
        result: ApiResult<Album>,
    },
    AlbumTracks {
        id: String,
        offset: u32,
        generation: u64,
        result: ApiResult<Page<Track>>,
    },
    AlbumQueueTracks {
        offset: u32,
        request: u64,
        result: ApiResult<Page<Track>>,
    },
    Show {
        id: String,
        result: ApiResult<Show>,
    },
    ShowEpisodes {
        id: String,
        offset: u32,
        result: ApiResult<Page<Episode>>,
    },
    /// Each show with its newest episodes, in the order asked for.
    HomeEpisodes {
        generation: u64,
        result: ApiResult<Vec<(Show, Vec<Episode>)>>,
    },
    Track {
        id: String,
        result: ApiResult<Track>,
    },
    Episode {
        id: String,
        result: ApiResult<Episode>,
    },
    Remote {
        action: RemoteAction,
        result: ApiResult<()>,
    },
    Transferred {
        device_id: String,
        result: ApiResult<()>,
    },
    QueueAdded {
        label: String,
        result: ApiResult<()>,
    },
    QueueBatchAdded {
        request: u64,
        added: usize,
        result: ApiResult<()>,
    },
}

pub enum PlaylistCacheRows {
    Replace(Vec<PlaylistItem>),
    Append {
        previous_rows: usize,
        previous_offset: u32,
        items: Vec<PlaylistItem>,
    },
}

pub enum Command {
    Downloads(crate::download_tasks::Request),
    MusicSignIn {
        email: String,
        password: String,
    },
    OpenThemesFolder,
    ProxyRestored {
        lease: CredentialLease,
        result: Result<crate::credentials::Loaded, crate::credentials::Error>,
    },
    CredentialsRestored {
        slot: CredentialSlot,
        lease: CredentialLease,
        result: Result<crate::credentials::Loaded, crate::credentials::Error>,
    },
    CheckPlaylistCover {
        id: String,
        request: u64,
        cover: crate::playlist_cover::Cover,
        images: Vec<crate::api::models::Image>,
    },
    ChoosePlaylistCover {
        id: String,
        request: u64,
        selected:
            std::pin::Pin<Box<dyn std::future::Future<Output = Option<rfd::FileHandle>> + Send>>,
    },
    /// Start (or restart) the Web API sign-in in the browser.
    SignIn {
        request: u64,
        config: ProxyConfig,
    },
    CancelSignIn,
    SignOut,
    /// Authorize local playback on this computer (a separate browser grant).
    AuthorizePlayback,
    /// Reload the engine config (audio settings changed).
    RestartEngine(EngineConfig),
    /// Rebuild the HTTP client. Restart local playback only when its HTTP
    /// proxy changed; Off, System, and SOCKS5 share a direct engine connection.
    ApplyProxy {
        request: u64,
        config: ProxyConfig,
    },
    Player(PlayerCommand),
    Api(ApiRequest),
    ApiFinished {
        generation: u64,
        response: Box<ApiResponse>,
        expired: Option<ApiSource>,
        shared_lease: CredentialLease,
        personal_lease: CredentialLease,
    },
    Shutdown,
    /// Internal: the Web API browser flow produced a grant.
    WebSignedIn {
        source: ApiSource,
        token: Box<crate::auth::StoredToken>,
        lease: CredentialLease,
        attempt: u64,
    },
    WebVerified {
        source: ApiSource,
        token: Box<crate::auth::StoredToken>,
        user: Box<User>,
        lease: CredentialLease,
        attempt: u64,
    },
    WebVerificationFailed {
        source: ApiSource,
        lease: CredentialLease,
        attempt: u64,
        error: ApiError,
    },
    /// Internal: a Web API browser flow or verification ended (success or not).
    SignInEnded {
        source: ApiSource,
        attempt: u64,
    },
    /// Internal: the playback browser flow ended without a credential.
    PlaybackAuthEnded {
        attempt: u64,
    },
    /// Internal: the playback grant produced a streaming access token.
    PlaybackAuthorized {
        access_token: String,
        lease: CredentialLease,
        attempt: u64,
    },
    /// Internal: an engine connection attempt finished.
    EngineConnected {
        session_generation: u64,
        engine: Box<Option<Engine>>,
        error: Option<String>,
        lease: CredentialLease,
    },
    /// Internal: librespot's session ended on its own.
    Reconnect,
    /// Look for Spotify Connect receivers on the local network.
    DiscoverReceivers,
    /// Send the account to a receiver so it joins Spotify Connect.
    ActivateReceiver(Box<crate::zeroconf::Receiver>),
    /// Ask GitHub whether a newer release exists. Manual checks report every
    /// outcome; the daily check only announces a new release.
    CheckForUpdates {
        manual: bool,
        source: crate::updates::Source,
    },
    InspectUpdate,
    DownloadUpdate {
        release: crate::updates::Release,
        source: crate::updates::Source,
    },
    InstallUpdate {
        prepared: Box<crate::updates::Prepared>,
        arguments: Vec<String>,
    },
    /// The words of a track, from LRCLIB.
    Lyrics(Box<LyricsRequest>),
    /// The account's playlist tree, folders and all, from the session.
    Rootlist,
    /// Internal: a rootlist read completed for this signed-in session.
    RootlistFinished {
        generation: u64,
        result: Result<crate::player::Rootlist, String>,
    },
    /// Check that a reconnect's pickup really started, and try again if not.
    VerifyResume,
    /// Add, replace, or remove the optional personal Web API application.
    ConfigurePersonalWebApp(Option<String>),
    /// Read a playlist's cached items from disk.
    LoadPlaylistCache {
        id: String,
        generation: u64,
    },
    /// Remember a playlist prefix on disk under its snapshot.
    StorePlaylistCache {
        id: String,
        generation: u64,
        snapshot: String,
        rows: PlaylistCacheRows,
        total: u32,
        next_offset: Option<u32>,
    },
    /// Resolve user ids to display names through the streaming session.
    UserNames(Vec<String>),
    LoadLikedSongsCache {
        generation: u64,
    },
    StoreLikedSongsCache(crate::liked::Cache),
    /// Resolve the precise type of Web API singles through the streaming session.
    AlbumTypes(Vec<String>),
    /// Ask the streaming session which saved shows are audiobooks.
    AudiobookShows(Vec<String>),
    /// Resolve Spotify's radio seeded by `seed` through the streaming session.
    Radio {
        seed: String,
        generation: u64,
    },
    /// Internal: a radio finished resolving for the session it started in.
    RadioResolved {
        session_generation: u64,
        seed: String,
        generation: u64,
        result: Result<Vec<crate::api::models::Track>, String>,
    },
    /// Internal: an audiobook lookup finished for the session it started in.
    AudiobookShowsResolved {
        session_generation: u64,
        audiobooks: Vec<String>,
    },
    /// Internal: one precise album type lookup finished.
    AlbumTypeResolved {
        uri: String,
        session_generation: u64,
        engine_generation: u64,
        result: Result<bool, String>,
    },
}

pub struct LyricsRequest {
    /// The track the answer is for, so a stale one is ignored.
    pub uri: String,
    pub query: crate::lyrics::Query,
}

pub enum Event {
    Downloads(Box<crate::download_tasks::Response>),
    ProxyRestored {
        config: ProxyConfig,
        password: Option<crate::credentials::ProxyPassword>,
    },
    ProxyPasswordStored,
    ProxyStorageFailed(crate::credentials::Error),
    ProxyApplied {
        request: u64,
        config: ProxyConfig,
        result: Result<bool, String>,
    },
    UpdateSupport(Result<crate::updates::Installation, String>),
    UpdateProgress {
        received: u64,
        total: u64,
    },
    UpdateDownloaded(Result<Box<crate::updates::Prepared>, String>),
    UpdateInstalling(Result<(), String>),
    PlaylistCoverChecked {
        id: String,
        request: u64,
        images: Vec<crate::api::models::Image>,
        result: Result<bool, String>,
    },
    PlaylistCoverChosen {
        id: String,
        request: u64,
        result: Result<Option<crate::playlist_cover::Cover>, String>,
    },
    Auth(AuthStatus),
    Playback(LocalPlayback),
    /// Receivers seen on the local network that Spotify has not listed.
    Receivers(Vec<crate::zeroconf::Receiver>),
    ReceiverActivated {
        name: String,
        result: Result<(), String>,
    },
    Local(Box<LocalState>),
    Api(Box<ApiResponse>),
    Error(String),
    /// GitHub answered an update check, or the request failed.
    UpdateChecked {
        manual: bool,
        result: Result<Option<crate::updates::Release>, String>,
    },
    /// Track lyrics, or `None` when unavailable.
    Lyrics {
        uri: String,
        result: Result<Option<crate::lyrics::Lyrics>, String>,
    },
    /// The account's playlist tree, folders and all, and which of its
    /// playlists take songs from this account.
    Rootlist {
        result: Result<crate::player::Rootlist, String>,
    },
    /// The result of reading a playlist cache for this load generation.
    PlaylistCache {
        account_id: String,
        id: String,
        generation: u64,
        cache: Option<PlaylistCache>,
    },
    PlaylistCacheStored {
        account_id: String,
        id: String,
        generation: u64,
        snapshot: String,
        success: bool,
    },
    /// A user id resolved to a display name (`None` when nothing answers).
    UserName {
        id: String,
        name: Option<String>,
    },
    /// Saved shows that Spotify's metadata marks as audiobooks. librespot
    /// cannot play them, so the Podcasts shelf leaves them out.
    AudiobookShows(Vec<String>),
    /// The songs of the radio seeded by `seed`, for the request `generation`.
    Radio {
        seed: String,
        generation: u64,
        result: Result<Vec<crate::api::models::Track>, String>,
    },
    /// Whether Spotify's internal metadata positively identifies an album as an EP.
    AlbumType {
        uri: String,
        result: Result<bool, String>,
    },
    /// The verified personal Web API app, or `None` when it is disabled.
    WebApp {
        client_id: Option<String>,
    },
    LikedSongsCache {
        account_id: String,
        generation: u64,
        cache: Option<crate::liked::Cache>,
    },
}

/// The state of playback on this computer, independent of Web API sign-in.
#[derive(Clone, Debug, PartialEq)]
pub enum LocalPlayback {
    /// Not authorized; local playback is unavailable but the app still works.
    Unavailable,
    /// The browser is open for the playback grant.
    Authorizing,
    /// Connecting the librespot engine.
    Connecting,
    /// This computer is a ready Spotify Connect device.
    Ready {
        device_id: String,
    },
    Failed(String),
}

/// Background services (the runtime, MPRIS, the tray) outlive individual
/// windows: the window is destroyed when it closes to the tray and created
/// again on demand. They therefore hold this handle, which repaints
/// whichever window exists, instead of an `egui::Context`.
pub use fastframe_shell::Waker;

/// The interface's handle to the runtime.
pub struct Backend {
    commands: mpsc::UnboundedSender<Command>,
    events: std::sync::mpsc::Receiver<Event>,
    art: ArtLoader,
    activity: Arc<NetActivity>,
    thread: Option<std::thread::JoinHandle<()>>,
    offline: bool,
    #[cfg(test)]
    playlist_item_requests: std::sync::Mutex<Vec<(String, u32, u64)>>,
    #[cfg(test)]
    playlist_sample_requests: std::sync::Mutex<Vec<(String, u32, u64)>>,
    #[cfg(test)]
    playlist_add_requests: std::sync::Mutex<Vec<ApiRequest>>,
    #[cfg(test)]
    remote_play_requests: std::sync::Mutex<Vec<ApiRequest>>,
    #[cfg(test)]
    remote_shuffle_requests: std::sync::Mutex<Vec<ApiRequest>>,
    #[cfg(test)]
    queue_requests: std::sync::Mutex<Vec<ApiRequest>>,
    #[cfg(test)]
    queued_tracks: std::sync::Mutex<Vec<String>>,
    #[cfg(test)]
    player_commands: std::sync::Mutex<Vec<PlayerCommand>>,
    #[cfg(test)]
    album_type_requests: std::sync::Mutex<Vec<Vec<String>>>,
    #[cfg(test)]
    home_episode_requests: std::sync::Mutex<Vec<(Vec<String>, u64)>>,
}

impl Backend {
    pub fn spawn(
        dirs: AppDirs,
        engine_config: EngineConfig,
        _web_client_id: Option<String>,
        waker: Waker,
        restore_sign_in: bool,
    ) -> Self {
        let (command_tx, command_rx) = mpsc::unbounded_channel();
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("spotifast-runtime")
            .enable_all()
            .build()
            .expect("unable to start the async runtime");
        let http = {
            let event_tx = event_tx.clone();
            let waker = waker.clone();
            Http::build_in_background(engine_config.proxy.clone(), move |error| {
                let _ = event_tx.send(Event::Error(format!(
                    "Network configuration failed: {error}"
                )));
                waker.wake();
            })
        };
        let art = ArtLoader::new(http.clone(), runtime.handle().clone(), dirs.art_cache_dir());
        let legacy_art = dirs.legacy_art_cache_dir();
        runtime.spawn_blocking(move || {
            let _ = std::fs::remove_dir_all(legacy_art);
        });
        let activity = Arc::new(NetActivity::default());

        let thread = std::thread::Builder::new()
            .name("spotifast-backend".to_string())
            .spawn(move || {
                runtime.block_on(async move {
                    crate::music_backend::run(
                        dirs,
                        engine_config,
                        http,
                        event_tx,
                        waker,
                        restore_sign_in,
                        command_rx,
                    )
                    .await;
                });
                // Give librespot's own threads a moment to release the audio device.
                runtime.shutdown_timeout(Duration::from_secs(2));
            })
            .expect("unable to start the backend thread");

        Self {
            commands: command_tx,
            events: event_rx,
            art,
            activity,
            thread: Some(thread),
            offline: false,
            #[cfg(test)]
            playlist_item_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            playlist_sample_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            playlist_add_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            remote_play_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            remote_shuffle_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            queue_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            queued_tracks: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            player_commands: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            album_type_requests: std::sync::Mutex::new(Vec::new()),
            #[cfg(test)]
            home_episode_requests: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Live network activity, for the interface's busy indicator.
    pub fn activity(&self) -> &NetActivity {
        &self.activity
    }

    /// Stops Spotify-bound commands from leaving the process; shutdown and
    /// update controls still work. Used by demo mode and headless tests.
    #[cfg_attr(not(any(test, feature = "demo")), allow(dead_code))]
    pub fn set_offline(&mut self, offline: bool) {
        self.offline = offline;
    }

    pub fn send(&self, command: Command) {
        if self.offline
            && !matches!(
                command,
                Command::Shutdown
                    | Command::CheckForUpdates { .. }
                    | Command::InspectUpdate
                    | Command::DownloadUpdate { .. }
                    | Command::InstallUpdate { .. }
            )
        {
            return;
        }
        let _ = self.commands.send(command);
    }

    /// Construct the native dialog on the UI thread, then await and read it
    /// on the runtime. AppKit requires its window lookup on the main thread.
    pub fn choose_playlist_cover(&self, id: String, request: u64) {
        if self.offline {
            return;
        }
        let selected = rfd::AsyncFileDialog::new()
            .set_title("Choose playlist cover")
            .add_filter("JPEG or PNG image", &["jpg", "jpeg", "png"])
            .pick_file();
        self.send(Command::ChoosePlaylistCover {
            id,
            request,
            selected: Box::pin(selected),
        });
    }

    pub fn api(&self, request: ApiRequest) {
        #[cfg(test)]
        if matches!(
            request,
            ApiRequest::AlbumQueueTracks { .. }
                | ApiRequest::AddToQueue { .. }
                | ApiRequest::AddManyToQueue { .. }
        ) {
            self.queue_requests.lock().unwrap().push(request.clone());
        }
        #[cfg(test)]
        if matches!(
            request,
            ApiRequest::Remote {
                action: RemoteAction::Play,
                ..
            } | ApiRequest::ShufflePlay { .. }
        ) {
            self.remote_play_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.clone());
        }
        #[cfg(test)]
        if matches!(
            request,
            ApiRequest::Remote {
                action: RemoteAction::Shuffle,
                ..
            }
        ) {
            self.remote_shuffle_requests
                .lock()
                .unwrap()
                .push(request.clone());
        }
        #[cfg(test)]
        if matches!(
            request,
            ApiRequest::AddToPlaylist { .. }
                | ApiRequest::CheckPlaylistDuplicates { .. }
                | ApiRequest::UpdatePlaylist { .. }
        ) {
            self.playlist_add_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.clone());
        }
        #[cfg(test)]
        if let ApiRequest::PlaylistItems {
            id,
            offset,
            generation,
        } = &request
        {
            self.playlist_item_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((id.clone(), *offset, *generation));
        }
        #[cfg(test)]
        if let ApiRequest::PlaylistSample {
            id,
            offset,
            generation,
        } = &request
        {
            self.playlist_sample_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((id.clone(), *offset, *generation));
        }
        #[cfg(test)]
        if let ApiRequest::HomeEpisodes { shows, generation } = &request {
            self.home_episode_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push((
                    shows.iter().map(|show| show.id.clone()).collect(),
                    *generation,
                ));
        }
        self.send(Command::Api(request));
    }

    #[cfg(test)]
    pub(crate) fn take_home_episode_requests(&self) -> Vec<(Vec<String>, u64)> {
        std::mem::take(
            &mut *self
                .home_episode_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    #[cfg(test)]
    pub fn take_playlist_item_requests(&self) -> Vec<(String, u32, u64)> {
        std::mem::take(
            &mut *self
                .playlist_item_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    #[cfg(test)]
    pub fn take_playlist_sample_requests(&self) -> Vec<(String, u32, u64)> {
        std::mem::take(
            &mut *self
                .playlist_sample_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    #[cfg(test)]
    pub fn take_playlist_add_requests(&self) -> Vec<ApiRequest> {
        std::mem::take(
            &mut *self
                .playlist_add_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    #[cfg(test)]
    pub fn take_remote_play_requests(&self) -> Vec<ApiRequest> {
        std::mem::take(
            &mut *self
                .remote_play_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    #[cfg(test)]
    pub fn take_remote_shuffle_requests(&self) -> Vec<ApiRequest> {
        std::mem::take(&mut *self.remote_shuffle_requests.lock().unwrap())
    }

    #[cfg(test)]
    pub(crate) fn take_queue_requests(&self) -> Vec<ApiRequest> {
        std::mem::take(&mut *self.queue_requests.lock().unwrap())
    }

    #[cfg(test)]
    pub(crate) fn take_queued_tracks(&self) -> Vec<String> {
        std::mem::take(&mut *self.queued_tracks.lock().unwrap())
    }

    #[cfg(test)]
    pub(crate) fn take_player_commands(&self) -> Vec<PlayerCommand> {
        std::mem::take(&mut *self.player_commands.lock().unwrap())
    }

    pub fn player(&self, command: PlayerCommand) {
        #[cfg(test)]
        self.player_commands.lock().unwrap().push(command.clone());
        #[cfg(test)]
        if let PlayerCommand::AddToQueue(uri) = &command {
            self.queued_tracks.lock().unwrap().push(uri.clone());
        }
        self.send(Command::Player(command));
    }

    pub(crate) fn album_types(&self, uris: Vec<String>) {
        #[cfg(test)]
        self.album_type_requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(uris.clone());
        self.send(Command::AlbumTypes(uris));
    }

    #[cfg(test)]
    pub(crate) fn take_album_type_requests(&self) -> Vec<Vec<String>> {
        std::mem::take(
            &mut *self
                .album_type_requests
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    pub fn poll(&self) -> Vec<Event> {
        self.events.try_iter().collect()
    }

    pub fn art(&self) -> &ArtLoader {
        &self.art
    }

    pub fn shutdown(&mut self) {
        self.send(Command::Shutdown);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
