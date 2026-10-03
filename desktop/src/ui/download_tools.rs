//! Local audio workflows share the Downloads palette and run on the task actor.
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use egui::{RichText, Sense, Stroke, vec2};

use super::downloads::DownloadAction;
use super::widgets;
use crate::i18n::Locale;
use crate::music_downloads::OutputFormat;
use crate::music_downloads::tools::{
    AudioDocument, FrequencyScale, LyricsDocument, Spectrogram, SpectrumPalette, SpectrumWindow,
    ToolsFileResult, ToolsProgress, ToolsRequest, ToolsResult,
};
use crate::theme::{self, Icon, Palette};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ToolTab {
    #[default]
    Inspect,
    Tags,
    Rename,
    Convert,
    Loudness,
    Analyze,
    Lyrics,
}

#[derive(Clone, Copy, Debug)]
pub enum ToolOperation {
    Inspect,
    SaveTags,
    Rename,
    Convert,
    ReplayGain,
    Analyze,
    Enrich,
    ExtractLyrics,
    InspectLyrics,
    SaveLyrics,
    TranslateLyrics,
}

#[derive(Clone, Debug)]
pub enum ToolAction {
    AddFiles,
    AddFolder,
    ChooseOutput,
    RemoveSelected,
    Focus(PathBuf),
    Run(ToolOperation),
    Cancel,
}

