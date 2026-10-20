//! Realtime port of the Serato-matched RGB waveform analysis from
//! ITCH SYNC UI `WebPlayer/src/serato-waveform-display.js` (`buildWaveform`).
//!
//! Each bin covers `bin_samples` samples on the host timeline and carries the
//! mono min/max plus the peak of the low (<250 Hz), mid and high (>2 kHz) bands.
//! Bins are aligned to absolute timeline positions so the UI can key its history
//! by `position / bin_samples` and redraw a seen region after a seek.
//! Called from the audio thread: no allocation after `sw_analyzer_new`.

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SwBin {
    pub min: f32,
    pub max: f32,
    pub low: f32,
    pub mid: f32,
    pub high: f32,
}

pub struct Analyzer {
    bin_samples: i64,
    // Two chained Chamberlin SVFs, same topology as the JS renderer.
    l1: f32,
    b1: f32,
    l2: f32,
    b2: f32,
    f_low: f32,
    f_high: f32,
    expected_pos: Option<i64>,
    acc: SwBin,
    acc_count: i64,
}

impl Analyzer {
    pub fn new(bin_samples: u32) -> Self {
        // Preserve these cutoffs and the 44100Hz basis. They are part of the Serato-matched renderer.
        let f_low = 2.0 * (std::f32::consts::PI * 250.0 / 44100.0).sin();
        let f_high = 2.0 * (std::f32::consts::PI * 2000.0 / 44100.0).sin();
        Self {
            bin_samples: bin_samples.max(1) as i64,
            l1: 0.0,
            b1: 0.0,
            l2: 0.0,
            b2: 0.0,
            f_low,
            f_high,
            expected_pos: None,
            acc: SwBin::default(),
            acc_count: 0,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.bin_samples as u32);
    }

    /// Feeds one block starting at timeline sample `start_pos`. Completed bins are
    /// written to `out`/`out_index` (bin index = start sample / bin_samples).
    /// Returns the number written; bins beyond `out.len()` are dropped.
    pub fn process(&mut self, left: &[f32], right: Option<&[f32]>, start_pos: i64, out: &mut [SwBin], out_index: &mut [i64]) -> usize {
        if self.expected_pos != Some(start_pos) {
            // Seek or first block: drop the partial bin, keep filter state (it decays in a few ms).
            self.acc = SwBin::default();
            self.acc_count = start_pos.rem_euclid(self.bin_samples);
        }
        self.expected_pos = Some(start_pos + left.len() as i64);

        let cap = out.len().min(out_index.len());
        let mut written = 0;
        let q = 1.0;
        for (i, &l) in left.iter().enumerate() {
            let s = match right {
                Some(r) => (l + r[i]) * 0.5,
                None => l,
            };
            let s = if s.is_finite() { s } else { 0.0 };

            self.l2 += self.f_high * self.b2;
            let h2 = s - self.l2 - q * self.b2;
            self.b2 += self.f_high * h2;

            self.l1 += self.f_low * self.b1;
            let h1 = self.l2 - self.l1 - q * self.b1;
            self.b1 += self.f_low * h1;

            let a = &mut self.acc;
            a.min = a.min.min(s);
            a.max = a.max.max(s);
            a.low = a.low.max(self.l1.abs());
            a.mid = a.mid.max(h1.abs());
            a.high = a.high.max(h2.abs());
            self.acc_count += 1;

            if self.acc_count == self.bin_samples {
                if written < cap {
                    out[written] = self.acc;
                    out_index[written] = (start_pos + i as i64).div_euclid(self.bin_samples);
                    written += 1;
                }
                self.acc = SwBin::default();
                self.acc_count = 0;
            }
        }
        written
    }
}

#[no_mangle]
pub extern "C" fn sw_analyzer_new(bin_samples: u32) -> *mut Analyzer {
    Box::into_raw(Box::new(Analyzer::new(bin_samples)))
}

/// # Safety
/// `a` must come from `sw_analyzer_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn sw_analyzer_free(a: *mut Analyzer) {
    if !a.is_null() {
        drop(Box::from_raw(a));
    }
}

/// # Safety
/// `a` is null or came from `sw_analyzer_new`.
#[no_mangle]
pub unsafe extern "C" fn sw_analyzer_reset(a: *mut Analyzer) {
    if let Some(a) = a.as_mut() {
        a.reset();
    }
}

/// # Safety
/// `a` valid; `left` has `n` samples; `right` is null or has `n` samples;
/// `out` and `out_index` have room for `cap` entries.
#[no_mangle]
pub unsafe extern "C" fn sw_analyzer_process(
    a: *mut Analyzer,
    left: *const f32,
    right: *const f32,
    n: usize,
    start_pos: i64,
    out: *mut SwBin,
    out_index: *mut i64,
    cap: usize,
) -> usize {
    let Some(a) = a.as_mut() else { return 0 };
    if left.is_null() || out.is_null() || out_index.is_null() {
        return 0;
    }
    let left = std::slice::from_raw_parts(left, n);
    let right = (!right.is_null()).then(|| std::slice::from_raw_parts(right, n));
    let out = std::slice::from_raw_parts_mut(out, cap);
    let out_index = std::slice::from_raw_parts_mut(out_index, cap);
    a.process(left, right, start_pos, out, out_index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(a: &mut Analyzer, sig: &[f32], pos: i64) -> Vec<(i64, SwBin)> {
        let mut out = vec![SwBin::default(); 64];
        let mut idx = vec![0i64; 64];
        let n = a.process(sig, None, pos, &mut out, &mut idx);
        idx[..n].iter().copied().zip(out[..n].iter().copied()).collect()
    }

    fn sine(hz: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / 44100.0).sin()).collect()
    }

    #[test]
    fn bins_align_to_timeline_across_blocks_and_seeks() {
        let mut a = Analyzer::new(128);
        let s = vec![0.5f32; 200];
        // Samples 100..300: partial bin 0 closes at 127, bin 1 at 255, bin 2 stays open.
        let bins = run(&mut a, &s, 100);
        assert_eq!(bins.iter().map(|b| b.0).collect::<Vec<_>>(), vec![0, 1]);
        // Contiguous 300..500 closes bin 2 only.
        let bins = run(&mut a, &s, 300);
        assert_eq!(bins.iter().map(|b| b.0).collect::<Vec<_>>(), vec![2]);
        // Seek back: partial bin dropped, alignment restarts from the new position.
        let bins = run(&mut a, &s[..128], 0);
        assert_eq!(bins.iter().map(|b| b.0).collect::<Vec<_>>(), vec![0]);
    }

    #[test]
    fn bands_follow_frequency_content() {
        let mut a = Analyzer::new(1024);
        let lo = run(&mut a, &sine(60.0, 44100), 0).last().unwrap().1;
        let mut a = Analyzer::new(1024);
        let hi = run(&mut a, &sine(8000.0, 44100), 0).last().unwrap().1;
        assert!(lo.low > 4.0 * lo.high, "{lo:?}");
        assert!(hi.high > 4.0 * hi.low, "{hi:?}");
        assert!((lo.max - 1.0).abs() < 0.01 && (lo.min + 1.0).abs() < 0.01);
    }
}
