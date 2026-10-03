//! Bounded off-screen spectrum report; no GUI or user-installed fonts needed.
use super::*;
use image::{Rgb, RgbImage};
const WIDTH: u32 = 1400;
const HEIGHT: u32 = 820;
fn line(image: &mut RgbImage, from: (i32, i32), to: (i32, i32), color: [u8; 3]) {
    let (mut x, mut y) = from;
    let dx = (to.0 - x).abs();
    let dy = -(to.1 - y).abs();
    let sx = if x < to.0 { 1 } else { -1 };
    let sy = if y < to.1 { 1 } else { -1 };
    let mut error = dx + dy;
    loop {
        if x >= 0 && y >= 0 && x < WIDTH as i32 && y < HEIGHT as i32 {
            image.put_pixel(x as u32, y as u32, Rgb(color));
        }
        if (x, y) == to {
            break;
        }
        let twice = error * 2;
        if twice >= dy {
            error += dy;
            x += sx;
        }
        if twice <= dx {
            error += dx;
            y += sy;
        }
    }
}
fn glyph(character: char) -> [u8; 7] {
    match character.to_ascii_uppercase() {
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 2, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 25, 21, 19, 17, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 27, 17],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [30, 1, 1, 14, 1, 1, 30],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 16, 30, 1, 1, 30],
        '6' => [14, 16, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 1, 14],
        '-' => [0, 0, 0, 31, 0, 0, 0],
        '.' => [0, 0, 0, 0, 0, 12, 12],
        ':' => [0, 12, 12, 0, 12, 12, 0],
        '/' => [1, 1, 2, 4, 8, 16, 16],
        '(' => [2, 4, 8, 8, 8, 4, 2],
        ')' => [8, 4, 2, 2, 2, 4, 8],
        ' ' => [0; 7],
        '_' => [0, 0, 0, 0, 0, 0, 31],
        _ => [14, 17, 1, 2, 4, 0, 4],
    }
}
fn text(image: &mut RgbImage, x: u32, y: u32, value: &str, scale: u32, color: [u8; 3]) {
    let maximum = ((WIDTH - x) / 6 / scale) as usize;
    for (index, character) in value.chars().take(maximum).enumerate() {
        for (row, bits) in glyph(character).iter().enumerate() {
            for column in 0..5 {
                if bits & (1 << (4 - column)) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            let px = x + index as u32 * 6 * scale + column * scale + dx;
                            let py = y + row as u32 * scale + dy;
                            if px < WIDTH && py < HEIGHT {
                                image.put_pixel(px, py, Rgb(color));
                            }
                        }
                    }
                }
            }
        }
    }
}
/// Shared renderer for the native cached texture and exported report.
pub fn spectrogram_color(db: f32, palette: SpectrumPalette) -> [u8; 3] {
    let value = ((db + 120.0) / 120.0).clamp(0.0, 1.0);
    let stops: &[[u8; 3]] = match palette {
        SpectrumPalette::Viridis => &[
            [20, 9, 37],
            [68, 1, 84],
            [59, 82, 139],
            [33, 145, 140],
            [94, 201, 98],
            [253, 231, 37],
        ],
        SpectrumPalette::Spek => &[
            [0, 0, 0],
            [0, 0, 80],
            [80, 0, 180],
            [180, 0, 40],
            [255, 100, 0],
            [255, 235, 0],
            [255, 255, 255],
        ],
        SpectrumPalette::Hot => &[[0, 0, 0], [255, 0, 0], [255, 255, 0], [255, 255, 255]],
        SpectrumPalette::Cool => &[[0, 255, 255], [255, 0, 255]],
        SpectrumPalette::Grayscale => &[[0, 0, 0], [255, 255, 255]],
    };
    let position = value * (stops.len() - 1) as f32;
    let index = (position.floor() as usize).min(stops.len() - 2);
    let fraction = (position - index as f32).clamp(0.0, 1.0);
    std::array::from_fn(|channel| {
        (stops[index][channel] as f32 * (1.0 - fraction)
            + stops[index + 1][channel] as f32 * fraction)
            .round() as u8
    })
}
pub fn spectrogram_rgb(
    data: &Spectrogram,
    palette: SpectrumPalette,
    scale: FrequencyScale,
    width: usize,
    height: usize,
    cancel: &Cancellation,
) -> Result<Vec<u8>, String> {
    cancel.check()?;
    let frames = data.levels_db.len();
    let bands = data.frequencies_hz.len();
    if frames == 0
        || frames > 450
        || bands < 2
        || bands > 512
        || data.times_seconds.len() != frames
        || data.levels_db.iter().any(|row| row.len() != bands)
        || width < 2
        || height < 2
        || width > 2048
        || height > 1080
    {
        return Err("The spectrogram dimensions are invalid or exceed rendering limits.".into());
    }
    let low = data.frequencies_hz[0];
    let high = data.frequencies_hz[bands - 1];
    if !low.is_finite()
        || !high.is_finite()
        || low <= 0.0
        || high <= low
        || data
            .frequencies_hz
            .windows(2)
            .any(|pair| !pair[1].is_finite() || pair[1] <= pair[0])
    {
        return Err("The spectrogram frequency range is invalid.".into());
    }
    let mut output = vec![0; width * height * 3];
    for y in 0..height {
        if y % 16 == 0 {
            cancel.check()?;
        }
        let fraction = 1.0 - y as f32 / (height - 1) as f32;
        let frequency = match scale {
            FrequencyScale::Linear => low + fraction * (high - low),
            FrequencyScale::Logarithmic => low * (high / low).powf(fraction),
        };
        let upper = data
            .frequencies_hz
            .partition_point(|value| *value < frequency)
            .clamp(1, bands - 1);
        let lower = upper - 1;
        let fy = ((frequency - data.frequencies_hz[lower])
            / (data.frequencies_hz[upper] - data.frequencies_hz[lower]))
            .clamp(0.0, 1.0);
        for x in 0..width {
            let time = x as f32 / (width - 1) as f32 * (frames - 1) as f32;
            let before = time.floor() as usize;
            let after = (before + 1).min(frames - 1);
            let fx = time - before as f32;
            let interpolate = |frame: usize| {
                data.levels_db[frame][lower] * (1.0 - fy) + data.levels_db[frame][upper] * fy
            };
            let db = interpolate(before) * (1.0 - fx) + interpolate(after) * fx;
            let color = spectrogram_color(if db.is_finite() { db } else { -120.0 }, palette);
            let offset = (y * width + x) * 3;
            output[offset..offset + 3].copy_from_slice(&color);
        }
    }
    Ok(output)
}