pub struct ToolsViewState {
    pub paths: Vec<PathBuf>,
    pub selected: HashSet<PathBuf>,
    pub focused: Option<PathBuf>,
    pub documents: HashMap<PathBuf, AudioDocument>,
    pub lyric_documents: HashMap<PathBuf, LyricsDocument>,
    pub results: Vec<ToolsFileResult>,
    pub result_focus: usize,
    pub tab: ToolTab,
    pub output_dir: PathBuf,
    pub format: OutputFormat,
    pub rename_template: String,
    pub bitrate_kbps: u32,
    pub sample_rate: Option<u32>,
    pub bit_depth: Option<u32>,
    pub album_gain: bool,
    pub tempo_key: bool,
    pub spectrum: bool,
    pub fft_size: usize,
    pub spectrum_window: SpectrumWindow,
    pub spectrum_palette: SpectrumPalette,
    pub frequency_scale: FrequencyScale,
    spectrogram_texture: Option<(
        (u64, usize, SpectrumPalette, FrequencyScale),
        egui::TextureHandle,
    )>,
    pub export_spectrum: bool,
    pub lyrics_plain_text: bool,
    pub lyrics_options: crate::music_downloads::LyricsOptions,
    pub enrich_query: String,
    pub enrich_overwrite: bool,
    pub tags: BTreeMap<String, String>,
    pub lyrics: String,
    pub request: u64,
    pub busy: bool,
    pub cancelling: bool,
    pub progress: Option<ToolsProgress>,
    pub error: Option<String>,
}
impl Default for ToolsViewState {
    fn default() -> Self {
        Self {
            paths: Vec::new(),
            selected: HashSet::new(),
            focused: None,
            documents: HashMap::new(),
            lyric_documents: HashMap::new(),
            results: Vec::new(),
            result_focus: 0,
            tab: ToolTab::Inspect,
            output_dir: crate::music_downloads::ExportOptions::default()
                .output_dir
                .join("Tools"),
            format: OutputFormat::Flac,
            rename_template: "{artist} - {title}".into(),
            bitrate_kbps: 320,
            sample_rate: None,
            bit_depth: None,
            album_gain: false,
            tempo_key: true,
            spectrum: true,
            fft_size: 8192,
            spectrum_window: SpectrumWindow::default(),
            spectrum_palette: SpectrumPalette::default(),
            frequency_scale: FrequencyScale::default(),
            spectrogram_texture: None,
            export_spectrum: false,
            lyrics_plain_text: false,
            lyrics_options: Default::default(),
            enrich_query: String::new(),
            enrich_overwrite: false,
            tags: BTreeMap::new(),
            lyrics: String::new(),
            request: 0,
            busy: false,
            cancelling: false,
            progress: None,
            error: None,
        }
    }
}
impl ToolsViewState {
    pub fn add_paths(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        for path in paths {
            self.selected.insert(path.clone());
            if !self.paths.contains(&path) {
                self.paths.push(path);
            }
        }
    }
    pub fn focus(&mut self, path: PathBuf) {
        if let Some(document) = self.lyric_documents.get(&path) {
            self.tags.clear();
            self.lyrics = document.text.clone();
            self.lyrics_plain_text = !document.synced;
        } else if let Some(document) = self.documents.get(&path) {
            self.tags = document
                .tags
                .iter()
                .map(|(key, value)| (key.to_lowercase(), value.clone()))
                .collect();
            self.lyrics = document.lyrics.clone().unwrap_or_default();
        } else {
            self.tags.clear();
            self.lyrics.clear();
        }
        self.focused = Some(path);
    }
    pub fn accept(&mut self, result: ToolsResult) {
        self.spectrogram_texture = None;
        self.busy = false;
        self.cancelling = false;
        self.error = result
            .cancelled
            .then(|| "Operation cancelled. Finished copies remain available below.".into());
        for file in &result.files {
            if let Some(document) = &file.lyric_document {
                self.lyric_documents
                    .insert(document.path.clone(), document.clone());
                if !self.paths.contains(&document.path) {
                    self.paths.push(document.path.clone());
                }
            }
            if let Some(document) = &file.document {
                self.documents
                    .insert(document.path.clone(), document.clone());
                if document.path != file.input && !self.paths.contains(&document.path) {
                    // Outputs are available for the next operation, but never silently
                    // replace the original selection or its inspected metadata.
                    self.paths.push(document.path.clone());
                }
            }
            if !self.paths.contains(&file.input)
                && (file.document.is_some()
                    || file.lyric_document.is_some()
                    || file.analysis.is_some())
            {
                self.paths.push(file.input.clone());
                self.selected.insert(file.input.clone());
            }
        }
        let refreshed: Vec<_> = result
            .files
            .iter()
            .flat_map(|file| {
                file.document
                    .as_ref()
                    .map(|document| &document.path)
                    .into_iter()
                    .chain(file.lyric_document.as_ref().map(|document| &document.path))
            })
            .collect();
        if self.focused.is_none() {
            if let Some(file) = result
                .files
                .iter()
                .find(|file| refreshed.contains(&&file.input))
            {
                self.focus(file.input.clone());
            }
        } else if let Some(path) = self.focused.clone() {
            if refreshed.contains(&&path) {
                self.focus(path);
            }
        }
        self.results = result.files;
        self.result_focus = 0;
    }
    pub fn selected_paths(&self) -> Vec<PathBuf> {
        self.paths
            .iter()
            .filter(|path| self.selected.contains(*path))
            .cloned()
            .collect()
    }
    pub fn build_request(&self, operation: ToolOperation) -> Result<ToolsRequest, String> {
        let paths = self.selected_paths();
        if paths.is_empty()
            && !matches!(
                operation,
                ToolOperation::SaveTags
                    | ToolOperation::SaveLyrics
                    | ToolOperation::TranslateLyrics
            )
        {
            return Err("Select audio files first.".into());
        }
        Ok(match operation {
            ToolOperation::Inspect => ToolsRequest::Inspect { paths },
            ToolOperation::InspectLyrics => ToolsRequest::InspectLyrics { paths },
            ToolOperation::SaveLyrics => ToolsRequest::SaveLyrics {
                path: self
                    .focused
                    .clone()
                    .ok_or("Choose a file to name the lyric copy.")?,
                output_dir: self.output_dir.clone(),
                text: self.lyrics.clone(),
                plain_text: self.lyrics_plain_text,
            },
            ToolOperation::TranslateLyrics => {
                self.lyrics_options.validate()?;
                if self.lyrics_options.translation_provider
                    == crate::music_downloads::LyricsTranslationProvider::Off
                {
                    return Err("Choose Codex or Claude in Lyrics & translation first.".into());
                }
                ToolsRequest::TranslateLyrics {
                    path: self
                        .focused
                        .clone()
                        .ok_or("Read a lyric file or inspect audio first.")?,
                    output_dir: self.output_dir.clone(),
                    text: self.lyrics.clone(),
                    options: self.lyrics_options.clone(),
                }
            }
            ToolOperation::SaveTags => {
                let path = self
                    .focused
                    .clone()
                    .filter(|path| self.documents.contains_key(path))
                    .ok_or("Inspect and choose one file before editing its tags.")?;
                ToolsRequest::Edit {
                    path,
                    output_dir: self.output_dir.clone(),
                    tags: self.tags.clone(),
                    lyrics: Some(self.lyrics.clone()),
                }
            }
            ToolOperation::Rename => ToolsRequest::Rename {
                paths,
                output_dir: self.output_dir.clone(),
                template: self.rename_template.clone(),
            },
            ToolOperation::Convert => ToolsRequest::Convert {
                paths,
                output_dir: self.output_dir.clone(),
                format: self.format,
                bitrate_kbps: self.bitrate_kbps,
                sample_rate: self.sample_rate,
                bit_depth: self.bit_depth,
            },
            ToolOperation::ReplayGain => ToolsRequest::ReplayGain {
                paths,
                output_dir: self.output_dir.clone(),
                album: self.album_gain,
            },
            ToolOperation::Analyze => {
                if !self.tempo_key && !self.spectrum {
                    return Err("Choose spectrum or tempo/key analysis.".into());
                }
                if self.spectrum {
                    ToolsRequest::AnalyzeSpectrum {
                        paths,
                        tempo_key: self.tempo_key,
                        fft_size: self.fft_size,
                        window: self.spectrum_window,
                        palette: self.spectrum_palette,
                        frequency_scale: self.frequency_scale,
                        export_dir: self.export_spectrum.then(|| self.output_dir.clone()),
                    }
                } else {
                    ToolsRequest::Analyze {
                        paths,
                        tempo_key: self.tempo_key,
                        spectrum: false,
                    }
                }
            }
            ToolOperation::Enrich => ToolsRequest::Enrich {
                paths,
                output_dir: self.output_dir.clone(),
                source: (!self.enrich_query.trim().is_empty())
                    .then(|| self.enrich_query.trim().to_owned()),
                overwrite: self.enrich_overwrite,
                lyrics_options: self.lyrics_options.clone(),
            },
            ToolOperation::ExtractLyrics => ToolsRequest::ExtractLyrics {
                paths,
                output_dir: self.output_dir.clone(),
            },
        })
    }
}

