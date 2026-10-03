//! Native playback of the music service's signed HTTP media.
//!
//! FFmpeg decodes through a private, short-lived loopback bridge. Only the bridge
//! knows the signed media URL; credentials never enter process arguments. Range
//! requests pass through reqwest, so seeking does not download the whole track.
//! Eight PCM blocks bound buffering to under half a second. The audio callback
//! never waits for HTTP, decoding, or a pipe read.

use std::collections::VecDeque;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use rand::seq::SliceRandom;
use rodio::Source;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::watch;

use crate::backend::{Event, Waker};
use crate::music_api::{MusicApi, MusicSong};
use crate::player::{EngineConfig, LoadSpec, LocalState, Playback, PlayerCommand, RepeatMode};

const RATE: u32 = 44_100;
const CHANNELS: u16 = 2;
const BLOCK_SAMPLES: usize = 2048;
const BUFFER_BLOCKS: usize = 8;

#[derive(Default)]
struct QueuePlan {
    context: Option<String>,
    tracks: Vec<String>,
    order: Vec<usize>,
    cursor: Option<usize>,
    manual: VecDeque<String>,
    history: Vec<String>,
    current: Option<String>,
}

impl QueuePlan {
    fn load(&mut self, spec: &LoadSpec, tracks: Vec<String>, shuffle: bool) {
        let start = spec
            .offset_uri
            .as_ref()
            .and_then(|uri| tracks.iter().position(|t| t == uri))
            .or(spec.offset_index.map(|n| n as usize))
            .unwrap_or(0)
            .min(tracks.len().saturating_sub(1));
        *self = Self {
            context: spec.context_uri.clone(),
            tracks,
            ..Self::default()
        };
        self.order = (0..self.tracks.len()).collect();
        if !self.tracks.is_empty() {
            if shuffle {
                self.order.swap(0, start);
                self.order[1..].shuffle(&mut rand::rng());
                self.cursor = Some(0);
            } else {
                self.cursor = Some(start);
            }
            self.current = Some(self.tracks[self.order[self.cursor.unwrap()]].clone());
        }
    }

    fn advance(&mut self, repeat: RepeatMode, automatic: bool) -> Option<String> {
        if automatic && repeat == RepeatMode::Track {
            return self.current.clone();
        }
        let next = if let Some(uri) = self.manual.pop_front() {
            Some(uri)
        } else {
            let next = self.cursor.map_or(0, |n| n + 1);
            let next = if next < self.order.len() {
                Some(next)
            } else if repeat == RepeatMode::Context && !self.order.is_empty() {
                Some(0)
            } else {
                None
            };
            next.map(|n| {
                self.cursor = Some(n);
                self.tracks[self.order[n]].clone()
            })
        };
        if let Some(uri) = next.as_ref() {
            if let Some(previous) = self.current.replace(uri.clone()) {
                self.history.push(previous);
                if self.history.len() > 1000 {
                    self.history.remove(0);
                }
            }
        }
        next
    }

    fn previous(&mut self) -> Option<String> {
        let previous = self.history.pop()?;
        if let Some(current) = self.current.replace(previous.clone()) {
            self.manual.push_front(current);
        }
        Some(previous)
    }

    fn upcoming(&self) -> Vec<String> {
        self.manual
            .iter()
            .cloned()
            .chain(
                self.order
                    .iter()
                    .skip(self.cursor.map_or(0, |n| n + 1))
                    .map(|n| self.tracks[*n].clone()),
            )
            .collect()
    }

    fn shuffle(&mut self, enabled: bool) {
        let current_index = self.cursor.and_then(|n| self.order.get(n).copied());
        self.order = (0..self.tracks.len()).collect();
        if let Some(current_index) = current_index {
            if enabled {
                self.order.swap(0, current_index);
                self.order[1..].shuffle(&mut rand::rng());
                self.cursor = Some(0);
            } else {
                self.cursor = Some(current_index);
            }
        }
    }
}

struct Lifetime {
    cancelled: AtomicBool,
    decode_failed: AtomicBool,
    signal: watch::Sender<bool>,
    child: Mutex<Option<Child>>,
}

impl Lifetime {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            decode_failed: AtomicBool::new(false),
            signal: watch::channel(false).0,
            child: Mutex::new(None),
        })
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.signal.send_replace(true);
        if let Some(mut child) = self.child.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = child.kill();
            // Reaping must not hold up the command receiver.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
    }
    fn install(&self, mut child: Child) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap_or_else(|p| p.into_inner());
        if self.cancelled.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Playback cancelled".into());
        }
        *slot = Some(child);
        Ok(())
    }
}

impl Drop for Lifetime {
    fn drop(&mut self) {
        self.cancel();
    }
}

struct AudioSource {
    blocks: mpsc::Receiver<Vec<f64>>,
    current: Vec<f64>,
    offset: usize,
    lifetime: Arc<Lifetime>,
    consumed: Arc<AtomicU64>,
    tap: Arc<crate::vis::AudioTap>,
    eq: crate::eq::Processor,
    limiter: crate::limiter::Limiter,
    duration: Option<Duration>,
}

impl Iterator for AudioSource {
    type Item = f32;
    fn next(&mut self) -> Option<f32> {
        if self.lifetime.cancelled.load(Ordering::Acquire) {
            return None;
        }
        if self.offset >= self.current.len() {
            match self.blocks.try_recv() {
                Ok(mut block) => {
                    self.eq.process(&mut block);
                    self.tap.push(&block, 1.0);
                    self.limiter.process(&mut block, 1.0);
                    self.current = block;
                    self.offset = 0;
                }
                // A slow network inserts silence without advancing the song's
                // clock; it cannot block CoreAudio's real-time callback.
                Err(mpsc::TryRecvError::Empty) => return Some(0.0),
                Err(mpsc::TryRecvError::Disconnected) => return None,
            }
        }
        let sample = self.current[self.offset] as f32;
        self.offset += 1;
        self.consumed.fetch_add(1, Ordering::Relaxed);
        Some(sample)
    }
}

