use super::*;
#[cfg(test)]
use std::io::Write;
use std::{
    f64::consts::PI,
    ffi::OsString,
    io::{Read, Seek, SeekFrom},
};
const MAX_PCM_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ANALYSIS_SECONDS: f64 = 7200.0;

pub(super) fn analyze(
    document: &AudioDocument,
    tempo_key: bool,
    spectrum: bool,
    cancel: &Cancellation,
) -> Result<AudioAnalysis, String> {
    analyze_with_options(
        document,
        tempo_key,
        spectrum,
        8192,
        SpectrumWindow::Hann,
        cancel,
    )
}
pub(super) fn analyze_with_options(
    document: &AudioDocument,
    tempo_key: bool,
    spectrum: bool,
    fft_size: usize,
    window: SpectrumWindow,
    cancel: &Cancellation,
) -> Result<AudioAnalysis, String> {
    validate_fft(fft_size)?;
    let scratch = Scratch::new()?;
    let decoded = scratch.0.join("analysis.f32");
    let rate = document.quality.sample_rate;
    if !(8000..=768000).contains(&rate) {
        return Err("Analysis supports original sample rates from 8 to 768 kHz.".into());
    }
    let seconds = document.duration_ms as f64 / 1000.0;
    if seconds > MAX_ANALYSIS_SECONDS || seconds * rate as f64 * 4.0 >= MAX_PCM_BYTES as f64 {
        return Err("This file exceeds the two-hour or 2 GB decoded-audio analysis limit.".into());
    }
    let mut args: Vec<OsString> = ["-nostdin", "-hide_banner", "-v", "error", "-n", "-i"]
        .into_iter()
        .map(Into::into)
        .collect();
    args.push(document.path.as_os_str().to_owned());
    args.extend([
        "-map".into(),
        "0:a:0".into(),
        "-t".into(),
        MAX_ANALYSIS_SECONDS.to_string().into(),
        "-fs".into(),
        MAX_PCM_BYTES.to_string().into(),
        "-ac".into(),
        "1".into(),
        "-c:a".into(),
        "pcm_f32le".into(),
        "-f".into(),
        "f32le".into(),
        decoded.as_os_str().to_owned(),
    ]);
    crate::music_downloads::export::command_output("ffmpeg", &args, &scratch.0, cancel)?;
    analyze_pcm(
        &decoded, rate, tempo_key, spectrum, fft_size, window, cancel,
    )
}