pub fn draw(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut ToolsViewState,
    actions: &mut Vec<DownloadAction>,
) {
    theme::text(ui, "Audio tools", theme::semibold(20.0), palette.text);
    hint(
        ui,
        palette,
        "Inspect, tag, convert, and analyze local audio. Your original files stay untouched.",
    );
    ui.add_space(14.0);
    ui.horizontal_wrapped(|ui| {
        for (label, icon, action) in [
            ("Add files", Icon::Plus, ToolAction::AddFiles),
            ("Add folder", Icon::Folder, ToolAction::AddFolder),
        ] {
            if ui
                .add_enabled_ui(!state.busy, |ui| {
                    theme::soft_button(ui, palette, Some(icon), label, false)
                })
                .inner
                .clicked()
            {
                actions.push(DownloadAction::Tools(action));
            }
        }
        if !state.paths.is_empty()
            && ui
                .add_enabled_ui(!state.busy && !state.selected.is_empty(), |ui| {
                    theme::soft_button(ui, palette, None, "Remove selected", false)
                })
                .inner
                .on_hover_text("Remove from this list; files stay on disk.")
                .clicked()
        {
            actions.push(DownloadAction::Tools(ToolAction::RemoveSelected));
        }
    });
    ui.add_space(10.0);
    if state.paths.is_empty() && !state.busy && state.results.is_empty() {
        widgets::empty_state(
            ui,
            palette,
            Icon::AudioLines,
            "Choose files to work with",
            "Add audio files, lyric files, or a folder to get started.",
        );
        return;
    }
    files(ui, palette, state, actions);
    ui.add_space(16.0);
    if let Some(tab) = widgets::chips(
        ui,
        palette,
        &[
            (ToolTab::Inspect, "Inspect"),
            (ToolTab::Tags, "Tags"),
            (ToolTab::Rename, "Rename"),
            (ToolTab::Convert, "Convert"),
            (ToolTab::Loudness, "Loudness"),
            (ToolTab::Analyze, "Analyze"),
            (ToolTab::Lyrics, "Lyrics"),
        ],
        state.tab,
    ) {
        state.tab = tab;
    }
    ui.add_space(14.0);
    ui.add_enabled_ui(!state.busy, |ui| {
        if !matches!(state.tab, ToolTab::Inspect | ToolTab::Analyze) {
            ui.horizontal_wrapped(|ui| {
                theme::subtle(ui, palette, "Save copies to");
                ui.add(egui::Label::new(RichText::new(state.output_dir.display().to_string()).size(13.0)).truncate()).on_hover_text(state.output_dir.display().to_string());
                if theme::soft_button(ui, palette, None, "Choose…", false).clicked() { actions.push(DownloadAction::Tools(ToolAction::ChooseOutput)); }
            });
            ui.add_space(12.0);
        }
        match state.tab {
            ToolTab::Inspect => {
                run_button(ui, palette, "Inspect selected", ToolOperation::Inspect, actions);
                if let Some(document) = state.focused.as_ref().and_then(|path| state.documents.get(path)) { document_summary(ui, palette, document); }
                else { hint(ui, palette, "Inspect files to see their measured format, existing metadata, lyrics, and artwork."); }
            }
            ToolTab::Tags => tag_editor(ui, palette, locale, state, actions),
            ToolTab::Rename => {
                hint(ui, palette, "Create copies named from each file's metadata. Extensions are kept automatically.");
                widgets::text_edit(ui, locale, egui::TextEdit::singleline(&mut state.rename_template).desired_width(ui.available_width().min(600.0)));
                hint(ui, palette, "Use {artist}, {album}, {title}, {track}, {disc}, {year}, {date}, {album_artist}, {isrc}, {upc}, or {id}.");
                run_button(ui, palette, "Save renamed copies", ToolOperation::Rename, actions);
            }
            ToolTab::Convert => {
                ui.horizontal_wrapped(|ui| {
                    let formats: Vec<_> = OutputFormat::ALL.iter().map(|&value| (value, value.label())).collect();
                    combo(ui, "Format", "tools-format", &mut state.format, &formats);
                    if state.format == OutputFormat::Opus { ui.label("Opus · 48 kHz"); }
                    else { combo(ui, "Sample rate", "tools-rate", &mut state.sample_rate, &[(None,"Keep original"),(Some(44_100),"44.1 kHz"),(Some(48_000),"48 kHz"),(Some(88_200),"88.2 kHz"),(Some(96_000),"96 kHz"),(Some(192_000),"192 kHz")]); }
                    if matches!(state.format, OutputFormat::Flac | OutputFormat::Alac | OutputFormat::Wav | OutputFormat::Aiff) { combo(ui, "Bit depth", "tools-depth", &mut state.bit_depth, &[(None,"Keep original"),(Some(16),"16-bit"),(Some(24),"24-bit")]); }
                    if matches!(state.format, OutputFormat::Mp3 | OutputFormat::Opus | OutputFormat::Aac) { combo(ui, "Bitrate", "tools-bitrate", &mut state.bitrate_kbps, &[(128,"128 kbps"),(192,"192 kbps"),(256,"256 kbps"),(320,"320 kbps")]); }
                });
                ui.add_space(10.0);
                hint(ui, palette, "Changing format or increasing sample rate cannot restore detail missing from a lossy source.");
                run_button(ui, palette, "Convert selected", ToolOperation::Convert, actions);
            }
            ToolTab::Loudness => {
                ui.checkbox(&mut state.album_gain, "Treat selected files as one album");
                hint(ui, palette, if state.album_gain { "Album gain preserves relative loudness between these tracks. Select only one album for this operation." } else { "Track gain stores a playback loudness adjustment for each file. Audio samples are not normalized." });
                run_button(ui, palette, "Save ReplayGain copies", ToolOperation::ReplayGain, actions);
            }
            ToolTab::Analyze => {
                ui.horizontal_wrapped(|ui| { ui.checkbox(&mut state.spectrum, "Spectrogram, spectrum and waveform"); ui.checkbox(&mut state.tempo_key, "BPM and musical key"); });
                if state.spectrum {
                    ui.horizontal_wrapped(|ui| {
                        combo(ui,"FFT size","tools-fft-size",&mut state.fft_size,&[(1024,"1,024"),(2048,"2,048"),(4096,"4,096"),(8192,"8,192"),(16384,"16,384"),(32768,"32,768")]);
                        let windows:Vec<_>=SpectrumWindow::ALL.iter().map(|&window|(window,window.label())).collect();
                        combo(ui,"Window","tools-spectrum-window",&mut state.spectrum_window,&windows);
                    });
                    ui.horizontal_wrapped(|ui| {
                        let palettes:Vec<_>=SpectrumPalette::ALL.iter().map(|&value|(value,value.label())).collect();
                        combo(ui,"Palette","tools-spectrum-palette",&mut state.spectrum_palette,&palettes);
                        let scales:Vec<_>=FrequencyScale::ALL.iter().map(|&value|(value,value.label())).collect();
                        combo(ui,"Frequency scale","tools-spectrum-scale",&mut state.frequency_scale,&scales);
                    });
                    ui.checkbox(&mut state.export_spectrum,"Save a spectrogram PNG for each selected file");
                    if state.export_spectrum { hint(ui,palette,&format!("PNG folder: {}",state.output_dir.display())); if ui.small_button("Choose PNG folder…").clicked() { actions.push(DownloadAction::Tools(ToolAction::ChooseOutput)); } }
                }
                hint(ui, palette, "Tempo and key are estimates. A spectral cutoff alone cannot prove whether a source was lossless.");
                run_button(ui, palette, "Analyze selected", ToolOperation::Analyze, actions);
            }
            ToolTab::Lyrics => {
                hint(ui,palette,"Read LRC or TXT files, extract lyrics embedded in audio, and save edited copies.");
                ui.horizontal_wrapped(|ui| {
                    run_button(ui,palette,"Read LRC / TXT",ToolOperation::InspectLyrics,actions);
                    run_button(ui,palette,"Extract from audio",ToolOperation::ExtractLyrics,actions);
                });
                if let Some(path)=state.focused.as_ref() {
                    hint(ui,palette,&format!("Editing lyrics for {}",filename(path)));
                    widgets::text_edit(ui,locale,egui::TextEdit::multiline(&mut state.lyrics).desired_width(ui.available_width()).desired_rows(12));
                    ui.checkbox(&mut state.lyrics_plain_text,"Save plain text without timestamps");
                    run_button(ui,palette,"Save lyric copy",ToolOperation::SaveLyrics,actions);
                    egui::CollapsingHeader::new("Lyrics & translation").show(ui,|ui| super::downloads::lyrics_settings(ui,palette,&mut state.lyrics_options));
                    if state.lyrics_options.translation_provider!=crate::music_downloads::LyricsTranslationProvider::Off {
                        run_button(ui,palette,"Translate and save copy",ToolOperation::TranslateLyrics,actions);
                    }
                }
                ui.add_space(12.0);
                enrichment(ui, palette, locale, state, actions);
            }
        }
    });
    ui.add_space(14.0);
    if state.busy {
        ui.horizontal_wrapped(|ui| {
            theme::spinner(ui, 17.0, palette.secondary);
            let text = if state.cancelling {
                "Cancelling…".to_owned()
            } else {
                state
                    .progress
                    .as_ref()
                    .map(|progress| {
                        format!(
                            "{} · {} of {}",
                            progress.stage, progress.completed, progress.total
                        )
                    })
                    .unwrap_or_else(|| "Preparing audio tools…".into())
            };
            theme::subtle(ui, palette, &text);
            if ui
                .add_enabled_ui(!state.cancelling, |ui| {
                    theme::soft_button(ui, palette, None, "Cancel", false)
                })
                .inner
                .clicked()
            {
                actions.push(DownloadAction::Tools(ToolAction::Cancel));
            }
        });
        if let Some(progress) = &state.progress {
            if progress.total > 0 {
                ui.add(
                    egui::ProgressBar::new(progress.completed as f32 / progress.total as f32)
                        .desired_height(4.0)
                        .fill(palette.accent),
                );
            }
            if let Some(path) = &progress.path {
                hint(ui, palette, &path.display().to_string());
            }
        }
    }
    if let Some(error) = &state.error {
        ui.colored_label(palette.warning, error);
    }
    results(ui, palette, state, actions);
}

