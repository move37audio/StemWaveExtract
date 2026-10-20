# Third-party components

| Component | Where | License |
|---|---|---|
| Music-Source-Separation-Training model code | bundled engine/models | MIT; included notice |
| CPython 3.10.18 | bundled runtime/python | Python Software Foundation license; included Python notices |
| beat_this (CPJKU) | bundled Python packages | MIT; package notices included |
| PyTorch, torchaudio, NumPy, SciPy, PyYAML, einops, rotary-embedding-torch, beartype, soxr and supporting packages | bundled runtime/python/lib/python3.10/site-packages | Respective BSD/MIT/other upstream terms; all package license metadata retained |
| FFmpeg 7.1 | bundled runtime/bin/ffmpeg | LGPL 2.1 or later; no GPL or nonfree features; license and build flags in runtime/licenses; exact corresponding source archive attached to this release |
| BS-RoFormer six-stem checkpoint (ChanTrail/BS-RoFormer) | bundled runtime/models; excluded from Git | No published license; redistribution permission confirmed by release publisher; not covered by app MIT license |
| beat_this final0 checkpoint | bundled runtime/models; excluded from Git | MIT; covered by included beat_this package notice |
| uv and imageio-ffmpeg | source-build bootstrap only; not shipped in offline app | MIT/Apache-2.0 and BSD-2 respectively |

Portable Python modifications: its dylib install name is relative, and generated sysconfig paths resolve from the interpreter's runtime location. Native files are ad-hoc signed. Bytecode caches and the bootstrap imageio FFmpeg binary are excluded.

FFmpeg source: https://github.com/move37audio/StemWaveExtract/releases/download/v0.1.0/ffmpeg-7.1.tar.xz
FFmpeg project: https://ffmpeg.org/
