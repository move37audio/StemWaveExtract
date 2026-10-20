# StemWave Extract 0.1.0

Separate songs into vocals, drums, bass, guitar, piano and other, with acapella and instrumental mixes. Includes Spectral and RGB DJ waveform styles. Extraction folders now contain only WAV audio.

- Apple Silicon only; macOS 13.6 or later.
- **Unsigned release:** ad-hoc signed, without Apple Developer ID or notarization. After moving the app to Applications, right-click → Open. macOS may require approval in Privacy & Security.
- The separation checkpoint is included in this release with redistribution permission confirmed by the publisher. It is not part of the source repository or covered by the app's MIT license.
- Fully offline: Python, pinned packages, FFmpeg, and both model checkpoints are bundled. No first-launch download.
- Runtime and models live inside the app. Preferences/cache and previous-version runtime files may live in `~/Library/Application Support/com.stemwave.extract`. Exported audio stays in the folder you choose.
- To uninstall: quit and remove the app, then remove that Application Support folder. Keep or delete your exported audio separately.
- App and stemwave_core copyright © 2026 move37audio, MIT. Third-party terms are listed in `engine/licenses/THIRD-PARTY.md` and on the download page.

FFmpeg is LGPL 2.1 or later; the corresponding unmodified `ffmpeg-7.1.tar.xz` source is attached alongside the app. The app uses FFmpeg as a separate program.
