"""Separation adapter (six-stem BS-RoFormer). Rust owns lifecycle; this process owns conversion/export."""
import argparse
import json
import math
import os
import re
from pathlib import Path
import shutil
import signal
import sys
import subprocess
import tempfile
import time

ENGINE = Path(__file__).resolve().parent
# Set by the app from the first-run runtime (imageio-ffmpeg's binary); PATH lookup for development.
FFMPEG = os.environ.get('STEMWAVE_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'
NAMES = ['Bass', 'Drums', 'Other', 'Vocals', 'Guitar', 'Piano']
OUTPUTS = {'acapella', 'instrumental', *(n.lower() for n in NAMES)}

class Progress:
    def __init__(self, path):
        self.path = path
        self.started = time.monotonic()
        self.inference_started = None
        self.device = "CPU"

    def report(self, stage, progress, message, eta=None, status='running', output=None, files=None):
        payload = dict(stage=stage, progress=progress, message=message,
                       elapsed_seconds=time.monotonic() - self.started,
                       eta_seconds=eta, status=status, output_path=str(output) if output else None,
                       files=files or [])
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(payload))
        temporary.replace(self.path)

    def model_progress(self, _out, value):
        if value >= 1:
            self.report('exporting', .95, 'Preparing your selected stems')
            return
        if self.inference_started is None:
            self.inference_started = time.monotonic()
        fraction = max(0., min(1., (value - .05) / .9))
        eta = ((time.monotonic() - self.inference_started) * (1 - fraction) / fraction) if fraction > 0 else None
        self.report('separating', .12 + .81 * fraction, 'Separating audio · ' + self.device, eta)