fn files(
    ui: &mut egui::Ui,
    palette: &Palette,
    state: &mut ToolsViewState,
    actions: &mut Vec<DownloadAction>,
) {
    ui.horizontal(|ui| {
        let mut all =
            !state.paths.is_empty() && state.paths.iter().all(|path| state.selected.contains(path));
        if ui
            .add_enabled(!state.busy, egui::Checkbox::new(&mut all, "Select all"))
            .changed()
        {
            state.selected = if all {
                state.paths.iter().cloned().collect()
            } else {
                HashSet::new()
            };
        }
        theme::subtle(ui, palette, &format!("{} selected", state.selected.len()));
    });
    egui::ScrollArea::vertical()
        .id_salt("tool-input-files")
        .max_height(240.0)
        .show_rows(ui, 40.0, state.paths.len(), |ui, range| {
            for index in range {
                let path = &state.paths[index];
                ui.push_id(path, |ui| {
                    ui.horizontal(|ui| {
                        let mut selected = state.selected.contains(path);
                        if ui
                            .add_enabled(!state.busy, egui::Checkbox::new(&mut selected, ""))
                            .on_hover_text(format!("Select {}", filename(path)))
                            .changed()
                        {
                            if selected {
                                state.selected.insert(path.clone());
                            } else {
                                state.selected.remove(path);
                            }
                        }
                        let focused = state.focused.as_ref() == Some(path);
                        if ui
                            .add(
                                egui::Button::new(RichText::new(filename(path)).size(13.0).color(
                                    if focused {
                                        palette.accent
                                    } else {
                                        palette.text
                                    },
                                ))
                                .frame(false)
                                .truncate(),
                            )
                            .on_hover_text(path.display().to_string())
                            .clicked()
                        {
                            actions.push(DownloadAction::Tools(ToolAction::Focus(path.clone())));
                        }
                        if let Some(document) = state.documents.get(path) {
                            theme::subtle(ui, palette, &document.quality.label());
                        }
                    });
                });
            }
        });
}

