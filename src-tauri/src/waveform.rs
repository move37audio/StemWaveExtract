//! Six-band spectral waveform: peak/RMS per 160-sample bin, coloured by a 512-point Hamming
//! FFT (hop 256) scored against six weighted frequency bands and blended by hue. Input is
//! always FFmpeg's 44.1 kHz stereo, so all sizes are fixed.
//!
//! Output: one 8-byte record per bin: peak and RMS (sqrt-encoded, `(q/255)^2`), the
//! frame's six-band detail colour as RGB, then the plug-in's three-band RGB analysis
//! (`rust/src/lib.rs`, Serato-matched low/mid/high, sqrt over [0, 2] like `WaveformTap`)
//! so the UI can switch between both looks without re-analysing.

use std::f64::consts::PI;
use std::io::Read;

pub const BIN: usize = 160;
pub const RECORD: usize = 8;
const N: usize = 512;
const HOP: usize = N / 2;
// (a, b, c, d) boundaries in Hz, scale, hue.
const BANDS: [([f64; 4], f64, f64); 6] = [
    ([0., 0., 80., 100.], 3.0, 0.99),
    ([80., 100., 200., 450.], 1.7, 0.00),
    ([200., 450., 1500., 1700.], 1.0, 0.36),
    ([1500., 1700., 1700., 3700.], 1.2, 0.44),
    ([1700., 3700., 5300., 7500.], 1.5, 0.64),
    ([5300., 7500., 10000., 20000.], 1.2, 0.66),
];

struct Spectrum {
    window: Vec<f64>,
    filters: Vec<[f64; N / 2]>,
    twiddles: Vec<(f64, f64)>,
}

impl Spectrum {
    fn new() -> Self {
        let window = (0..N).map(|n| 0.54 - 0.46 * (2. * PI * n as f64 / N as f64).cos()).collect();
        let filters = BANDS
            .iter()
            .map(|(hz, scale, _)| {
                let [a, b, c, d] = hz.map(|f| (f * N as f64 / 44100.).round().clamp(0., (N / 2 - 1) as f64) as usize);
                let mut w = [0.; N / 2];
                for k in a..b {
                    w[k] = scale * (((k - a + 1) as f64) / ((b - a + 1) as f64)).sqrt();
                }
                for k in b..c {
                    w[k] = *scale;
                }
                for k in c..d {
                    w[k] = scale * (1. - ((k - c + 1) as f64) / ((d - c + 1) as f64)).sqrt();
                }
                w
            })
            .collect();
        let twiddles = (0..N / 2).map(|k| (-2. * PI * k as f64 / N as f64).sin_cos()).map(|(s, c)| (c, s)).collect();
        Self { window, filters, twiddles }
    }