impl Source for AudioSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> u16 {
        CHANNELS
    }
    fn sample_rate(&self) -> u32 {
        RATE
    }
    fn total_duration(&self) -> Option<Duration> {
        self.duration
    }
}

impl Drop for AudioSource {
    fn drop(&mut self) {
        self.lifetime.cancel();
    }
}

enum AudioCommand {
    Load {
        generation: u64,
        source: AudioSource,
        position: u32,
        playing: bool,
        volume: u16,
    },
    Pause(bool),
    Volume(u16),
    Stop,
    Shutdown,
}
enum AudioReport {
    Started(u64),
    Position(u64, u32),
    Ended(u64),
    Failed(u64, String),
}
enum Prepared {
    Context(u64, LoadSpec, Result<Vec<String>, String>),
    Song(u64, MusicSong, AudioSource),
    Failed(u64, String),
}

pub struct MusicPlayer {
    api: MusicApi,
    config: EngineConfig,
    events: mpsc::Sender<Event>,
    waker: Waker,
    state: LocalState,
    queue: QueuePlan,
    generation: u64,
    lifetime: Option<Arc<Lifetime>>,
    preparation: Option<tokio::task::JoinHandle<()>>,
    prepared_tx: tokio::sync::mpsc::UnboundedSender<Prepared>,
    prepared_rx: tokio::sync::mpsc::UnboundedReceiver<Prepared>,
    ready: Arc<tokio::sync::Notify>,
    audio: mpsc::Sender<AudioCommand>,
    reports: mpsc::Receiver<AudioReport>,
    desired_play: bool,
    start_position: u32,
    ffmpeg: PathBuf,
    last_position_event: Instant,
}

impl MusicPlayer {
    pub async fn new(
        api: MusicApi,
        config: EngineConfig,
        events: mpsc::Sender<Event>,
        waker: Waker,
    ) -> Result<Self, String> {
        let ffmpeg = find_ffmpeg()?;
        let (audio, commands) = mpsc::channel();
        let (reports_tx, reports) = mpsc::channel();
        let audio_config = config.clone();
        let ready = Arc::new(tokio::sync::Notify::new());
        let audio_ready = ready.clone();
        std::thread::Builder::new()
            .name("music-output".into())
            .spawn(move || audio_thread(commands, reports_tx, audio_config, audio_ready))
            .map_err(|e| format!("Couldn't start audio output: {e}"))?;
        let (prepared_tx, prepared_rx) = tokio::sync::mpsc::unbounded_channel();
        let state = LocalState {
            connected: true,
            volume: config.initial_volume,
            active_client: config.device_name.clone(),
            ..LocalState::default()
        };
        Ok(Self {
            api,
            config,
            events,
            waker,
            state,
            queue: QueuePlan::default(),
            generation: 0,
            lifetime: None,
            preparation: None,
            prepared_tx,
            prepared_rx,
            ready,
            audio,
            reports,
            desired_play: false,
            start_position: 0,
            ffmpeg,
            last_position_event: Instant::now(),
        })
    }

    pub fn local_state(&self) -> LocalState {
        self.state.clone()
    }
    pub fn wake_signal(&self) -> Arc<tokio::sync::Notify> {
        self.ready.clone()
    }
    pub fn queue_uris(&self) -> Vec<String> {
        self.queue.upcoming()
    }
    pub fn context_uri(&self) -> Option<&str> {
        self.queue.context.as_deref()
    }

    fn emit(&self) {
        let _ = self.events.send(Event::Local(Box::new(self.state.clone())));
        self.waker.wake();
    }
    fn fail(&mut self, message: String) {
        self.cancel();
        self.state.playback = Playback::Stopped;
        self.state.position_at = None;
        self.state.error = Some(message.clone());
        let _ = self.events.send(Event::Error(message));
        self.emit();
    }
    fn cancel(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(task) = self.preparation.take() {
            task.abort();
        }
        if let Some(lifetime) = self.lifetime.take() {
            lifetime.cancel();
        }
        let _ = self.audio.send(AudioCommand::Stop);
        self.config.tap.clear();
    }

    fn load_current(&mut self, position: u32, playing: bool) {
        self.prepare_current(position, playing, true);
    }