fn db(value: f64) -> f32 {
    (20.0 * value.max(1e-8).log10()) as f32
}
#[cfg(test)]
fn analyze_samples(
    samples: &[f32],
    rate: u32,
    tempo_key: bool,
    spectrum: bool,
    cancel: &Cancellation,
) -> Result<AudioAnalysis, String> {
    analyze_samples_with_options(
        samples,
        rate,
        tempo_key,
        spectrum,
        8192,
        SpectrumWindow::Hann,
        cancel,
    )
}
fn validate_fft(size: usize) -> Result<(), String> {
    if !(1024..=32768).contains(&size) || !size.is_power_of_two() {
        Err("FFT size must be a power of two between 1,024 and 32,768.".into())
    } else {
        Ok(())
    }
}
fn window_value(window: SpectrumWindow, index: usize, size: usize) -> f64 {
    let angle = 2.0 * PI * index as f64 / (size - 1) as f64;
    match window {
        SpectrumWindow::Hann => 0.5 - 0.5 * angle.cos(),
        SpectrumWindow::Hamming => 0.54 - 0.46 * angle.cos(),
        SpectrumWindow::Blackman => 0.42 - 0.5 * angle.cos() + 0.08 * (2.0 * angle).cos(),
        SpectrumWindow::Rectangular => 1.0,
    }
}
#[cfg(test)]
fn analyze_samples_with_options(
    samples: &[f32],
    rate: u32,
    tempo_key: bool,
    spectrum: bool,
    fft_size: usize,
    window: SpectrumWindow,
    cancel: &Cancellation,
) -> Result<AudioAnalysis, String> {
    let scratch = Scratch::new()?;
    let path = scratch.0.join("test.pcm");
    let mut file =
        std::io::BufWriter::new(std::fs::File::create(&path).map_err(|error| error.to_string())?);
    for &sample in samples {
        file.write_all(&sample.to_le_bytes())
            .map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())?;
    analyze_pcm(&path, rate, tempo_key, spectrum, fft_size, window, cancel)
}
fn analyze_pcm(
    path: &Path,
    rate: u32,
    tempo_key: bool,
    spectrum: bool,
    fft_size: usize,
    window: SpectrumWindow,
    cancel: &Cancellation,
) -> Result<AudioAnalysis, String> {
    validate_fft(fft_size)?;
    let bytes = std::fs::metadata(path)
        .map_err(|error| error.to_string())?
        .len();
    if bytes == 0 || bytes % 4 != 0 {
        return Err("The decoded audio is empty or incomplete.".into());
    }
    let sample_count = bytes as usize / 4;
    if bytes >= MAX_PCM_BYTES || sample_count as f64 / rate as f64 >= MAX_ANALYSIS_SECONDS {
        return Err("This file exceeds the two-hour or 2 GB decoded-audio analysis limit. No partial analysis was reported.".into());
    }
    let (mut result, envelope) = measure_pcm(path, sample_count, rate, tempo_key, cancel)?;
    if spectrum || tempo_key {
        let size = fft_size;
        let weights: Vec<f64> = (0..size)
            .map(|index| window_value(window, index, size))
            .collect();
        let normalization = weights.iter().sum::<f64>().powi(2);
        let mut power = vec![0.0; size / 2];
        let mut chroma = [0.0; 12];
        let mut frames = 0;
        let maximum = rate as f64 / 2.0;
        let bands: Vec<_> = (0..512)
            .map(|index| {
                let low = 20.0 * (maximum / 20.0).powf(index as f64 / 512.0);
                let high = 20.0 * (maximum / 20.0).powf((index + 1) as f64 / 512.0);
                let start =
                    ((low * size as f64 / rate as f64).floor() as usize).clamp(1, size / 2 - 1);
                let end =
                    ((high * size as f64 / rate as f64).ceil() as usize).clamp(start + 1, size / 2);
                (start, end, (low * high).sqrt() as f32)
            })
            .collect();
        let mut spectrogram = Spectrogram {
            frequencies_hz: bands.iter().map(|band| band.2).collect(),
            ..Default::default()
        };
        let window_count = if sample_count <= size {
            1
        } else {
            (sample_count / (rate as usize / 5).max(1)).clamp(1, 450)
        };
        let maximum_start = sample_count.saturating_sub(size);
        let mut pcm = std::fs::File::open(path).map_err(|error| error.to_string())?;
        let mut bytes = vec![0u8; size * 4];
        for index in 0..window_count {
            cancel.check()?;
            let start = if window_count == 1 {
                0
            } else {
                maximum_start * index / (window_count - 1)
            };
            let count = (sample_count - start).min(size);
            pcm.seek(SeekFrom::Start(start as u64 * 4))
                .map_err(|error| error.to_string())?;
            pcm.read_exact(&mut bytes[..count * 4])
                .map_err(|error| error.to_string())?;
            let mut real = vec![0.0; size];
            for (offset, raw) in bytes[..count * 4].chunks_exact(4).enumerate() {
                let sample = f32::from_le_bytes(raw.try_into().unwrap());
                real[offset] = if sample.is_finite() {
                    sample as f64 * weights[offset]
                } else {
                    0.0
                };
            }
            let mut imag = vec![0.0; size];
            fft(&mut real, &mut imag);
            let mut frame_power = vec![0.0; size / 2];
            for bin in 1..size / 2 {
                let magnitude = (real[bin] * real[bin] + imag[bin] * imag[bin]) / normalization;
                power[bin] += magnitude;
                frame_power[bin] = magnitude;
                let frequency = bin as f64 * rate as f64 / size as f64;
                if (55.0..=5000.0).contains(&frequency) {
                    let midi = (69.0 + 12.0 * (frequency / 440.0).log2()).round() as i32;
                    chroma[midi.rem_euclid(12) as usize] += magnitude.sqrt();
                }
            }
            if spectrum {
                spectrogram
                    .times_seconds
                    .push(((start + size / 2).min(sample_count) as f64 / rate as f64) as f32);
                spectrogram.levels_db.push(
                    bands
                        .iter()
                        .map(|&(start, end, _)| {
                            db(2.0
                                * frame_power[start..end]
                                    .iter()
                                    .copied()
                                    .fold(0.0, f64::max)
                                    .sqrt())
                        })
                        .collect(),
                );
            }
            frames += 1;
        }
        if spectrum {
            result.spectrogram = Some(spectrogram);
        }
        if frames > 0 {
            for value in &mut power {
                *value /= frames as f64;
            }
            if spectrum {
                let maximum = rate as f64 / 2.0;
                for index in 0..160 {
                    let low = 20.0 * (maximum / 20.0).powf(index as f64 / 160.0);
                    let high = 20.0 * (maximum / 20.0).powf((index + 1) as f64 / 160.0);
                    let start =
                        ((low * size as f64 / rate as f64).floor() as usize).clamp(1, size / 2 - 1);
                    let end = ((high * size as f64 / rate as f64).ceil() as usize)
                        .clamp(start + 1, size / 2);
                    let value = power[start..end].iter().copied().fold(0.0, f64::max);
                    result.spectrum.push(SpectrumPoint {
                        frequency_hz: (low * high).sqrt() as f32,
                        level_db: db(2.0 * value.sqrt()),
                    });
                }
                let total: f64 = power.iter().sum();
                if total > 1e-12 {
                    let mut accumulated = 0.0;
                    for (bin, value) in power.iter().enumerate() {
                        accumulated += value;
                        if accumulated >= total * 0.999 {
                            result.high_frequency_rolloff_hz =
                                Some(bin as f32 * rate as f32 / size as f32);
                            break;
                        }
                    }
                }
                result.notes.push("The rolloff indicator is the frequency below which 99.9% of the measured spectral energy lies; it is not a codec detector.".into());
            }
            if tempo_key {
                result.key = estimate_key(chroma);
            }
        }
    }
    if tempo_key {
        result.bpm = estimate_tempo_envelope(
            &envelope,
            rate as f64 / (rate as usize / 200).max(1) as f64,
            Some(cancel),
        );
        cancel.check()?;
        result.notes.push("Tempo and musical key are estimates. Half/double tempo, silence, percussion, modulation, and short excerpts can make them uncertain.".into());
    }
    result.notes.push(format!(
        "Full-track coverage: {fft_size}-point FFT, {} window; at most 450 sampled windows across the entire duration. Brief events between windows may be missed.",
        window.label()
    ));
    Ok(result)
}
fn measure_pcm(
    path: &Path,
    count: usize,
    rate: u32,
    tempo_key: bool,
    cancel: &Cancellation,
) -> Result<(AudioAnalysis, Vec<f64>), String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut buffer = [0u8; 65536];
    let mut remaining = count * 4;
    let mut index = 0;
    let mut sum = 0.0;
    let mut peak = 0.0_f64;
    let mut clipped = 0;
    let mut waveform = vec![0.0_f32; 384];
    let mut envelope = Vec::new();
    let step = (rate as usize / 200).max(1);
    let mut energy = 0.0;
    let mut energy_count = 0;
    while remaining > 0 {
        cancel.check()?;
        let bytes = remaining.min(buffer.len());
        file.read_exact(&mut buffer[..bytes])
            .map_err(|error| error.to_string())?;
        for raw in buffer[..bytes].chunks_exact(4) {
            let sample = f32::from_le_bytes(raw.try_into().unwrap());
            let sample = if sample.is_finite() {
                sample as f64
            } else {
                0.0
            };
            sum += sample * sample;
            peak = peak.max(sample.abs());
            clipped += u64::from(sample.abs() >= 1.0);
            let bucket = (index * 384 / count).min(383);
            waveform[bucket] = waveform[bucket].max(sample.abs() as f32);
            if tempo_key {
                energy += sample * sample;
                energy_count += 1;
                if energy_count == step {
                    envelope.push((energy / step as f64).sqrt());
                    energy = 0.0;
                    energy_count = 0;
                }
            }
            index += 1;
        }
        remaining -= bytes;
    }
    if tempo_key && energy_count > 0 {
        envelope.push((energy / energy_count as f64).sqrt());
    }
    let rms = (sum / count as f64).sqrt();
    Ok((AudioAnalysis{analyzed_seconds:count as f64/rate as f64,analysis_sample_rate:rate,peak_dbfs:db(peak),rms_dbfs:db(rms),crest_db:db(peak)-db(rms),clipping_samples:clipped,waveform,notes:vec!["Levels and waveform measure the full track as a mono mix. Stereo cancellation can change the measured level.".into(),"A spectrum or frequency cutoff cannot prove the original source or whether a lossless file was previously lossy.".into()],..Default::default()},envelope))
}

