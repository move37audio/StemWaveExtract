"""Beat grid for one audio file: tempo and first downbeat, printed as JSON.

Uses beat_this (CPJKU, MIT; Foscarin et al., ISMIR 2024) to find beats and downbeats, then
fits one constant-tempo 4/4 grid to them, the way DJ software lays out a grid:
- Tempo: the period the detected beats are most phase-coherent with, refined by a
  least-squares fit over the beats that sit on that grid (see fit_grid).
- Downbeat: the grid phase (beat number mod 4) that most detected downbeats fall on.
CPU only: on macOS 13 PyTorch cannot run the spectrogram FFT on Metal. ~10 s per 6 min track.
"""
import json
import subprocess
import sys
from pathlib import Path

import os
import shutil

RUNTIME = Path(os.environ.get('STEMWAVE_RUNTIME', Path(__file__).resolve().parents[1] / 'runtime'))
CHECKPOINT = RUNTIME / 'models' / 'beat_this-final0.ckpt'
FFMPEG = os.environ.get('STEMWAVE_FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'
RATE = 22050


def fit_grid(beats, downbeats):
    """beats, downbeats: sorted seconds. Returns {bpm, offset, confidence} or None.

    Tempo is the period T whose grid the detected beats line up with best (phase coherence,
    |mean(exp(2*pi*i*t/T))|), searched finely around the median beat spacing. This averages
    out beat_this's 20 ms frame quantisation and tolerates missed or extra beats; a
    least-squares fit over the beats that sit on that grid then refines it.
    """
    import numpy as np
    beats = np.asarray(beats, float)
    if len(beats) < 8:
        return None
    period = float(np.median(np.diff(beats)))
    if not 60 / 240 <= period <= 60 / 40:
        return None
    candidates = np.linspace(period * 0.94, period * 1.06, 2401)
    phases = np.exp(2j * np.pi * beats[None, :] / candidates[:, None])
    coherence = np.abs(phases.mean(axis=1))
    best = int(np.argmax(coherence))
    slope = float(candidates[best])
    intercept = float(np.angle(phases[best].mean()) / (2 * np.pi) * slope) % slope
    index = np.round((beats - intercept) / slope)
    on_grid = np.abs(beats - (intercept + index * slope)) < 0.04
    if on_grid.sum() >= 8:
        slope, intercept = np.polyfit(index[on_grid], beats[on_grid], 1)
        on_grid = np.abs(beats - (intercept + index * slope)) < 0.04
    # Phase: which beat number mod 4 the downbeats land on.
    phase_votes = np.zeros(4)
    for d in downbeats:
        n = int(round((d - intercept) / slope))
        if abs(d - (intercept + n * slope)) < 0.07:
            phase_votes[n % 4] += 1
    phase = int(np.argmax(phase_votes)) if phase_votes.sum() else 0
    # First downbeat at or after 0 s.
    n = phase + 4 * int(np.ceil((-intercept / slope - phase) / 4))
    offset = intercept + n * slope
    while offset - 4 * slope >= 0:
        offset -= 4 * slope
    agreement = phase_votes.max() / phase_votes.sum() if phase_votes.sum() else 0.5
    return {
        'bpm': round(60 / slope, 2),
        'offset': round(float(offset), 3),
        # Share of beats on the grid, times how many downbeats agree on bar one.
        'confidence': round(float(on_grid.mean()) * agreement, 2),
    }


def detect(path):
    """Raw beat and downbeat times (seconds) from beat_this."""
    import numpy as np
    from beat_this.inference import Audio2Beats
    pcm = subprocess.run([FFMPEG, '-nostdin', '-v', 'error', '-i', str(path), '-map', '0:a:0', '-vn', '-ac', '1',
                          '-ar', str(RATE), '-t', '600.001', '-f', 'f32le', 'pipe:1'], capture_output=True, check=True).stdout
    signal = np.frombuffer(pcm, np.float32)
    if not len(signal):
        raise ValueError('No audio decoded.')
    return Audio2Beats(checkpoint_path=str(CHECKPOINT), device='cpu', dbn=False)(signal, RATE)


def analyze(path):
    return fit_grid(*detect(path))


if __name__ == '__main__':
    import warnings
    warnings.filterwarnings('ignore')
    print(json.dumps(analyze(Path(sys.argv[1]))))