fn tag_editor(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut ToolsViewState,
    actions: &mut Vec<DownloadAction>,
) {
    let Some(path) = state
        .focused
        .as_ref()
        .filter(|path| state.documents.contains_key(*path))
    else {
        hint(
            ui,
            palette,
            "Inspect and choose one file to edit its metadata. Other selected files are not changed.",
        );
        run_button(
            ui,
            palette,
            "Inspect selected",
            ToolOperation::Inspect,
            actions,
        );
        return;
    };
    theme::text(
        ui,
        format!("Editing {}", filename(path)),
        theme::medium(14.0),
        palette.text,
    );
    ui.add_space(8.0);
    egui::Grid::new("audio-tag-editor")
        .num_columns(2)
        .spacing(vec2(14.0, 7.0))
        .show(ui, |ui| {
            for (key, label) in [
                ("title", "Title"),
                ("artist", "Artist"),
                ("album", "Album"),
                ("album_artist", "Album artist"),
                ("date", "Release date"),
                ("track", "Track"),
                ("disc", "Disc"),
                ("genre", "Genre"),
                ("composer", "Composer"),
                ("isrc", "ISRC"),
                ("upc", "UPC"),
                ("copyright", "Copyright"),
            ] {
                ui.label(label);
                widgets::text_edit(
                    ui,
                    locale,
                    egui::TextEdit::singleline(state.tags.entry(key.into()).or_default())
                        .desired_width(ui.available_width().min(500.0)),
                );
                ui.end_row();
            }
        });
    ui.add_space(8.0);
    egui::CollapsingHeader::new("Lyrics").show(ui, |ui| {
        widgets::text_edit(
            ui,
            locale,
            egui::TextEdit::multiline(&mut state.lyrics)
                .desired_width(ui.available_width())
                .desired_rows(8),
        );
    });
    run_button(
        ui,
        palette,
        "Save tagged copy",
        ToolOperation::SaveTags,
        actions,
    );
    ui.add_space(16.0);
    enrichment(ui, palette, locale, state, actions);
}

fn enrichment(
    ui: &mut egui::Ui,
    palette: &Palette,
    locale: Locale,
    state: &mut ToolsViewState,
    actions: &mut Vec<DownloadAction>,
) {
    theme::text(
        ui,
        "Find missing metadata and lyrics",
        theme::semibold(14.0),
        palette.text,
    );
    hint(
        ui,
        palette,
        "Match selected files through the music API. Leave the lookup blank to use each file's ISRC, artist, and title.",
    );
    widgets::text_edit(
        ui,
        locale,
        egui::TextEdit::singleline(&mut state.enrich_query)
            .hint_text("Optional Spotify track link or search")
            .desired_width(ui.available_width().min(600.0)),
    );
    hint(
        ui,
        palette,
        "Matching order: supplied link, embedded source link, ISRC, then artist/title/duration. Conflicting recording codes are rejected.",
    );
    ui.checkbox(
        &mut state.enrich_overwrite,
        "Replace existing tags in the new copies",
    );
    run_button(
        ui,
        palette,
        "Find and save tagged copies",
        ToolOperation::Enrich,
        actions,
    );
}

fn document_summary(ui: &mut egui::Ui, palette: &Palette, document: &AudioDocument) {
    ui.add_space(12.0);
    theme::text(
        ui,
        filename(&document.path),
        theme::medium(14.0),
        palette.text,
    );
    hint(
        ui,
        palette,
        &format!(
            "{} · {} · {:.1} MB",
            document.quality.label(),
            crate::util::format_duration_ms(document.duration_ms.min(u32::MAX as u64) as u32),
            document.bytes as f64 / 1_048_576.0
        ),
    );
    hint(
        ui,
        palette,
        &format!(
            "{} · {}",
            if document.has_artwork {
                "Embedded artwork"
            } else {
                "No embedded artwork"
            },
            if document.lyrics.is_some() {
                "Embedded lyrics"
            } else {
                "No embedded lyrics"
            }
        ),
    );
    for key in ["title", "artist", "album", "date", "isrc"] {
        if let Some(value) = document.tags.get(key) {
            hint(ui, palette, &format!("{key}: {value}"));
        }
    }
}