    fn prepare_current(&mut self, position: u32, playing: bool, new_track: bool) {
        self.cancel();
        let Some(uri) = self.queue.current.clone() else {
            self.state.playback = Playback::Stopped;
            self.state.track = None;
            self.state.position_at = None;
            self.emit();
            return;
        };
        // A restored station always joins the current broadcast; radio has no
        // meaningful saved seek position.
        let position = if uri.starts_with("spotify:track:radio:") {
            0
        } else {
            position
        };
        self.desired_play = playing;
        self.start_position = position;
        self.state.playback = Playback::Loading;
        self.state.position_ms = position;
        self.state.position_at = None;
        self.state.error = None;
        if new_track {
            self.state.track_sequence = self.state.track_sequence.wrapping_add(1);
        }
        self.emit();
        let generation = self.generation;
        let lifetime = Lifetime::new();
        self.lifetime = Some(lifetime.clone());
        let api = self.api.clone();
        let prepared = self.prepared_tx.clone();
        let ready = self.ready.clone();
        let ffmpeg = self.ffmpeg.clone();
        let config = self.config.clone();
        self.preparation = Some(tokio::spawn(async move {
            let result = async {
                let started = Instant::now();
                let song = api.resolve_song(&uri).await?;
                let resolved = started.elapsed();
                // Ogg/Opus otherwise probes the end of a seekable HTTP file
                // for duration before emitting audio. We already have the
                // duration; a fresh play can decode sequentially in one GET.
                // Keep byte seeking for seeks and containers such as M4A,
                // whose index may live at the end of the file.
                let live = song.source.as_deref() == Some("radio");
                let sequential = live || sequential_start(&song.audio_url, position);
                // Public live URLs have no account credentials. FFmpeg must resolve
                // HLS variant playlists and segments relative to their real origin.
                // Signed library and podcast URLs still use the private bridge.
                let bridge = if live {
                    song.audio_url.clone()
                } else {
                    start_bridge(api, uri, song.audio_url.clone(), lifetime.clone()).await?
                };
                let duration = song.duration_ms.saturating_sub(position);
                let source = tokio::task::spawn_blocking(move || {
                    prepare_source(
                        ffmpeg, bridge, position, duration, sequential, lifetime, config,
                    )
                })
                .await
                .map_err(|_| "Audio preparation stopped unexpectedly".to_string())??;
                log::debug!(
                    "Audio ready in {} ms (source resolution {} ms, decoding {} ms)",
                    started.elapsed().as_millis(),
                    resolved.as_millis(),
                    started.elapsed().saturating_sub(resolved).as_millis(),
                );
                Ok::<_, String>((song, source))
            }
            .await;
            let message = match result {
                Ok((song, source)) => Prepared::Song(generation, song, source),
                Err(error) => Prepared::Failed(generation, error),
            };
            let _ = prepared.send(message);
            ready.notify_one();
        }));
    }

    pub async fn command(&mut self, command: PlayerCommand) {
        match command {
            PlayerCommand::Load(spec) => {
                self.cancel();
                if let Some(shuffle) = spec.shuffle {
                    self.state.shuffle = shuffle;
                }
                if let Some(repeat) = spec.repeat {
                    self.state.repeat = repeat;
                }
                if !spec.uris.is_empty() || spec.context_uri.is_none() {
                    self.queue
                        .load(&spec, spec.uris.clone(), self.state.shuffle);
                    self.load_current(spec.position_ms, spec.play);
                } else {
                    self.state.playback = Playback::Loading;
                    self.state.position_at = None;
                    self.state.error = None;
                    self.desired_play = spec.play;
                    self.emit();
                    let api = self.api.clone();
                    let tx = self.prepared_tx.clone();
                    let ready = self.ready.clone();
                    let generation = self.generation;
                    self.preparation = Some(tokio::spawn(async move {
                        let result = api
                            .resolve_context(spec.context_uri.as_deref().unwrap())
                            .await;
                        let _ = tx.send(Prepared::Context(generation, spec, result));
                        ready.notify_one();
                    }));
                }
            }
            PlayerCommand::Toggle => match self.state.playback {
                Playback::Stopped => self.load_current(0, true),
                Playback::Loading => {
                    self.desired_play = !self.desired_play;
                }
                Playback::Playing | Playback::Paused => {
                    self.desired_play = self.state.playback != Playback::Playing;
                    if self.desired_play
                        && self
                            .state
                            .track
                            .as_ref()
                            .is_some_and(|t| t.uri.starts_with("spotify:track:radio:"))
                    {
                        self.prepare_current(0, true, false);
                        return;
                    }
                    self.state.position_ms = self.state.position_now();
                    self.state.playback = if self.desired_play {
                        Playback::Playing
                    } else {
                        Playback::Paused
                    };
                    self.state.position_at = self.desired_play.then(Instant::now);
                    let _ = self.audio.send(AudioCommand::Pause(!self.desired_play));
                    if !self.desired_play {
                        self.config.tap.clear();
                    }
                    self.emit();
                }
            },
            PlayerCommand::Next => {
                if self.queue.advance(self.state.repeat, false).is_some() {
                    self.load_current(0, self.desired_play);
                } else {
                    self.stop_at_end();
                }
            }
            PlayerCommand::Previous => {
                let new_track =
                    self.state.position_now() <= 3000 && self.queue.previous().is_some();
                if !new_track {
                    self.state.seek_sequence = self.state.seek_sequence.wrapping_add(1);
                }
                self.prepare_current(0, self.desired_play, new_track);
            }
            PlayerCommand::Seek(position) => {
                if self
                    .state
                    .track
                    .as_ref()
                    .is_some_and(|t| t.uri.starts_with("spotify:track:radio:"))
                {
                    return;
                }
                self.state.seek_sequence = self.state.seek_sequence.wrapping_add(1);
                let position = self.state.track.as_ref().map_or(position, |t| {
                    if t.duration_ms == 0 {
                        position
                    } else {
                        position.min(t.duration_ms.saturating_sub(1))
                    }
                });
                self.prepare_current(position, self.desired_play, false);
            }
            PlayerCommand::Volume(volume) | PlayerCommand::VolumePreview(volume) => {
                self.state.volume = volume;
                let _ = self.audio.send(AudioCommand::Volume(volume));
                self.emit();
            }
            PlayerCommand::Shuffle(enabled) => {
                self.state.shuffle = enabled;
                self.queue.shuffle(enabled);
                self.emit();
            }
            PlayerCommand::Repeat(mode) => {
                self.state.repeat = mode;
                self.emit();
            }
            PlayerCommand::AddToQueue(uri) => {
                self.queue.manual.push_back(uri);
                self.emit();
            }
            PlayerCommand::ClearQueue => {
                self.queue.manual.clear();
                self.emit();
            }
            // This service has no Spotify Connect session to transfer.
            PlayerCommand::Transfer => self.emit(),
        }
    }

    fn stop_at_end(&mut self) {
        self.cancel();
        self.desired_play = false;
        self.state.playback = Playback::Stopped;
        self.state.position_at = None;
        self.emit();
    }

