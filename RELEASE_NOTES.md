# StemWave Extract 0.1.1-beta.1

Beta testing release. Fully offline; both model checkpoints and the runtime are included.

- Settings → **Save diagnostic report…** exports local timings, system/backend and model/settings details without audio, track names or paths. Nothing is uploaded automatically or placed beside extracted stems.
- **FAST | STANDARD | HQ**. Standard defaults to the bundled Hugging Face config's overlap 2. Fast reduces overlap for preview speed; HQ adds averaging and has a gold/white hover shimmer with reduced-motion support.
- Waveforms now render directly to each lane; stereo analysis no longer cancels opposite-polarity channels. This addresses the clipping/rendering path and flat-waveform bug, but still needs confirmation on affected Macs.
- Tested on M1 Max / macOS 13.6.6: 15 Rust tests, 13 Python tests, UI checks, real Standard-mode extraction, signature and archive integrity. The reported performance difference versus other apps is not claimed fixed.

- Apple Silicon only; macOS 13.6 or later.
- **Unsigned release:** ad-hoc signed, without Apple Developer ID or notarization. After moving the app to Applications, right-click → Open. macOS may require approval in Privacy & Security.
- The separation checkpoint is included in this release with redistribution permission confirmed by the publisher. It is not part of the source repository or covered by the app's MIT license.
- Fully offline: Python, pinned packages, FFmpeg, and both model checkpoints are bundled. No first-launch download.
- Runtime and models live inside the app. Preferences/cache and previous-version runtime files may live in `~/Library/Application Support/com.stemwave.extract`. Exported audio stays in the folder you choose.
- To uninstall: quit and remove the app, then remove that Application Support folder. Keep or delete your exported audio separately.
- App and stemwave_core copyright © 2026 move37audio, MIT. Third-party terms are listed in `engine/licenses/THIRD-PARTY.md` and on the download page.

FFmpeg is LGPL 2.1 or later; the corresponding unmodified `ffmpeg-7.1.tar.xz` source is attached alongside the app. The app uses FFmpeg as a separate program.
