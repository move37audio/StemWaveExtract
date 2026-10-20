# StemWave Extract

A macOS app (Apple Silicon, macOS 13.6+) that splits any song into stems: Vocals, Drums, Bass, Guitar, Piano and Other. You can also get Acapella and Instrumental. Everything runs on your Mac; nothing is uploaded.

## Using it

- **Open a track:** click the square art tile or drop a file on the window (WAV, AIFF, FLAC, MP3, M4A, Ogg, up to 10 minutes). The waveform and embedded cover art appear at once. Tempo and downbeats are found in a few seconds.
- **Choose stems:** use **+ Add stem**. It offers Acapella, Instrumental, any of the six stems, all remaining stems, and **Everything else** (one mix of every stem you didn't pick).
- **Extract:** pick **Fast**, **Standard** or **HQ**, then press Extract. Standard is the default. Fast trades overlapping predictions for speed; HQ adds extra averaging. Timing depends on the Mac and audio length. Output is float32 WAV.
- **Listen:**
  - Click a lane to hear it alone, and ⌘-click to combine lanes.
  - **M** mutes a lane and **S** solos it. All lanes play sample-locked.
  - Minimise the Original lane once stems are showing.
- **Loops:**
  - Click the bar count (e.g. "8 bars") to loop that many bars from the playhead, or click or drag the bar ruler. The loop is shaded blue.
  - While looping, **Extract loop** separates only that section. A 4 s loop takes about 8 s.
  - Right-click a lane to export the whole stem, its loop, or every lane's loop.
- **Tempo:** **½** / **2×** fix half- or double-time readings, and double-click the BPM to type one. **Downbeat** puts a bar line at the playhead. Corrections are remembered per track.
- **Settings (gear):**
  - Theme and waveform style (Spectral, RGB DJ, Mono).
  - Beat grid.
  - Save folder, file names (`Track (Stem)`, `Track - Stem`, `Stem`), and whether each extraction gets its own folder. Existing files are never overwritten.

## First launch

The downloadable app is self-contained: Python 3.10, pinned libraries, FFmpeg, the six-stem separation checkpoint, and the beat model are all inside the app. No first-launch download or separate Python installation is needed. Move the app into Applications and open it.

The release is ad-hoc signed, not Apple Developer ID signed or notarized. Right-click → Open; macOS may require approval in Privacy & Security.

Models and runtime stay inside the app; preferences/cache may live in `~/Library/Application Support/com.stemwave.extract`. Older versions may have installed a runtime there. To uninstall, quit and delete the app and that support folder. Exported audio remains in the save folder you selected.

## How it works

- **Interface and app shell:** Rust/Tauri (`src-tauri/`) with a plain HTML/CSS/JS interface (`ui/`, no build step).
- **Waveforms:** analysed in Rust (`src-tauri/src/waveform.rs`).
- **Playback:** Web Audio.
- **Separation:** `engine/separate.py` and `engine/core.py` run the BS-RoFormer model with PyTorch on the Metal GPU. Complex FFTs stay on the CPU (macOS 13 has no complex tensors on Metal). A faster, mathematically identical attention path (`fast_attention_forward`) makes each chunk about 1.6× faster. Its output matches the unmodified model to within about 1e-6.
- **Beat grid:** `engine/beats.py` runs beat_this, then fits one constant-tempo 4/4 grid by phase coherence. It matched the DJ-tagged BPM exactly on 36 of 40 held-out tracks.

## Build

```sh
./scripts/package-macos.sh   # builds clean offline resources, app, ZIP and checksums
cargo test --workspace
node tests/ui.test.cjs
PYTHONDONTWRITEBYTECODE=1 vendor/runtime/python/bin/python3.10 tests/test_worker.py
```

## Licenses

- App code: MIT.
- `engine/models/` comes from [Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) (MIT, see `engine/licenses/`). It has one local change: the STFT runs on CPU when using Metal.
- beat_this code and published weights are MIT. uv is a build-only dependency (MIT/Apache-2.0).
- **The separation checkpoint has no published license.** The release publisher has confirmed permission to redistribute it with this release. That permission is separate from this app’s MIT license; no additional checkpoint rights are granted here. Source builds fetch the pinned checkpoint into ignored release resources.
- The bundled FFmpeg 7.1 is built from unmodified LGPL source without GPL/nonfree features. Its exact source archive is a release asset; configure flags are in the runtime license folder.

## Testing 0.1.1-beta.1

- FAST uses overlap 1 for quicker previews; STANDARD (default) uses the bundled Hugging Face config's overlap 2 and equivalent optimized attention; HQ uses overlap 4 and three-view averaging. All modes use the same checkpoint. HQ has a gold/white label with a CSS hover shimmer that respects reduced motion.
- Waveform analysis preserves stereo energy instead of averaging channels into silence. Spectral, RGB DJ and Mono preserve opposite-phase stereo, and onset/frame-count regressions cover timeline alignment. Minimum macOS remains 13.6, Apple Silicon only. Compatibility on every Apple Silicon chip/macOS combination is not established by local tests.
- Settings → **Save diagnostic report…** exports the last extraction's local timings, system/backend details, model/config hashes and inference settings. No audio, track names or paths, and no automatic upload. Reports live in the app's Application Support diagnostics folder and are replaced each run. Nothing extra is placed beside extracted WAV files.
- Compare the same audio region, model/config hashes and settings when investigating performance. This build does not claim to resolve the reported 19-second versus 63-second throughput gap.