    pub async fn tick(&mut self) {
        while let Ok(message) = self.prepared_rx.try_recv() {
            match message {
                Prepared::Context(generation, spec, result) if generation == self.generation => {
                    match result {
                        Ok(tracks) => {
                            self.queue.load(&spec, tracks, self.state.shuffle);
                            self.load_current(spec.position_ms, self.desired_play);
                        }
                        Err(error) => self.fail(error),
                    }
                }
                Prepared::Song(generation, song, source) if generation == self.generation => {
                    self.state.track =
                        Some(song.local_track(self.queue.current.as_deref().unwrap_or_default()));
                    if self
                        .audio
                        .send(AudioCommand::Load {
                            generation,
                            source,
                            position: self.start_position,
                            playing: self.desired_play,
                            volume: self.state.volume,
                        })
                        .is_err()
                    {
                        self.fail("Audio output stopped unexpectedly. Restart the app.".into());
                    }
                }
                Prepared::Failed(generation, error) if generation == self.generation => {
                    self.fail(error)
                }
                _ => {}
            }
        }
        while let Ok(report) = self.reports.try_recv() {
            match report {
                AudioReport::Started(generation) if generation == self.generation => {
                    self.state.playback = if self.desired_play {
                        Playback::Playing
                    } else {
                        Playback::Paused
                    };
                    self.state.position_at = self.desired_play.then(Instant::now);
                    self.emit();
                }
                AudioReport::Position(generation, position) if generation == self.generation => {
                    self.state.position_ms = position;
                    self.state.position_at =
                        (self.state.playback == Playback::Playing).then(Instant::now);
                    if self.last_position_event.elapsed() >= Duration::from_secs(1) {
                        self.last_position_event = Instant::now();
                        self.emit();
                    }
                }
                AudioReport::Ended(generation) if generation == self.generation => {
                    if self.queue.advance(self.state.repeat, true).is_some() {
                        self.load_current(0, self.desired_play);
                    } else {
                        self.stop_at_end();
                    }
                }
                AudioReport::Failed(generation, error) if generation == self.generation => {
                    self.fail(error)
                }
                _ => {}
            }
        }
    }
}

impl Drop for MusicPlayer {
    fn drop(&mut self) {
        self.cancel();
        let _ = self.audio.send(AudioCommand::Shutdown);
    }
}

fn find_ffmpeg() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("STREAMARENA_FFMPEG") {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path).ok_or_else(|| {
            "STREAMARENA_FFMPEG must point to an installed FFmpeg executable.".into()
        });
    }
    let paths = [
        PathBuf::from("/opt/homebrew/bin/ffmpeg"),
        PathBuf::from("/usr/local/bin/ffmpeg"),
    ];
    paths.into_iter().chain(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|path| path.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })))
        .find(|path| path.is_file()).ok_or_else(||
            "FFmpeg is required for music playback. Install it (brew install ffmpeg on macOS), then reopen the app, or set STREAMARENA_FFMPEG to its executable.".into())
}