fn fft(real: &mut [f64], imag: &mut [f64]) {
    let n = real.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            real.swap(i, j);
            imag.swap(i, j);
        }
    }
    let mut width = 2;
    while width <= n {
        let angle = -2.0 * PI / width as f64;
        for start in (0..n).step_by(width) {
            for offset in 0..width / 2 {
                let (sine, cosine) = (angle * offset as f64).sin_cos();
                let even = start + offset;
                let odd = even + width / 2;
                let tr = real[odd] * cosine - imag[odd] * sine;
                let ti = real[odd] * sine + imag[odd] * cosine;
                real[odd] = real[even] - tr;
                imag[odd] = imag[even] - ti;
                real[even] += tr;
                imag[even] += ti;
            }
        }
        width *= 2;
    }
}
#[cfg(test)]
fn estimate_tempo(samples: &[f32], rate: u32) -> Option<TempoEstimate> {
    let step = (rate as usize / 200).max(1);
    let envelope: Vec<f64> = samples
        .chunks(step)
        .map(|chunk| {
            (chunk.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / chunk.len() as f64).sqrt()
        })
        .collect();
    estimate_tempo_envelope(&envelope, rate as f64 / step as f64, None)
}
fn estimate_tempo_envelope(
    envelope: &[f64],
    envelope_rate: f64,
    cancel: Option<&Cancellation>,
) -> Option<TempoEstimate> {
    if envelope.len() < 800 {
        return None;
    }
    let onset: Vec<f64> = envelope
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).max(0.0))
        .collect();
    let energy: f64 = onset.iter().map(|v| v * v).sum();
    if energy < 1e-8 {
        return None;
    }
    let mut scores = Vec::new();
    for lag in (envelope_rate * 60.0 / 200.0).round() as usize
        ..=(envelope_rate * 60.0 / 60.0).round() as usize
    {
        if cancel.is_some_and(Cancellation::is_cancelled) {
            return None;
        }
        let cross: f64 = onset[lag..]
            .iter()
            .zip(&onset[..onset.len() - lag])
            .map(|(a, b)| a * b)
            .sum();
        let correlation = cross / energy;
        let bpm = envelope_rate * 60.0 / lag as f64;
        let prior = if (85.0..=165.0).contains(&bpm) {
            1.0
        } else {
            0.88
        };
        scores.push((correlation * prior, correlation, bpm));
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (_, correlation, bpm) = *scores.first()?;
    if correlation < 0.08 {
        return None;
    }
    Some(TempoEstimate {
        bpm: bpm as f32,
        confidence: (correlation * 0.85).clamp(0.0, 0.90) as f32,
    })
}
fn estimate_key(chroma: [f64; 12]) -> Option<KeyEstimate> {
    let total: f64 = chroma.iter().sum();
    if total <= 1e-10 {
        return None;
    }
    let major = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    let minor = [
        6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    let mut scores = Vec::new();
    let mean = total / 12.0;
    let norm = chroma
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm < 1e-10 {
        return None;
    }
    for (mode, profile) in [major, minor].iter().enumerate() {
        let pm = profile.iter().sum::<f64>() / 12.0;
        let pn = profile
            .iter()
            .map(|value| (value - pm).powi(2))
            .sum::<f64>()
            .sqrt();
        for tonic in 0..12 {
            let score = (0..12)
                .map(|pitch| (chroma[pitch] - mean) * (profile[(pitch + 12 - tonic) % 12] - pm))
                .sum::<f64>()
                / (norm * pn);
            scores.push((score, tonic, mode));
        }
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (score, tonic, mode) = scores[0];
    if score < 0.25 {
        return None;
    }
    let confidence = ((score - scores[1].0).max(0.0) * 3.0).min(0.85);
    let names = [
        "C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
    ];
    Some(KeyEstimate {
        key: format!(
            "{} {}",
            names[tonic],
            if mode == 0 { "major" } else { "minor" }
        ),
        confidence: confidence as f32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spectrum_measures_known_frequency_and_level() {
        let rate = 44100;
        let samples: Vec<_> = (0..rate * 2)
            .map(|i| (2.0 * PI * 1000.0 * i as f64 / rate as f64).sin() as f32 * 0.5)
            .collect();
        let result =
            analyze_samples(&samples, rate, false, true, &Cancellation::default()).unwrap();
        assert!((result.peak_dbfs + 6.0206).abs() < 0.02);
        assert!((result.rms_dbfs + 9.0309).abs() < 0.02);
        let peak = result
            .spectrum
            .iter()
            .max_by(|a, b| a.level_db.total_cmp(&b.level_db))
            .unwrap();
        assert!((peak.frequency_hz - 1000.0).abs() < 50.0);
        assert!(result.bpm.is_none());
    }
    #[test]
    fn regular_clicks_produce_tentative_120_bpm() {
        let rate = 8000;
        let mut samples = vec![0.0; rate * 12];
        for beat in 0..24 {
            for offset in 0..100 {
                samples[beat * rate / 2 + offset] = 0.7 * (1.0 - offset as f32 / 100.0);
            }
        }
        let estimate = estimate_tempo(&samples, rate as u32).unwrap();
        assert!((estimate.bpm - 120.0).abs() < 2.0);
        assert!(estimate.confidence < 1.0);
        assert!(estimate_tempo(&vec![0.0; rate * 12], rate as u32).is_none());
    }
    #[test]
    fn key_profile_is_an_estimate_not_a_claim() {
        let result = estimate_key([
            6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
        ])
        .unwrap();
        assert_eq!(result.key, "C major");
        assert!(result.confidence < 1.0);
        assert!(estimate_key([0.0; 12]).is_none());
    }
}

pub(super) fn export_png(
    document: &AudioDocument,
    analysis: &AudioAnalysis,
    size: usize,
    window: SpectrumWindow,
    palette: SpectrumPalette,
    frequency_scale: FrequencyScale,
    directory: &Path,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    super::spectrum_image::export(
        document,
        analysis,
        size,
        window,
        palette,
        frequency_scale,
        directory,
        cancel,
    )
}

#[cfg(test)]
mod configurable_tests {
    use super::*;
    #[test]
    fn decoder_covers_tracks_beyond_ninety_seconds_at_original_rate() {
        if !crate::music_downloads::tool_available("ffmpeg")
            || !crate::music_downloads::tool_available("ffprobe")
        {
            return;
        }
        let scratch = Scratch::new().unwrap();
        let source = scratch.0.join("long-source.wav");
        let cancel = Cancellation::default();
        let args = vec![
            "-nostdin".into(),
            "-v".into(),
            "error".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=880:sample_rate=8000:duration=96".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            source.as_os_str().to_owned(),
        ];
        crate::music_downloads::export::command_output("ffmpeg", &args, &scratch.0, &cancel)
            .unwrap();
        let document = inspect(&source, &cancel).unwrap();
        let result =
            analyze_with_options(&document, false, true, 1024, SpectrumWindow::Hann, &cancel)
                .unwrap();
        assert!((result.analyzed_seconds - 96.0).abs() < 0.01);
        assert_eq!(result.analysis_sample_rate, 8000);
        assert!(result.spectrogram.unwrap().times_seconds.last().unwrap() > &95.0);
        let oversized = scratch.0.join("oversized.pcm");
        std::fs::File::create(&oversized)
            .unwrap()
            .set_len(MAX_PCM_BYTES)
            .unwrap();
        assert!(
            analyze_pcm(
                &oversized,
                8000,
                false,
                true,
                1024,
                SpectrumWindow::Hann,
                &cancel
            )
            .unwrap_err()
            .contains("limit")
        );
    }
    #[test]
    fn fft_limits_windows_and_png_exports_are_real_and_non_destructive() {
        assert!(validate_fft(1000).is_err());
        assert!(validate_fft(65536).is_err());
        let rate = 8000;
        let samples: Vec<_> = (0..rate * 2)
            .map(|index| (2.0 * PI * 1000.0 * index as f64 / rate as f64).sin() as f32 * 0.5)
            .collect();
        let cancel = Cancellation::default();
        for window in SpectrumWindow::ALL {
            let result =
                analyze_samples_with_options(&samples, rate, false, true, 1024, window, &cancel)
                    .unwrap();
            assert!(!result.spectrum.is_empty());
            let highest = result
                .spectrum
                .iter()
                .max_by(|a, b| a.level_db.total_cmp(&b.level_db))
                .unwrap();
            assert!((highest.frequency_hz - 1000.0).abs() < 50.0);
        }
        let scratch = Scratch::new().unwrap();
        let source = scratch.0.join("synthetic.flac");
        std::fs::write(&source, b"untouched").unwrap();
        let document = AudioDocument {
            path: source.clone(),
            bytes: 9,
            duration_ms: 2000,
            quality: AudioQuality {
                codec: "flac".into(),
                sample_rate: rate,
                ..Default::default()
            },
            tags: Default::default(),
            lyrics: None,
            has_artwork: false,
        };
        let result = analyze_samples_with_options(
            &samples,
            rate,
            false,
            true,
            4096,
            SpectrumWindow::Blackman,
            &cancel,
        )
        .unwrap();
        let first = export_png(
            &document,
            &result,
            4096,
            SpectrumWindow::Blackman,
            SpectrumPalette::Viridis,
            FrequencyScale::Linear,
            &scratch.0,
            &cancel,
        )
        .unwrap();
        let second = export_png(
            &document,
            &result,
            4096,
            SpectrumWindow::Blackman,
            SpectrumPalette::Viridis,
            FrequencyScale::Linear,
            &scratch.0,
            &cancel,
        )
        .unwrap();
        assert_ne!(first, second);
        let image = image::open(first).unwrap();
        assert_eq!((image.width(), image.height()), (1400, 820));
        assert_eq!(std::fs::read(source).unwrap(), b"untouched");
        let cancelled = Cancellation::default();
        cancelled.cancel();
        assert_eq!(
            export_png(
                &document,
                &result,
                4096,
                SpectrumWindow::Blackman,
                SpectrumPalette::Viridis,
                FrequencyScale::Linear,
                &scratch.0,
                &cancelled
            ),
            Err(CANCELLED.into())
        );
    }

    #[test]
    fn spectrogram_retains_frequency_changes_over_time_and_bounds_rendering() {
        let rate = 8000;
        let samples: Vec<f32> = (0..rate * 120)
            .map(|index| {
                let frequency = if index < rate * 100 { 1000.0 } else { 3000.0 };
                (2.0 * PI * frequency * index as f64 / rate as f64).sin() as f32 * 0.5
            })
            .collect();
        let cancel = Cancellation::default();
        let analysis = analyze_samples_with_options(
            &samples,
            rate,
            false,
            true,
            1024,
            SpectrumWindow::Hann,
            &cancel,
        )
        .unwrap();
        assert_eq!(analysis.analyzed_seconds, 120.0);
        let data = analysis.spectrogram.unwrap();
        assert!(data.times_seconds.last().unwrap() > &119.0);
        assert!(data.levels_db.len() >= 10 && data.levels_db.len() <= 450);
        assert_eq!(data.frequencies_hz.len(), 512);
        let strongest = |row: &Vec<f32>| {
            data.frequencies_hz[row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .unwrap()
                .0]
        };
        assert!((strongest(&data.levels_db[0]) - 1000.0).abs() < 50.0);
        assert!((strongest(data.levels_db.last().unwrap()) - 3000.0).abs() < 60.0);
        assert!(data.times_seconds.windows(2).all(|pair| pair[1] > pair[0]));
        for palette in SpectrumPalette::ALL {
            for scale in FrequencyScale::ALL {
                let pixels = spectrogram_rgb(&data, palette, scale, 80, 40, &cancel).unwrap();
                assert_eq!(pixels.len(), 80 * 40 * 3);
                assert!(pixels.chunks_exact(3).any(|color| color != &pixels[..3]));
            }
        }
        assert!(
            spectrogram_rgb(
                &data,
                SpectrumPalette::Viridis,
                FrequencyScale::Linear,
                4096,
                4096,
                &cancel
            )
            .is_err()
        );
        let cancelled = Cancellation::default();
        cancelled.cancel();
        assert_eq!(
            spectrogram_rgb(
                &data,
                SpectrumPalette::Viridis,
                FrequencyScale::Linear,
                80,
                40,
                &cancelled
            ),
            Err(CANCELLED.into())
        );
    }
}