fn results(
    ui: &mut egui::Ui,
    palette: &Palette,
    state: &mut ToolsViewState,
    actions: &mut Vec<DownloadAction>,
) {
    if state.results.is_empty() {
        return;
    }
    ui.add_space(14.0);
    theme::section_title(ui, palette, "Results");
    if state.results.len() > 1 {
        egui::ScrollArea::vertical()
            .id_salt("tool-result-list")
            .max_height(240.0)
            .show_rows(ui, 32.0, state.results.len(), |ui, range| {
                for index in range {
                    let file = &state.results[index];
                    let status = if file.error.is_some() {
                        "Failed"
                    } else if file.output.is_some() {
                        "Saved"
                    } else {
                        "Ready"
                    };
                    if ui
                        .add(
                            egui::Button::new(format!("{} · {status}", filename(&file.input)))
                                .selected(state.result_focus == index)
                                .truncate(),
                        )
                        .on_hover_text(file.input.display().to_string())
                        .clicked()
                    {
                        state.result_focus = index;
                    }
                }
            });
    }
    let spectrogram_key = (
        state.request,
        state.result_focus,
        state.spectrum_palette,
        state.frequency_scale,
    );
    let spectrogram_texture = &mut state.spectrogram_texture;
    for result in state.results.get(state.result_focus).into_iter() {
        ui.add_space(8.0);
        egui::CollapsingHeader::new(filename(&result.input)).id_salt(("tools-result", &result.input)).default_open(true).show(ui, |ui| {
            if let Some(error) = &result.error { ui.colored_label(palette.warning, error); }
            for warning in &result.warnings { hint(ui, palette, warning); }
            if let Some(document) = &result.document { document_summary(ui, palette, document); }
            if let Some(gain) = &result.replay_gain {
                hint(ui, palette, &format!("Track gain: {:+.2} dB · Loudness: {:.1} LUFS · True peak: {:.1} dBFS", gain.track_gain_db, gain.integrated_lufs, gain.true_peak_dbfs));
                if let Some(album) = gain.album_gain_db { hint(ui, palette, &format!("Album gain: {album:+.2} dB")); }
            }
            if let Some(analysis) = &result.analysis {
                hint(ui, palette, &format!("Analyzed {:.1}s · Peak {:.1} dBFS · RMS {:.1} dBFS · Crest {:.1} dB · {} clipped samples", analysis.analyzed_seconds, analysis.peak_dbfs, analysis.rms_dbfs, analysis.crest_db, analysis.clipping_samples));
                if let Some(tempo) = &analysis.bpm { hint(ui, palette, &format!("Estimated tempo: {:.1} BPM · confidence {:.0}%", tempo.bpm, tempo.confidence * 100.0)); }
                if let Some(key) = &analysis.key { hint(ui, palette, &format!("Estimated key: {} · confidence {:.0}%", key.key, key.confidence * 100.0)); }
                if let Some(data)=&analysis.spectrogram {
                    spectrogram(ui,palette,data,analysis.analyzed_seconds,spectrogram_texture,spectrogram_key);
                }
                if !analysis.spectrum.is_empty() {
                    let points: Vec<_> = analysis.spectrum.iter().map(|point| (point.frequency_hz, point.level_db)).collect();
                    graph(ui, palette, "Spectrum · dBFS by frequency", &points, true);
                }
                if !analysis.waveform.is_empty() {
                    let points: Vec<_> = analysis.waveform.iter().enumerate().map(|(index, value)| (index as f32, *value)).collect();
                    graph(ui, palette, "Waveform · analyzed portion", &points, false);
                }
                for note in &analysis.notes { hint(ui, palette, note); }
            }
            if let Some(path) = &result.output {
                hint(ui, palette, &path.display().to_string());
                ui.horizontal(|ui| {
                    if theme::soft_button(ui, palette, Some(Icon::Folder), "Reveal", false).clicked() { actions.push(DownloadAction::Reveal(path.clone())); }
                    if theme::soft_button(ui, palette, Some(Icon::ExternalLink), "Open file", false).clicked() { actions.push(DownloadAction::OpenFile(path.clone())); }
                });
            }
        });
    }
}

fn spectrogram(
    ui: &mut egui::Ui,
    palette: &Palette,
    data: &Spectrogram,
    duration: f64,
    cache: &mut Option<(
        (u64, usize, SpectrumPalette, FrequencyScale),
        egui::TextureHandle,
    )>,
    key: (u64, usize, SpectrumPalette, FrequencyScale),
) {
    if cache.as_ref().is_none_or(|(cached, _)| *cached != key) {
        match crate::music_downloads::tools::spectrogram_rgb(
            data,
            key.2,
            key.3,
            768,
            384,
            &crate::music_downloads::Cancellation::default(),
        ) {
            Ok(rgb) => {
                let image = egui::ColorImage::from_rgb([768, 384], &rgb);
                *cache = Some((
                    key,
                    ui.ctx().load_texture(
                        "audio-tools-spectrogram",
                        image,
                        egui::TextureOptions::LINEAR,
                    ),
                ));
            }
            Err(error) => {
                ui.colored_label(palette.warning, error);
                return;
            }
        }
    }
    let Some((_, texture)) = cache else {
        return;
    };
    theme::text(
        ui,
        "Spectrogram · time and frequency",
        theme::medium(13.0),
        palette.text,
    );
    let width = ui.available_width().max(220.0);
    let height = (width * 0.43).clamp(230.0, 360.0);
    let (rect, response) = ui.allocate_exact_size(vec2(width, height), Sense::hover());
    let plot = egui::Rect::from_min_max(rect.min + vec2(56.0, 9.0), rect.max - vec2(66.0, 35.0));
    ui.painter().image(
        texture.id(),
        plot,
        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
        egui::Color32::WHITE,
    );
    let low = data.frequencies_hz[0];
    let high = *data.frequencies_hz.last().unwrap();
    for index in 0..=4 {
        let fraction = index as f32 / 4.0;
        let y = plot.bottom() - fraction * plot.height();
        let frequency = match key.3 {
            FrequencyScale::Linear => low + (high - low) * fraction,
            FrequencyScale::Logarithmic => low * (high / low).powf(fraction),
        };
        let label = if frequency >= 1000.0 {
            format!("{:.1}k", frequency / 1000.0)
        } else {
            format!("{frequency:.0}")
        };
        ui.painter().text(
            egui::pos2(plot.left() - 8.0, y),
            egui::Align2::RIGHT_CENTER,
            label,
            egui::FontId::proportional(11.0),
            palette.secondary,
        );
        let x = plot.left() + fraction * plot.width();
        ui.painter().text(
            egui::pos2(x, plot.bottom() + 10.0),
            egui::Align2::CENTER_TOP,
            format!("{:.1}s", duration * fraction as f64),
            egui::FontId::proportional(11.0),
            palette.secondary,
        );
    }
    for index in 0..120 {
        let a = index as f32 / 120.0;
        let b = (index + 1) as f32 / 120.0;
        let rgb = crate::music_downloads::tools::spectrogram_color(-120.0 * a, key.2);
        ui.painter().rect_filled(
            egui::Rect::from_min_max(
                egui::pos2(plot.right() + 14.0, plot.top() + plot.height() * a),
                egui::pos2(plot.right() + 24.0, plot.top() + plot.height() * b),
            ),
            0,
            egui::Color32::from_rgb(rgb[0], rgb[1], rgb[2]),
        );
    }
    for (fraction, label) in [(0.0, "0"), (0.5, "-60"), (1.0, "-120")] {
        ui.painter().text(
            egui::pos2(plot.right() + 30.0, plot.top() + fraction * plot.height()),
            egui::Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(10.0),
            palette.secondary,
        );
    }
    if let Some(position) = response
        .hover_pos()
        .filter(|position| plot.contains(*position))
    {
        let time = ((position.x - plot.left()) / plot.width()).clamp(0.0, 1.0);
        let frequency = (1.0 - (position.y - plot.top()) / plot.height()).clamp(0.0, 1.0);
        let frequency = match key.3 {
            FrequencyScale::Linear => low + (high - low) * frequency,
            FrequencyScale::Logarithmic => low * (high / low).powf(frequency),
        };
        let frame = (time * (data.levels_db.len() - 1) as f32).round() as usize;
        let band = data
            .frequencies_hz
            .partition_point(|value| *value < frequency)
            .min(data.frequencies_hz.len() - 1);
        response.on_hover_ui(|ui| {
            ui.label(format!(
                "{:.2}s · {:.0} Hz · {:.1} dBFS",
                data.times_seconds[frame], frequency, data.levels_db[frame][band]
            ));
        });
    }
}