fn audio_thread(
    commands: mpsc::Receiver<AudioCommand>,
    reports: mpsc::Sender<AudioReport>,
    config: EngineConfig,
    ready: Arc<tokio::sync::Notify>,
) {
    let mut output: Option<rodio::OutputStream> = None;
    let mut active: Option<(u64, rodio::Sink, Arc<AtomicU64>, u32, Arc<Lifetime>)> = None;
    loop {
        match commands.recv_timeout(Duration::from_millis(100)) {
            Ok(AudioCommand::Load {
                generation,
                source,
                position,
                playing,
                volume,
            }) => {
                if let Some((_, sink, _, _, _)) = active.take() {
                    sink.stop();
                }
                if output.is_none() {
                    let host = cpal::default_host();
                    let device = config
                        .audio_device
                        .as_ref()
                        .and_then(|wanted| {
                            host.output_devices().ok()?.find(|device| {
                                device.name().ok().as_deref() == Some(wanted.as_str())
                            })
                        })
                        .or_else(|| host.default_output_device());
                    let opened = device
                        .ok_or_else(|| crate::sink::NO_DEVICE.to_string())
                        .and_then(|device| {
                            rodio::OutputStreamBuilder::from_device(device)
                                .and_then(|builder| builder.open_stream_or_fallback())
                                .map_err(|e| format!("Couldn't open the audio output: {e}"))
                        });
                    match opened {
                        Ok(mut stream) => {
                            stream.log_on_drop(false);
                            output = Some(stream);
                        }
                        Err(error) => {
                            source.lifetime.cancel();
                            let _ = reports.send(AudioReport::Failed(generation, error));
                            ready.notify_one();
                            continue;
                        }
                    }
                }
                let sink = rodio::Sink::connect_new(output.as_ref().unwrap().mixer());
                sink.set_volume(f32::from(volume) / f32::from(u16::MAX));
                if !playing {
                    sink.pause();
                }
                let consumed = source.consumed.clone();
                let lifetime = source.lifetime.clone();
                sink.append(source);
                active = Some((generation, sink, consumed, position, lifetime));
                let _ = reports.send(AudioReport::Started(generation));
                ready.notify_one();
            }
            Ok(AudioCommand::Pause(paused)) => {
                if let Some((_, sink, _, _, _)) = &active {
                    if paused {
                        sink.pause();
                    } else {
                        sink.play();
                    }
                }
            }
            Ok(AudioCommand::Volume(volume)) => {
                if let Some((_, sink, _, _, _)) = &active {
                    sink.set_volume(f32::from(volume) / f32::from(u16::MAX));
                }
            }
            Ok(AudioCommand::Stop) => {
                if let Some((_, sink, _, _, lifetime)) = active.take() {
                    lifetime.cancel();
                    sink.stop();
                }
            }
            Ok(AudioCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some((generation, sink, consumed, start, lifetime)) = &active {
            if sink.empty() {
                let generation = *generation;
                let failed = lifetime.decode_failed.load(Ordering::Acquire);
                let _ = reports.send(if failed {
                    AudioReport::Failed(
                        generation,
                        "The audio stream ended unexpectedly. Try playing this track again.".into(),
                    )
                } else {
                    AudioReport::Ended(generation)
                });
                ready.notify_one();
                active.take();
            } else {
                let ms =
                    consumed.load(Ordering::Relaxed) * 1000 / u64::from(RATE * u32::from(CHANNELS));
                let _ = reports.send(AudioReport::Position(
                    *generation,
                    start.saturating_add(ms as u32),
                ));
            }
        }
    }
    if let Some((_, sink, _, _, lifetime)) = active {
        lifetime.cancel();
        sink.stop();
    }
}

fn sequential_start(url: &str, position: u32) -> bool {
    position == 0
        && reqwest::Url::parse(url).is_ok_and(|url| {
            let path = url.path().to_ascii_lowercase();
            path.ends_with(".opus") || path.ends_with(".ogg")
        })
}

fn prepare_source(
    ffmpeg: PathBuf,
    bridge: String,
    position: u32,
    duration: u32,
    sequential: bool,
    lifetime: Arc<Lifetime>,
    config: EngineConfig,
) -> Result<AudioSource, String> {
    let mut command = Command::new(ffmpeg);
    command.args([
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-rw_timeout",
        "20000000",
    ]);
    if position > 0 {
        command.args(["-ss", &format!("{:.3}", f64::from(position) / 1000.0)]);
    }
    if sequential && position == 0 {
        command.args(["-seekable", "0"]);
    }
    command
        .args([
            "-i",
            &bridge,
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ar",
            "44100",
            "-ac",
            "2",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|e| format!("Couldn't launch FFmpeg: {e}"))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Couldn't read decoded audio".to_string())?;
    lifetime.install(child)?;
    let first =
        read_pcm_block(&mut stdout).map_err(|_| "Couldn't read this audio stream".to_string())?;
    if first.is_empty() {
        lifetime.cancel();
        return Err("Couldn't decode this track. The media may be unavailable; try again.".into());
    }
    let (blocks_tx, blocks) = mpsc::sync_channel(BUFFER_BLOCKS);
    blocks_tx
        .send(first)
        .map_err(|_| "Playback cancelled".to_string())?;
    let reader_lifetime = lifetime.clone();
    std::thread::Builder::new()
        .name("music-decode".into())
        .spawn(move || {
            while !reader_lifetime.cancelled.load(Ordering::Acquire) {
                let mut block = match read_pcm_block(&mut stdout) {
                    Ok(block) => block,
                    Err(_) => {
                        reader_lifetime.decode_failed.store(true, Ordering::Release);
                        break;
                    }
                };
                if block.is_empty() {
                    break;
                }
                loop {
                    match blocks_tx.try_send(block) {
                        Ok(()) => break,
                        Err(mpsc::TrySendError::Full(returned)) => {
                            if reader_lifetime.cancelled.load(Ordering::Acquire) {
                                return;
                            }
                            block = returned;
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(mpsc::TrySendError::Disconnected(_)) => return,
                    }
                }
            }
            // Keep the PCM sender alive until the decoder's exit is known: EOF
            // from a failed HTTP read must not be reported as a successful track.
            let deadline = Instant::now() + Duration::from_secs(1);
            while !reader_lifetime.cancelled.load(Ordering::Acquire) {
                let status = reader_lifetime
                    .child
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .as_mut()
                    .and_then(|child| child.try_wait().ok().flatten());
                if let Some(status) = status {
                    if !status.success() {
                        reader_lifetime.decode_failed.store(true, Ordering::Release);
                    }
                    break;
                }
                if Instant::now() >= deadline {
                    reader_lifetime.decode_failed.store(true, Ordering::Release);
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
        .map_err(|e| format!("Couldn't start audio decoding: {e}"))?;
    Ok(AudioSource {
        blocks,
        current: Vec::new(),
        offset: 0,
        lifetime,
        consumed: Arc::new(AtomicU64::new(0)),
        tap: config.tap,
        eq: crate::eq::Processor::new(config.eq),
        limiter: crate::limiter::Limiter::new(f64::from(RATE)),
        duration: (duration > 0).then(|| Duration::from_millis(u64::from(duration))),
    })
}

fn read_pcm_block(reader: &mut impl Read) -> std::io::Result<Vec<f64>> {
    let mut bytes = [0u8; BLOCK_SAMPLES * 4];
    let mut count = 0;
    while count < bytes.len() {
        match reader.read(&mut bytes[count..]) {
            Ok(0) => break,
            Ok(n) => count += n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    if count % 8 != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Truncated stereo PCM",
        ));
    }
    Ok(bytes[..count]
        .chunks_exact(4)
        .map(|sample| f32::from_le_bytes(sample.try_into().unwrap()) as f64)
        .collect())
}

async fn start_bridge(
    api: MusicApi,
    uri: String,
    media_url: String,
    lifetime: Arc<Lifetime>,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Couldn't open the local audio stream".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "Couldn't open the local audio stream".to_string())?;
    let path = format!("/{:032x}", rand::random::<u128>());
    let endpoint = format!("http://{address}{path}");
    tokio::spawn(async move {
        let mut cancelled = lifetime.signal.subscribe();
        let capacity = Arc::new(tokio::sync::Semaphore::new(4));
        loop {
            if *cancelled.borrow() {
                break;
            }
            let accepted = tokio::select! {
                _ = cancelled.changed() => break,
                result = listener.accept() => result,
            };
            let Ok((stream, _)) = accepted else {
                break;
            };
            let Ok(permit) = capacity.clone().try_acquire_owned() else {
                continue;
            };
            let (api, uri, media_url, path, lifetime) = (
                api.clone(),
                uri.clone(),
                media_url.clone(),
                path.clone(),
                lifetime.clone(),
            );
            tokio::spawn(async move {
                let _permit = permit;
                let mut cancelled = lifetime.signal.subscribe();
                if *cancelled.borrow() {
                    return;
                }
                tokio::select! {
                    _ = cancelled.changed() => {},
                    _ = proxy_request(stream, api, &uri, &media_url, &path) => {},
                }
            });
        }
    });
    Ok(endpoint)
}

async fn proxy_request(
    mut socket: tokio::net::TcpStream,
    api: MusicApi,
    uri: &str,
    media_url: &str,
    path: &str,
) -> Result<(), ()> {
    let mut header = Vec::with_capacity(1024);
    loop {
        let mut byte = [0];
        let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut byte))
            .await
            .map_err(|_| ())?
            .map_err(|_| ())?;
        if n == 0 || header.len() >= 8192 {
            return Err(());
        }
        header.push(byte[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let header = std::str::from_utf8(&header).map_err(|_| ())?;
    let mut lines = header.split("\r\n");
    let mut request = lines.next().ok_or(())?.split_whitespace();
    let method = request.next().ok_or(())?;
    let requested_path = request.next().ok_or(())?;
    if !matches!(method, "GET" | "HEAD") || requested_path != path {
        let _ = socket
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await;
        return Ok(());
    }
    let range = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case("range"))
        .map(|(_, value)| value.trim().to_string());
    let client = api.client();
    let fetch = |url: &str| {
        let method = if method == "HEAD" {
            reqwest::Method::HEAD
        } else {
            reqwest::Method::GET
        };
        let mut request = client
            .request(method, url)
            // The API client's short total timeout also counts time paused
            // behind bounded buffers. Streaming gets per-read deadlines below.
            .timeout(Duration::from_secs(24 * 60 * 60))
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        if let Some(range) = &range {
            request = request.header(reqwest::header::RANGE, range);
        }
        tokio::time::timeout(Duration::from_secs(20), request.send())
    };
    let mut response = fetch(media_url).await.map_err(|_| ())?.map_err(|_| ())?;
    if matches!(response.status().as_u16(), 401 | 403 | 404 | 410) {
        if let Ok(song) = api.refresh_song(uri).await {
            response = fetch(&song.audio_url)
                .await
                .map_err(|_| ())?
                .map_err(|_| ())?;
        }
    }
    let mut outgoing = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        response.status().as_u16(),
        response.status().canonical_reason().unwrap_or("Stream")
    );
    for name in [
        "content-length",
        "content-range",
        "content-type",
        "accept-ranges",
    ] {
        if let Some(value) = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            outgoing.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    outgoing.push_str("\r\n");
    socket
        .write_all(outgoing.as_bytes())
        .await
        .map_err(|_| ())?;
    if method == "HEAD" {
        return Ok(());
    }
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(20), response.chunk())
        .await
        .map_err(|_| ())?
        .map_err(|_| ())?
    {
        socket.write_all(&chunk).await.map_err(|_| ())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue() -> QueuePlan {
        let mut queue = QueuePlan::default();
        queue.load(
            &LoadSpec::default(),
            vec!["a".into(), "b".into(), "c".into()],
            false,
        );
        queue
    }

    #[test]
    fn manual_queue_precedes_context_without_losing_context_position() {
        let mut q = queue();
        q.manual.push_back("manual".into());
        assert_eq!(q.advance(RepeatMode::Off, false).as_deref(), Some("manual"));
        assert_eq!(q.advance(RepeatMode::Off, false).as_deref(), Some("b"));
        assert_eq!(q.previous().as_deref(), Some("manual"));
        assert_eq!(q.advance(RepeatMode::Off, false).as_deref(), Some("b"));
        assert_eq!(q.advance(RepeatMode::Off, false).as_deref(), Some("c"));
        assert!(q.advance(RepeatMode::Off, true).is_none());
    }

    #[test]
    fn repeat_track_applies_to_eof_but_explicit_skip_advances() {
        let mut q = queue();
        assert_eq!(q.advance(RepeatMode::Track, true).as_deref(), Some("a"));
        assert_eq!(q.advance(RepeatMode::Track, false).as_deref(), Some("b"));
        q.advance(RepeatMode::Off, false);
        assert_eq!(q.advance(RepeatMode::Context, true).as_deref(), Some("a"));
    }

    #[test]
    fn shuffled_load_preserves_selected_track_and_every_queue_member() {
        let mut q = queue();
        let spec = LoadSpec {
            offset_uri: Some("b".into()),
            ..LoadSpec::default()
        };
        q.load(&spec, vec!["a".into(), "b".into(), "c".into()], true);
        assert_eq!(q.current.as_deref(), Some("b"));
        let mut upcoming = q.upcoming();
        upcoming.sort();
        assert_eq!(upcoming, ["a", "c"]);
    }

    #[test]
    fn pcm_short_reads_preserve_samples_and_reject_partial_frames() {
        struct Short(std::io::Cursor<Vec<u8>>);
        impl Read for Short {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let length = buffer.len().min(3);
                std::io::Read::read(&mut self.0, &mut buffer[..length])
            }
        }
        let data: Vec<u8> = [0.25f32, -0.5, 0.75, 0.0]
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect();
        assert_eq!(
            read_pcm_block(&mut Short(std::io::Cursor::new(data))).unwrap(),
            [0.25, -0.5, 0.75, 0.0]
        );
        assert!(read_pcm_block(&mut std::io::Cursor::new(vec![0; 5])).is_err());
    }

    #[test]
    fn audio_callback_does_not_block_or_advance_on_network_starvation() {
        let (sender, blocks) = mpsc::sync_channel(1);
        let consumed = Arc::new(AtomicU64::new(0));
        let lifetime = Lifetime::new();
        let mut source = AudioSource {
            blocks,
            current: Vec::new(),
            offset: 0,
            lifetime: lifetime.clone(),
            consumed: consumed.clone(),
            tap: crate::vis::AudioTap::new(),
            eq: crate::eq::Processor::new(crate::eq::shared()),
            limiter: crate::limiter::Limiter::new(f64::from(RATE)),
            duration: None,
        };
        assert_eq!(source.next(), Some(0.0));
        assert_eq!(consumed.load(Ordering::Relaxed), 0);
        sender.send(vec![0.1, 0.1]).unwrap();
        assert!(source.next().is_some());
        assert_eq!(consumed.load(Ordering::Relaxed), 1);
        lifetime.cancel();
        assert_eq!(source.next(), None);
    }

    fn config() -> EngineConfig {
        EngineConfig {
            device_name: "Audio test".into(),
            bitrate_kbps: 320,
            normalisation: false,
            autoplay: false,
            gapless: false,
            backend: None,
            audio_device: None,
            initial_volume: u16::MAX,
            volume_dir: PathBuf::new(),
            audio_cache_dir: None,
            audio_cache_limit: None,
            buffer_ms: 100,
            tap: crate::vis::AudioTap::new(),
            eq: crate::eq::shared(),
            proxy: crate::settings::ProxyConfig::Off,
        }
    }

    async fn origin(
        bytes: Vec<u8>,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        origin_with_recovery(bytes, None).await
    }

    async fn origin_with_recovery(
        bytes: Vec<u8>,
        stale_status: Option<u16>,
    ) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        let bytes = Arc::new(bytes);
        let base = url.clone();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let bytes = bytes.clone();
                let recorded = recorded.clone();
                let base = base.clone();
                tokio::spawn(async move {
                    let mut header = Vec::new();
                    loop {
                        let mut byte = [0];
                        if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        header.push(byte[0]);
                        if header.ends_with(b"\r\n\r\n") {
                            break;
                        }
                    }
                    let header = String::from_utf8(header).unwrap();
                    recorded.lock().unwrap().push(header.clone());
                    if let Some(status) = stale_status {
                        if header.starts_with("GET /missing ") {
                            let _ = socket.write_all(format!(
                                "HTTP/1.1 {status} Stale\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            ).as_bytes()).await;
                            return;
                        }
                        if header.starts_with("GET /api/songs/") {
                            let body = serde_json::json!({
                                "id":"fixture", "title":"Fixture", "artist":"Test",
                                "audioUrl":format!("{base}/audio"), "duration":1
                            })
                            .to_string();
                            let _ = socket.write_all(format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
                            ).as_bytes()).await;
                            return;
                        }
                    }
                    let range = header
                        .split("\r\n")
                        .filter_map(|line| line.split_once(':'))
                        .find(|(key, _)| key.eq_ignore_ascii_case("range"))
                        .and_then(|(_, value)| value.trim().strip_prefix("bytes="))
                        .and_then(|value| value.split_once('-'));
                    let (start, end) = range.map_or((0, bytes.len() - 1), |(start, end)| {
                        (
                            start.parse().unwrap_or(0),
                            end.parse().unwrap_or(bytes.len() - 1),
                        )
                    });
                    let end = end.min(bytes.len() - 1);
                    if start > end {
                        let _ = socket.write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                        return;
                    }
                    let mut response = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n",
                        if range.is_some() {
                            "206 Partial Content"
                        } else {
                            "200 OK"
                        },
                        end - start + 1
                    );
                    if range.is_some() {
                        response.push_str(&format!(
                            "Content-Range: bytes {start}-{end}/{}\r\n",
                            bytes.len()
                        ));
                    }
                    response.push_str("\r\n");
                    if socket.write_all(response.as_bytes()).await.is_ok()
                        && !header.starts_with("HEAD ")
                    {
                        let _ = socket.write_all(&bytes[start..=end]).await;
                    }
                });
            }
        });
        (url, seen, task)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_preserves_range_and_signature_and_rejects_other_paths() {
        let (url, seen, server) = origin(b"0123456789".to_vec()).await;
        let api = MusicApi::new(&url, crate::http::Http::default()).unwrap();
        let lifetime = Lifetime::new();
        let bridge = start_bridge(
            api,
            "spotify:track:test".into(),
            format!("{url}/audio?signature=kept"),
            lifetime.clone(),
        )
        .await
        .unwrap();
        let client = reqwest::Client::new();
        let response = client
            .get(&bridge)
            .header("Range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(response.text().await.unwrap(), "2345");
        assert!(seen.lock().unwrap()[0].starts_with("GET /audio?signature=kept "));
        let response = client
            .get(format!("{bridge}/unexpected"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        assert_eq!(seen.lock().unwrap().len(), 1);
        lifetime.cancel();
        tokio::time::sleep(Duration::from_millis(25)).await;
        assert!(client.get(&bridge).send().await.is_err());
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bridge_refreshes_expired_or_pruned_media_and_preserves_the_range() {
        for status in [401, 403, 404, 410] {
            let (url, seen, server) =
                origin_with_recovery(b"0123456789".to_vec(), Some(status)).await;
            let api = MusicApi::new(&url, crate::http::Http::default()).unwrap();
            api.song_metadata("spotify:track:fixture").await.unwrap();
            let lifetime = Lifetime::new();
            let bridge = start_bridge(
                api,
                "spotify:track:fixture".into(),
                format!("{url}/missing"),
                lifetime.clone(),
            )
            .await
            .unwrap();
            let response = reqwest::Client::new()
                .get(bridge)
                .header("Range", "bytes=2-5")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::PARTIAL_CONTENT);
            assert_eq!(response.text().await.unwrap(), "2345");
            let requests = seen.lock().unwrap();
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("GET /missing "))
                    .count(),
                1
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("GET /api/songs/"))
                    .count(),
                2
            );
            assert_eq!(
                requests
                    .iter()
                    .filter(|r| r.starts_with("GET /audio "))
                    .count(),
                1
            );
            drop(requests);
            lifetime.cancel();
            server.abort();
        }
    }

    #[tokio::test]
    async fn preparation_completion_wakes_playback_without_a_polling_tick() {
        let api = MusicApi::new("http://127.0.0.1:9", crate::http::Http::default()).unwrap();
        let (events, _) = mpsc::channel();
        let mut player = MusicPlayer::new(api, config(), events, Waker::default())
            .await
            .unwrap();
        let signal = player.wake_signal();
        player
            .command(PlayerCommand::Load(LoadSpec {
                context_uri: Some("unsupported:context".into()),
                ..Default::default()
            }))
            .await;
        // No player tick runs while preparation completes. The signal must
        // retain a permit even if the completion wins the race with the wait.
        tokio::task::yield_now().await;
        tokio::time::timeout(Duration::from_secs(1), signal.notified())
            .await
            .expect("a completed preparation must wake the backend");
        assert_eq!(player.state.playback, Playback::Loading);
        player.tick().await;
        assert_eq!(player.state.playback, Playback::Stopped);
        assert!(player.state.error.is_some());
    }

    #[tokio::test]
    async fn seek_keeps_track_identity_and_ignores_superseded_load_failure() {
        let api = MusicApi::new("http://127.0.0.1:9", crate::http::Http::default()).unwrap();
        let (events, received) = mpsc::channel();
        let mut player = MusicPlayer::new(api, config(), events, Waker::default())
            .await
            .unwrap();
        player.queue = queue();
        player.state.track_sequence = 7;
        player.state.playback = Playback::Playing;
        player.desired_play = true;
        let superseded = player.generation;
        player.command(PlayerCommand::Seek(5000)).await;
        assert_eq!(player.state.track_sequence, 7);
        assert_eq!(player.state.seek_sequence, 1);
        assert_eq!(player.state.position_ms, 5000);
        // A late error from the old load must neither stop the new load nor
        // report an error after the user has already skipped/searched ahead.
        player
            .prepared_tx
            .send(Prepared::Failed(superseded, "old request failed".into()))
            .unwrap();
        player.tick().await;
        assert_eq!(player.state.playback, Playback::Loading);
        assert!(
            received
                .try_iter()
                .all(|event| !matches!(event, Event::Error(_)))
        );
        player.command(PlayerCommand::Next).await;
        assert_eq!(player.state.track_sequence, 8);
        assert_eq!(player.queue.current.as_deref(), Some("b"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ffmpeg_streams_and_seeks_flac_opus_ogg_and_m4a_through_the_bridge() {
        let ffmpeg =
            find_ffmpeg().expect("Playback tests require the documented FFmpeg dependency");
        for (extension, codec) in [
            ("flac", "flac"),
            ("opus", "libopus"),
            ("ogg", "vorbis"),
            ("m4a", "aac"),
        ] {
            let file = std::env::temp_dir().join(format!(
                "streamarena-player-{:032x}.{extension}",
                rand::random::<u128>()
            ));
            let output = Command::new(&ffmpeg)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=44100:duration=1.5",
                    "-ac",
                    "2",
                    "-c:a",
                    codec,
                    "-strict",
                    "-2",
                    "-y",
                ])
                .arg(&file)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Fixture encoding failed for {extension}"
            );
            let bytes = std::fs::read(&file).unwrap();
            std::fs::remove_file(&file).unwrap();
            for position in [0, 500] {
                let (url, seen, server) = origin(bytes.clone()).await;
                let media = format!("{url}/audio.{extension}?signature=kept");
                let sequential = sequential_start(&media, position);
                let api = MusicApi::new(&url, crate::http::Http::default()).unwrap();
                let lifetime = Lifetime::new();
                let bridge =
                    start_bridge(api, "spotify:track:fixture".into(), media, lifetime.clone())
                        .await
                        .unwrap();
                let decoder_lifetime = lifetime.clone();
                let decoder_ffmpeg = ffmpeg.clone();
                let (samples, peak) = tokio::task::spawn_blocking(move || {
                    let mut source = prepare_source(
                        decoder_ffmpeg,
                        bridge,
                        position,
                        1500 - position,
                        sequential,
                        decoder_lifetime,
                        config(),
                    )
                    .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(5);
                    let mut peak = 0f32;
                    while let Some(sample) = source.next() {
                        peak = peak.max(sample.abs());
                        assert!(Instant::now() < deadline, "Decoder didn't reach EOF");
                        if source.offset >= source.current.len() {
                            std::thread::sleep(Duration::from_millis(1));
                        }
                    }
                    (source.consumed.load(Ordering::Relaxed), peak)
                })
                .await
                .unwrap();
                let expected =
                    u64::from(1500 - position) * u64::from(RATE * u32::from(CHANNELS)) / 1000;
                assert!(
                    samples.abs_diff(expected) < 4000,
                    "{extension} at {position}ms: produced {samples} samples, expected {expected}"
                );
                assert!(peak > 0.01, "{extension}: decoded only silence");
                assert!(
                    !lifetime.decode_failed.load(Ordering::Acquire),
                    "{extension}: decoder failed"
                );
                lifetime.cancel();
                if sequential {
                    assert_eq!(
                        seen.lock().unwrap().len(),
                        1,
                        "a fresh {extension} stream must start without end-of-file range probes"
                    );
                }
                server.abort();
            }
        }
    }
}