    /// Normalized magnitudes of bins 0..N/2 (Nyquist excluded) via in-place radix-2 FFT.
    fn magnitudes(&self, frame: &[f64]) -> [f64; N / 2] {
        let mut re: Vec<f64> = frame.iter().zip(&self.window).map(|(x, w)| x * w).collect();
        let mut im = vec![0.; N];
        let bits = N.trailing_zeros();
        for i in 0..N {
            let j = i.reverse_bits() >> (usize::BITS - bits);
            if i < j {
                re.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= N {
            let stride = N / size;
            for start in (0..N).step_by(size) {
                for k in 0..size / 2 {
                    let (c, s) = self.twiddles[k * stride];
                    let (i, j) = (start + k, start + k + size / 2);
                    let (tr, ti) = (re[j] * c - im[j] * s, re[j] * s + im[j] * c);
                    (re[j], im[j]) = (re[i] - tr, im[i] - ti);
                    (re[i], im[i]) = (re[i] + tr, im[i] + ti);
                }
            }
            size *= 2;
        }
        let mut m = [0.; N / 2];
        for k in 0..N / 2 {
            m[k] = if k == 0 { re[0].abs() } else { re[k].hypot(im[k]) };
        }
        let max = m.iter().cloned().fold(0., f64::max);
        if max > 0. {
            m.iter_mut().for_each(|v| *v /= max);
        }
        m
    }

    /// Detail colour of one frame (zero-padded when short).
    fn colour(&self, frame: &[f64]) -> [u8; 3] {
        let mut padded = [0.; N];
        padded[..frame.len()].copy_from_slice(frame);
        let m = self.magnitudes(&padded);
        let mut scores: Vec<(f64, f64)> =
            self.filters.iter().zip(BANDS).map(|(f, (_, _, hue))| (f.iter().zip(&m).map(|(a, b)| a * b).sum(), hue)).collect();
        let max = scores.iter().map(|s| s.0).fold(0., f64::max);
        let max = if max == 0. { 1. } else { max };
        scores.sort_by(|a, b| b.0.total_cmp(&a.0));
        let (mut x, mut y, mut total) = (0., 0., 0.);
        for (score, hue) in scores {
            let weight = (score / max).powf(1.5);
            x += weight * (2. * PI * hue).cos();
            y += weight * (2. * PI * hue).sin();
            total += weight;
        }
        let base = if total > 0. {
            hsv(
                (y.atan2(x) / (2. * PI)).rem_euclid(1.),
                (0.3 + 0.7 * x.hypot(y) / total).clamp(0., 1.),
            )
        } else {
            [0.; 3]
        };
        let rms = (padded.iter().map(|v| v * v).sum::<f64>() / N as f64).sqrt();
        let light = brightness(rms);
        base.map(|c| ((light * c + (1. - light) * 0.2).clamp(0., 1.) * 255.).round() as u8)
    }
}

fn brightness(rms: f64) -> f64 {
    if rms == 0. {
        return 0.;
    }
    let db = 20. * rms.log10();
    (if db < -36. { 0.2 * (db + 50.) / 14. } else { 0.2 + 0.8 * (db + 36.) / 27. }).clamp(0., 1.)
}

/// HSV with value 1 to RGB.
fn hsv(h: f64, s: f64) -> [f64; 3] {
    let f = h * 6.;
    let (i, f) = (f.floor() as i32 % 6, f - f.floor());
    let (p, q, t) = (1. - s, 1. - s * f, 1. - s * (1. - f));
    match i {
        0 => [1., t, p],
        1 => [q, 1., p],
        2 => [p, 1., t],
        3 => [p, q, 1.],
        4 => [t, p, 1.],
        _ => [1., p, q],
    }
}

/// Reads f32le stereo frames and returns the records. Errors past `max_frames`.
pub fn analyze(reader: &mut impl Read, max_frames: usize) -> std::io::Result<Vec<u8>> {
    let spectrum = Spectrum::new();
    let (mut bytes, mut pending) = (vec![0u8; 65536], Vec::new());
    let mut mono: Vec<f64> = Vec::new(); // samples from `base` on
    let (mut base, mut total) = (0usize, 0usize);
    let (mut bins, mut colours) = (Vec::new(), Vec::new());
    let (mut peak, mut sum, mut count) = (0f64, 0f64, 0usize);
    let encode = |v: f64| (v.clamp(0., 1.).sqrt() * 255.).round() as u8;
    let mut three_band = stemwave_core::Analyzer::new(BIN as u32);
    let mut band_out = vec![stemwave_core::SwBin::default(); 65536 / 8 / BIN + 1];
    let mut band_index = vec![0i64; band_out.len()];
    let (mut left, mut right, mut bands) = (Vec::new(), Vec::new(), Vec::new());
    loop {
        let n = reader.read(&mut bytes)?;
        pending.extend_from_slice(&bytes[..n]);
        let whole = pending.len() / 8 * 8;
        total += whole / 8;
        if total > max_frames {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Choose audio no longer than 10 minutes."));
        }
        left.clear();
        right.clear();
        for frame in pending[..whole].chunks_exact(8) {
            let l = f32::from_le_bytes(frame[..4].try_into().unwrap());
            let r = f32::from_le_bytes(frame[4..].try_into().unwrap());
            left.push(l);
            right.push(r);
            let s = (l as f64 + r as f64) * 0.5;
            let s = if s.is_finite() { s } else { 0. };
            mono.push(s);
            (peak, sum, count) = (peak.max(s.abs()), sum + s * s, count + 1);
            if count == BIN {
                bins.push((peak, (sum / BIN as f64).sqrt()));
                (peak, sum, count) = (0., 0., 0);
            }
        }
        let start = (total - whole / 8) as i64;
        let written = three_band.process(&left, Some(&right), start, &mut band_out, &mut band_index);
        let band = |v: f32| ((v * 0.5).clamp(0., 1.).sqrt() * 255.) as u8;
        bands.extend(band_out[..written].iter().map(|b| [band(b.low), band(b.mid), band(b.high)]));
        pending.drain(..whole);
        // Full frames, starting every HOP samples.
        while mono.len() >= N {
            colours.push(spectrum.colour(&mono[..N]));
            mono.drain(..HOP);
            base += HOP;
        }
        if n == 0 {
            break;
        }
    }
    if count > 0 {
        bins.push((peak, (sum / count as f64).sqrt())); // partial last bin over available samples
    }
    // The first incomplete window is zero-padded and ends the frame sequence.
    if base < total || colours.is_empty() {
        colours.push(spectrum.colour(&mono));
    }
    let mut out = Vec::with_capacity(bins.len() * RECORD);
    for (i, (peak, rms)) in bins.into_iter().enumerate() {
        let center = (i * BIN) as f64 + ((total - i * BIN).min(BIN) as f64) * 0.5;
        let frame = ((center - HOP as f64) / HOP as f64).round().clamp(0., (colours.len() - 1) as f64) as usize;
        out.extend([encode(peak), encode(rms)]);
        out.extend(colours[frame]);
        out.extend(bands.get(i).copied().unwrap_or([0; 3])); // a partial last bin has no bands
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(mono: &[f32]) -> Vec<u8> {
        mono.iter().flat_map(|s| [s.to_le_bytes(), s.to_le_bytes()].concat()).collect()
    }
    fn sine(hz: f64, n: usize, amp: f64) -> Vec<f32> {
        (0..n).map(|i| (amp * (2. * PI * hz * i as f64 / 44100.).sin()) as f32).collect()
    }
    fn decode(q: u8) -> f64 {
        (q as f64 / 255.).powi(2)
    }

    #[test]
    fn fft_matches_direct_dft() {
        let s = Spectrum::new();
        let frame: Vec<f64> = (0..N).map(|i| ((i * 7919) % 101) as f64 / 50. - 1.).collect();
        let fast = s.magnitudes(&frame);
        let w: Vec<f64> = frame.iter().zip(&s.window).map(|(x, w)| x * w).collect();
        let mut slow = [0.; N / 2];
        for k in 0..N / 2 {
            let (mut re, mut im) = (0., 0.);
            for (n, x) in w.iter().enumerate() {
                let a = -2. * PI * (k * n) as f64 / N as f64;
                re += x * a.cos();
                im += x * a.sin();
            }
            slow[k] = re.hypot(im);
        }
        let max = slow.iter().cloned().fold(0., f64::max);
        for k in 0..N / 2 {
            assert!((fast[k] - slow[k] / max).abs() < 1e-9);
        }
    }

    #[test]
    fn brightness_breakpoints_and_silence() {
        assert!((brightness(10f64.powf(-50. / 20.))).abs() < 1e-9);
        assert!((brightness(10f64.powf(-36. / 20.)) - 0.2).abs() < 1e-9);
        assert!((brightness(10f64.powf(-9. / 20.)) - 1.).abs() < 1e-9);
        let out = analyze(&mut &pcm(&[0.; 1000])[..], usize::MAX).unwrap();
        assert_eq!(out.len(), 7 * RECORD); // 6 full bins + 1 partial
        for r in out.chunks(RECORD) {
            assert_eq!(r, [0, 0, 51, 51, 51, 0, 0, 0]); // gray detail, no bands for silence
        }
    }

    #[test]
    fn envelopes_are_exact() {
        let out = analyze(&mut &pcm(&[0.25; 320])[..], usize::MAX).unwrap();
        for r in out.chunks(RECORD) {
            assert!((decode(r[0]) - 0.25).abs() < 0.01 && (decode(r[1]) - 0.25).abs() < 0.01);
        }
        let mut impulse = vec![0f32; BIN];
        impulse[0] = -1.;
        let r = analyze(&mut &pcm(&impulse)[..], usize::MAX).unwrap();
        assert_eq!(r[0], 255);
        assert!((decode(r[1]) - (1. / BIN as f64).sqrt()).abs() < 0.01);
    }

    #[test]
    fn colours_follow_frequency() {
        let colour = |hz| {
            let out = analyze(&mut &pcm(&sine(hz, 44100, 0.5))[..], usize::MAX).unwrap();
            let r = &out[out.len() / 2 / RECORD * RECORD..][..RECORD];
            [r[2] as i32, r[3] as i32, r[4] as i32, r[5] as i32, r[7] as i32]
        };
        let [r, g, b, low, high] = colour(60.);
        assert!(r > g + 60 && r > b + 60, "bass is red: {r} {g} {b}");
        assert!(low > high + 60, "three-band low dominates: {low} {high}");
        let [r, g, b, low, high] = colour(9000.);
        assert!(b > r + 60 && b > g, "hats are blue: {r} {g} {b}");
        assert!(high > low + 60, "three-band high dominates: {low} {high}");
        let [r, g, b, ..] = colour(800.);
        assert!(g > r + 60 && g > b, "mids are green: {r} {g} {b}");
    }

    #[test]
    fn streaming_reads_match_and_limit_holds() {
        struct Odd<'a>(&'a [u8]);
        impl Read for Odd<'_> {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let n = self.0.len().min(buf.len()).min(13);
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let audio = pcm(&sine(440., 5000, 0.3));
        assert_eq!(analyze(&mut Odd(&audio), usize::MAX).unwrap(), analyze(&mut &audio[..], usize::MAX).unwrap());
        assert!(analyze(&mut &audio[..], 4999).is_err());
        let mut bad = pcm(&[0.5; 10]);
        bad[..4].copy_from_slice(&f32::NAN.to_le_bytes()); // non-finite samples draw as silence
        assert_eq!(analyze(&mut &bad[..], usize::MAX).unwrap().len(), RECORD);
    }
}