def _rotation(rotary, n, device):
    # The library's own angles for positions 0..n-1, already repeated per interleaved pair.
    cache = rotary.__dict__.setdefault('_stemwave_rotation', {})
    if (n, device) not in cache:
        import torch
        angles = rotary.forward(torch.arange(n, device=device, dtype=torch.float32), seq_len=n)
        sign = torch.tensor([-1., 1.], device=device).repeat(angles.shape[-1] // 2)
        cache[(n, device)] = (angles.cos(), angles.sin() * sign)
    return cache[(n, device)]


def fast_attention_forward(self, x):
    """Same math as upstream Attention.forward, ~1.6x faster on Metal.

    Upstream rotates non-contiguous q/k views with five full-tensor passes. Here q/k/v are laid
    out contiguously once and the interleaved rotary pairs are rotated with one swap and a
    fused multiply-add. Output matches upstream to ~1e-7.
    """
    import torch
    x = self.norm(x)
    b, n, _ = x.shape
    q, k, v = self.to_qkv(x).view(b, n, 3, self.heads, -1).permute(2, 0, 3, 1, 4).contiguous().unbind(0)
    cos, signed_sin = _rotation(self.rotary_embed, n, x.device)
    rotate = lambda t: torch.addcmul(t * cos, t.unflatten(-1, (-1, 2)).flip(-1).flatten(-2), signed_sin)
    out = self.attend(rotate(q), rotate(k), v)
    out = out * self.to_gates(x).transpose(1, 2).unsqueeze(-1).sigmoid()
    return self.to_out(out.transpose(1, 2).reshape(b, n, -1))


def install_fast_attention():
    import sys
    sys.path.insert(0, str(ENGINE))
    from models.bs_roformer import bs_roformer
    upstream = bs_roformer.Attention.forward
    if getattr(upstream, 'stemwave_fast', False):
        return
    def forward(self, x):
        # Only the configuration this checkpoint uses: rotary embeddings, no PoPE.
        if self.rotary_embed is None or self.pope_embed is not None or self.training:
            return upstream(self, x)
        return fast_attention_forward(self, x)
    forward.stemwave_fast = True
    bs_roformer.Attention.upstream_forward = upstream
    bs_roformer.Attention.forward = forward


def install_tta():
    """Average three views per chunk: as-is, channels swapped, polarity inverted.

    Separation should not depend on either transform, so averaging the un-transformed
    results reduces model error (the usual BS-RoFormer test-time augmentation). 3x compute.
    """
    import sys
    sys.path.insert(0, str(ENGINE))
    from models.bs_roformer import bs_roformer
    upstream = bs_roformer.BSRoformer.forward
    if getattr(upstream, 'stemwave_tta', False):
        return
    def forward(self, raw_audio, *args, **kwargs):
        if self.training:
            return upstream(self, raw_audio, *args, **kwargs)
        # Input (b, channels, t); output (b, stems, channels, t).
        direct = upstream(self, raw_audio, *args, **kwargs)
        swapped = upstream(self, raw_audio.flip(1), *args, **kwargs).flip(2)
        inverted = -upstream(self, -raw_audio, *args, **kwargs)
        return (direct + swapped + inverted) / 3
    forward.stemwave_tta = True
    bs_roformer.BSRoformer.upstream_forward = upstream
    bs_roformer.BSRoformer.forward = forward


# fast: same math as upstream, faster attention. good: + 4x overlap (each sample averaged over
# 4 chunk predictions instead of 2), ~2x fast. quality: + 3-view TTA too, ~6x fast.
# original: upstream code untouched, same output as fast; kept for the CLI as a reference.
MODES = {
    'fast': dict(fast=True, overlap=None, tta=False, label='Fast'),
    'good': dict(fast=True, overlap=4, tta=False, label='Good'),
    'quality': dict(fast=True, overlap=4, tta=True, label='Quality'),
    'original': dict(fast=False, overlap=None, tta=False, label='Original'),
}


def plan(outputs, remainder=False):
    """Selected outputs, plus (when asked) one mix of the model sources they don't cover."""
    if not outputs or not set(outputs) <= OUTPUTS:
        raise ValueError('Choose at least one valid output.')
    files = {}
    if 'acapella' in outputs:
        files['Acapella'] = ['Vocals']
    if 'instrumental' in outputs:
        files['Instrumental'] = [n for n in NAMES if n != 'Vocals']
    for name in NAMES:
        if name.lower() in outputs and not (name == 'Vocals' and 'acapella' in outputs):
            files[name] = [name]
    covered = {source for sources in files.values() for source in sources}
    remaining = [name for name in NAMES if name not in covered]
    if remaining and remainder:
        label = 'Everything but ' + ' and '.join(name for name in NAMES if name in covered)
        files[label] = remaining
    return files


# File name patterns for exported stems.
NAMING = {
    'paren': '{track} ({stem}).wav',   # Puerto Rico (Drums).wav
    'dash': '{track} - {stem}.wav',    # Puerto Rico - Drums.wav
    'stem': '{stem}.wav',              # Drums.wav
}


def output_filenames(files, source_name, naming='paren'):
    if not isinstance(source_name, str) or not source_name or source_name in ('.', '..') or any(c in source_name for c in ('/', '\\', '\0')):
        raise ValueError('The source name must be a single file name without path separators.')
    if naming not in NAMING:
        raise ValueError('Unknown file naming.')
    names = {label: NAMING[naming].format(track=source_name, stem=label) for label in files}
    if any(len(name.encode('utf-8')) > 255 for name in names.values()):
        raise ValueError('An output file name exceeds 255 bytes. Shorten the original track name and try again.')
    return names


def export_selected(raw, destination, outputs, source_name, remainder=False, naming='paren'):
    import numpy as np
    from scipy.io import wavfile
    files = plan(outputs, remainder)
    filenames = output_filenames(files, source_name, naming)
    stems, frames = {}, None
    for name in NAMES:
        rate, data = wavfile.read(raw / (name + '.wav'))
        if rate != 44100 or data.dtype != np.float32 or data.ndim != 2 or data.shape[1] != 2 or not np.isfinite(data).all():
            raise ValueError('The model returned invalid audio.')
        if frames is not None and len(data) != frames:
            raise ValueError('Stem lengths do not match.')
        frames = len(data)
        stems[name] = data
    for name in files:
        target = destination / filenames[name]
        if target.exists() or target.is_symlink():
            raise ValueError('Refusing to overwrite existing audio.')
    for name, sources in files.items():
        mix = stems[sources[0]].copy()
        for source in sources[1:]:
            mix += stems[source]
        if not np.isfinite(mix).all():
            raise ValueError(name + ' contains invalid samples.')
        wavfile.write(destination / filenames[name], 44100, mix)
    return frames


def run(input_file, output_parent, outputs, progress_file, mode='fast', remainder=False, naming='paren', subfolder=True, start=None, end=None, tag=None):
    """start/end (seconds) separate only that region; tag (e.g. "bars 5-8") is added to the file names."""
    if (start is None) != (end is None) or (start is not None and not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end and end - start <= 600)):
        raise ValueError('That loop region isn\'t valid.')
    if tag is not None and (not tag or any(not (c.isalnum() or c in ' -') for c in tag) or len(tag) > 40):
        raise ValueError('That loop label isn\'t valid.')
    track = input_file.stem + (f' ({tag})' if tag else '')
    if mode not in MODES:
        raise ValueError('Unknown processing mode.')
    settings = MODES[mode]
    plan(outputs)
    if not input_file.is_file() or not output_parent.is_dir():
        raise ValueError('Choose an existing audio file and output folder.')
    progress = Progress(progress_file)
    final, direct = None, []
    try:
        planned = output_filenames(plan(outputs, remainder), track, naming)
        progress.report('reading', .01, 'Checking your audio file')
        duration = media_duration(input_file)
        if start is not None:
            if end > duration + 0.05:
                raise ValueError('The loop runs past the end of the track.')
            duration = end - start
        if not math.isfinite(duration) or not 0 < duration <= 600:
            raise ValueError('Choose audio between 0 and 10 minutes long.')
        work = progress_file.parent
        converted = work / 'input.wav'
        raw = work / 'stems'
        raw.mkdir()
        progress.report('converting', .04, 'Preparing stereo audio at 44.1 kHz')
        # A loop region is cut after decoding (output-side seek), so it is sample-accurate.
        region = ['-ss', f'{start:.6f}', '-to', f'{end:.6f}'] if start is not None else ['-t', '600.001']
        subprocess.run([FFMPEG, '-nostdin', '-v', 'error', '-n', '-i', str(input_file), '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '44100', *region, '-c:a', 'pcm_f32le', str(converted)], check=True)
        progress.report('loading', .08, 'Loading the separation model — this can take a moment')
        sys.path.insert(0, str(ENGINE))
        import core
        core.write_progress = progress.model_progress
        def device_ready(device):
            progress.device = ("Metal GPU" if device == "mps" else "CPU") + " · " + settings['label']
            progress.report("separating", .12, "Separating audio · " + progress.device)
        if settings['fast']:
            install_fast_attention()
        if settings['tta']:
            install_tta()
        core.run(converted, raw, max_seconds=600, device="auto", device_callback=device_ready, overlap=settings['overlap'])
        progress.report('exporting', .96, 'Writing your stems as float32 WAV files')
        if subfolder:
            prefix = ''.join(c if c.isalnum() or c in '-_ ' else '_' for c in input_file.stem)[:40] or 'Audio'
            final = Path(tempfile.mkdtemp(prefix=prefix + ' - Stems ', dir=output_parent))
        else:
            # Straight into the chosen folder: export refuses existing names, so every planned
            # path that exists after a failure was written by this run and is safe to remove.
            direct = [output_parent / name for name in planned.values()]
        export_selected(raw, final or output_parent, outputs, track, remainder, naming)
        progress.report('complete', 1., 'Your stems are ready', 0., 'complete', final or output_parent, sorted(planned.values()))
    except BaseException as error:
        if final is not None:
            shutil.rmtree(final)
        for path in direct:
            path.unlink(missing_ok=True)
        cancelled = isinstance(error, InterruptedError)
        progress.report('cancelled' if cancelled else 'error', 0., 'Extraction cancelled' if cancelled else str(error).replace('BS-RoFormer', 'The separation model'), status='cancelled' if cancelled else 'error')
        raise


def media_duration(path):
    """Seconds, from FFmpeg's input summary (no ffprobe needed)."""
    info = subprocess.run([FFMPEG, '-nostdin', '-hide_banner', '-i', str(path)], capture_output=True, text=True).stderr
    match = re.search(r'Duration: (\d+):(\d+):(\d+(?:\.\d+)?)', info)
    if not match:
        raise ValueError('This file could not be read as audio.')
    h, m, sec = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(sec)


def interrupted(_signal, _frame):
    raise InterruptedError('Extraction cancelled')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('input', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('outputs', type=lambda v: set(v.split(',')), help='comma-separated: ' + ','.join(sorted(OUTPUTS)))
    parser.add_argument('--progress-file', type=Path, required=True)
    parser.add_argument('--mode', choices=sorted(MODES), default='fast')
    parser.add_argument('--remainder', action='store_true', help='also export one mix of the stems not selected')
    parser.add_argument('--naming', choices=sorted(NAMING), default='paren')
    parser.add_argument('--no-subfolder', action='store_true', help='write stems directly into the output folder')
    parser.add_argument('--start', type=float, help='separate only from this second')
    parser.add_argument('--end', type=float, help='separate only up to this second')
    parser.add_argument('--tag', help='label added to file names, e.g. "bars 5-8"')
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    run(args.input, args.output, args.outputs, args.progress_file, args.mode, args.remainder, args.naming, not args.no_subfolder, args.start, args.end, args.tag)