pub(super) fn export(
    document: &AudioDocument,
    analysis: &AudioAnalysis,
    fft_size: usize,
    window: SpectrumWindow,
    palette: SpectrumPalette,
    scale: FrequencyScale,
    directory: &Path,
    cancel: &Cancellation,
) -> Result<PathBuf, String> {
    cancel.check()?;
    let data = analysis
        .spectrogram
        .as_ref()
        .ok_or("Analyze a spectrogram before exporting a PNG.")?;
    let mut canvas = RgbImage::from_pixel(WIDTH, HEIGHT, Rgb([17, 20, 24]));
    let title = document
        .path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    text(&mut canvas, 52, 32, "AUDIO SPECTROGRAM", 3, [241, 245, 248]);
    text(&mut canvas, 52, 74, &title, 2, [190, 198, 206]);
    let detail = format!(
        "{} HZ / {} / {}-POINT FFT / {} / {} FREQUENCY",
        analysis.analysis_sample_rate,
        document.quality.codec,
        fft_size,
        window.label(),
        scale.label()
    );
    text(&mut canvas, 52, 105, &detail, 2, [137, 149, 160]);
    let (left, right, top, bottom) = (105, 1225, 164, 650);
    let plot_width = (right - left + 1) as usize;
    let plot_height = (bottom - top + 1) as usize;
    let pixels = spectrogram_rgb(data, palette, scale, plot_width, plot_height, cancel)?;
    for y in 0..plot_height {
        cancel.check()?;
        for x in 0..plot_width {
            let offset = (y * plot_width + x) * 3;
            canvas.put_pixel(
                left as u32 + x as u32,
                top as u32 + y as u32,
                Rgb(pixels[offset..offset + 3].try_into().unwrap()),
            );
        }
    }
    let low = data.frequencies_hz[0] as f64;
    let high = *data.frequencies_hz.last().unwrap() as f64;
    let y = |frequency: f64| {
        let fraction = match scale {
            FrequencyScale::Linear => (frequency - low) / (high - low),
            FrequencyScale::Logarithmic => (frequency / low).ln() / (high / low).ln(),
        };
        bottom - ((bottom - top) as f64 * fraction.clamp(0.0, 1.0)).round() as i32
    };
    for frequency in [
        20.0, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10000.0, 20000.0, 40000.0, 80000.0,
    ] {
        if frequency < low || frequency > high {
            continue;
        }
        // Linear labels use wider spacing to avoid overlap near the origin.
        if scale == FrequencyScale::Linear && frequency < high / 10.0 {
            continue;
        }
        let py = y(frequency);
        line(&mut canvas, (left - 7, py), (left, py), [164, 178, 190]);
        let label = if frequency >= 1000.0 {
            format!("{}K", frequency as u32 / 1000)
        } else {
            format!("{}", frequency as u32)
        };
        text(&mut canvas, 24, py as u32 - 7, &label, 2, [190, 198, 206]);
    }
    for index in 0..=5 {
        let x = left + (right - left) * index / 5;
        line(&mut canvas, (x, bottom), (x, bottom + 7), [164, 178, 190]);
        let seconds = analysis.analyzed_seconds * index as f64 / 5.0;
        text(
            &mut canvas,
            (x - 18).max(0) as u32,
            672,
            &format!("{seconds:.1}"),
            2,
            [190, 198, 206],
        );
    }
    for py in top..=bottom {
        let db = -120.0 * (py - top) as f32 / (bottom - top) as f32;
        let color = spectrogram_color(db, palette);
        line(&mut canvas, (1260, py), (1280, py), color);
    }
    for level in (0..=120).step_by(20) {
        let py = top + (bottom - top) * level / 120;
        let label = if level == 0 {
            "0".into()
        } else {
            format!("-{level}")
        };
        text(&mut canvas, 1293, py as u32 - 7, &label, 2, [190, 198, 206]);
    }
    text(&mut canvas, 25, 143, "HZ", 1, [151, 163, 172]);
    text(&mut canvas, 1260, 143, "DBFS", 1, [151, 163, 172]);
    text(&mut canvas, 570, 709, "TIME (SECONDS)", 2, [190, 198, 206]);
    text(
        &mut canvas,
        52,
        751,
        &format!(
            "FULL TRACK {:.1}S / SAMPLED FFT WINDOWS / {}",
            analysis.analyzed_seconds,
            palette.label()
        ),
        2,
        [151, 163, 172],
    );
    text(
        &mut canvas,
        52,
        783,
        "A FREQUENCY CUTOFF DOES NOT PROVE WHETHER THE ORIGINAL SOURCE WAS LOSSY.",
        2,
        [151, 163, 172],
    );
    cancel.check()?;
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    cancel.check()?;
    let name = format!(
        "{} - spectrogram.png",
        crate::music_downloads::safe_component(
            &document
                .path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
        )
    );
    write_new_file(directory, &name, bytes.get_ref(), cancel)
}