fn graph(
    ui: &mut egui::Ui,
    palette: &Palette,
    label: &str,
    data: &[(f32, f32)],
    logarithmic: bool,
) {
    hint(ui, palette, label);
    let (rect, response) =
        ui.allocate_exact_size(vec2(ui.available_width().min(700.0), 150.0), Sense::hover());
    response.widget_info(|| egui::WidgetInfo::labeled(egui::WidgetType::Other, true, label));
    if !ui.is_rect_visible(rect) {
        return;
    }
    let plot = rect.shrink2(vec2(5.0, 12.0));
    ui.painter().rect_filled(plot, 4, palette.panel);
    let transformed: Vec<_> = data
        .iter()
        .filter(|(x, y)| x.is_finite() && y.is_finite() && (!logarithmic || *x > 0.0))
        .map(|(x, y)| (if logarithmic { x.log10() } else { *x }, *y))
        .collect();
    if transformed.len() < 2 {
        return;
    }
    let low_x = transformed.first().unwrap().0;
    let high_x = transformed.last().unwrap().0.max(low_x + 0.001);
    let (low_y, high_y) = if logarithmic {
        (-100.0, 0.0)
    } else {
        (-1.0, 1.0)
    };
    for fraction in [0.25, 0.5, 0.75] {
        let y = plot.bottom() - plot.height() * fraction;
        ui.painter()
            .hline(plot.x_range(), y, Stroke::new(1.0, palette.outline));
    }
    let points: Vec<_> = transformed
        .iter()
        .map(|(x, y)| {
            egui::pos2(
                plot.left() + ((*x - low_x) / (high_x - low_x)).clamp(0.0, 1.0) * plot.width(),
                plot.bottom() - ((*y - low_y) / (high_y - low_y)).clamp(0.0, 1.0) * plot.height(),
            )
        })
        .collect();
    ui.painter()
        .add(egui::Shape::line(points, Stroke::new(1.5, palette.accent)));
    let ends = if logarithmic {
        (
            format!("{:.0} Hz", 10.0_f32.powf(low_x)),
            format!("{:.1} kHz", 10.0_f32.powf(high_x) / 1000.0),
        )
    } else {
        ("Start".into(), "End".into())
    };
    ui.painter().text(
        rect.left_bottom(),
        egui::Align2::LEFT_BOTTOM,
        ends.0,
        theme::regular(10.0),
        palette.secondary,
    );
    ui.painter().text(
        rect.right_bottom(),
        egui::Align2::RIGHT_BOTTOM,
        ends.1,
        theme::regular(10.0),
        palette.secondary,
    );
}
fn combo<T: Copy + PartialEq>(
    ui: &mut egui::Ui,
    label: &str,
    id: &str,
    value: &mut T,
    choices: &[(T, &str)],
) {
    ui.vertical(|ui| {
        ui.label(RichText::new(label).size(12.0).weak());
        let current = choices
            .iter()
            .find(|(choice, _)| *choice == *value)
            .map(|(_, label)| *label)
            .unwrap_or("Custom");
        egui::ComboBox::from_id_salt(id)
            .selected_text(current)
            .width(160.0)
            .show_ui(ui, |ui| {
                for &(choice, label) in choices {
                    ui.selectable_value(value, choice, label);
                }
            });
    });
}
fn run_button(
    ui: &mut egui::Ui,
    palette: &Palette,
    label: &str,
    operation: ToolOperation,
    actions: &mut Vec<DownloadAction>,
) {
    ui.add_space(8.0);
    if theme::pill_button(ui, palette, label, true).clicked() {
        actions.push(DownloadAction::Tools(ToolAction::Run(operation)));
    }
}
fn hint(ui: &mut egui::Ui, palette: &Palette, text: &str) {
    ui.add(egui::Label::new(RichText::new(text).size(13.0).color(palette.secondary)).wrap());
}
fn filename(path: &Path) -> String {
    let name = path
        .file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy();
    if name.is_empty() {
        "Audio operation".into()
    } else {
        name.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::music_downloads::AudioQuality;

    #[test]
    fn standalone_lyric_editor_and_spectrum_requests_preserve_explicit_options() {
        let path = PathBuf::from("/music/track.lrc");
        let mut state = ToolsViewState::default();
        state.add_paths([path.clone()]);
        state.accept(ToolsResult {
            files: vec![ToolsFileResult {
                input: path.clone(),
                lyric_document: Some(LyricsDocument {
                    path: path.clone(),
                    text: "[00:01.00]Synthetic line".into(),
                    synced: true,
                }),
                ..Default::default()
            }],
            ..Default::default()
        });
        assert_eq!(state.focused, Some(path.clone()));
        assert!(!state.lyrics_plain_text);
        state.lyrics = "[00:02.00]Edited line".into();
        state.lyrics_plain_text = true;
        let ToolsRequest::SaveLyrics {
            path: input,
            text,
            plain_text,
            ..
        } = state.build_request(ToolOperation::SaveLyrics).unwrap()
        else {
            panic!("Expected lyric edit")
        };
        assert_eq!(input, path);
        assert_eq!(text, "[00:02.00]Edited line");
        assert!(plain_text);
        assert!(state.build_request(ToolOperation::TranslateLyrics).is_err());
        state.lyrics_options.translation_provider =
            crate::music_downloads::LyricsTranslationProvider::Claude;
        state.lyrics_options.language = "Italian".into();
        let ToolsRequest::TranslateLyrics { text, options, .. } =
            state.build_request(ToolOperation::TranslateLyrics).unwrap()
        else {
            panic!("Expected translation")
        };
        assert_eq!(text, state.lyrics);
        assert_eq!(options.language, "Italian");
        state.fft_size = 32768;
        state.spectrum_window = SpectrumWindow::Blackman;
        state.spectrum_palette = SpectrumPalette::Hot;
        state.frequency_scale = FrequencyScale::Logarithmic;
        state.export_spectrum = true;
        let ToolsRequest::AnalyzeSpectrum {
            fft_size,
            window,
            palette,
            frequency_scale,
            export_dir,
            ..
        } = state.build_request(ToolOperation::Analyze).unwrap()
        else {
            panic!("Expected spectrum")
        };
        assert_eq!(fft_size, 32768);
        assert_eq!(window, SpectrumWindow::Blackman);
        assert_eq!(palette, SpectrumPalette::Hot);
        assert_eq!(frequency_scale, FrequencyScale::Logarithmic);
        assert_eq!(export_dir, Some(state.output_dir));
    }

    fn document(path: &Path, title: &str) -> AudioDocument {
        AudioDocument {
            path: path.into(),
            bytes: 1024,
            duration_ms: 30_000,
            quality: AudioQuality::default(),
            tags: BTreeMap::from([("title".into(), title.into())]),
            lyrics: None,
            has_artwork: false,
        }
    }

    #[test]
    fn converted_outputs_keep_original_metadata_selection_and_requests() {
        let original = PathBuf::from("/music/original.mp3");
        let output = PathBuf::from("/music/Tools/converted.flac");
        let mut state = ToolsViewState::default();
        state.add_paths([original.clone()]);
        state.accept(ToolsResult {
            files: vec![ToolsFileResult {
                input: original.clone(),
                document: Some(document(&original, "Original title")),
                ..Default::default()
            }],
            ..Default::default()
        });
        state.accept(ToolsResult {
            files: vec![ToolsFileResult {
                input: original.clone(),
                output: Some(output.clone()),
                document: Some(document(&output, "Updated title")),
                ..Default::default()
            }],
            ..Default::default()
        });

        assert_eq!(state.focused, Some(original.clone()));
        assert_eq!(state.tags["title"], "Original title");
        assert_eq!(state.documents[&original].path, original);
        assert_eq!(state.documents[&output].tags["title"], "Updated title");
        assert!(state.paths.contains(&output));
        assert_eq!(state.selected_paths(), vec![original.clone()]);
        let ToolsRequest::AnalyzeSpectrum { paths, .. } =
            state.build_request(ToolOperation::Analyze).unwrap()
        else {
            panic!("Expected analysis request");
        };
        assert_eq!(paths, vec![original.clone()]);
        let ToolsRequest::Edit { path, tags, .. } =
            state.build_request(ToolOperation::SaveTags).unwrap()
        else {
            panic!("Expected metadata request");
        };
        assert_eq!(path, original);
        assert_eq!(tags["title"], "Original title");

        state.focus(output.clone());
        let ToolsRequest::Edit { path, tags, .. } =
            state.build_request(ToolOperation::SaveTags).unwrap()
        else {
            panic!("Expected metadata request");
        };
        assert_eq!(path, output);
        assert_eq!(tags["title"], "Updated title");
    }

    #[test]
    fn output_document_does_not_mark_uninspected_original_as_inspected() {
        let original = PathBuf::from("/music/original.mp3");
        let output = PathBuf::from("/music/Tools/converted.flac");
        let mut state = ToolsViewState::default();
        state.add_paths([original.clone()]);
        state.accept(ToolsResult {
            files: vec![ToolsFileResult {
                input: original.clone(),
                output: Some(output.clone()),
                document: Some(document(&output, "Converted")),
                ..Default::default()
            }],
            ..Default::default()
        });
        assert!(!state.documents.contains_key(&original));
        assert!(state.documents.contains_key(&output));
        assert!(state.focused.is_none());
        assert!(state.build_request(ToolOperation::SaveTags).is_err());
        assert_eq!(state.selected_paths(), vec![original]);
    }
}
