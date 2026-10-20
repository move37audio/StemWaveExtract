"""Six-stem separation inference (BS-RoFormer). No networking, no unsafe pickle loading.

Model code lives next to this file (engine/models, MIT). The checkpoint and its config are
provided under $STEMWAVE_RUNTIME/models; releases bundle them and verify SHA-256.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ENGINE = Path(__file__).resolve().parent
NAMES = ['Bass', 'Drums', 'Other', 'Vocals', 'Guitar', 'Piano']
EXPECTED = '24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e'


def models_dir():
    return Path(os.environ.get('STEMWAVE_RUNTIME', ENGINE.parent / 'runtime')) / 'models'


def write_progress(out, value):
    temporary = out / 'progress.tmp'
    temporary.write_text(str(value))
    temporary.replace(out / 'progress.txt')


def verify_checkpoint(checkpoint):
    """Verify without writing into the immutable app bundle."""
    digest = hashlib.sha256()
    with checkpoint.open('rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    if digest.hexdigest() != EXPECTED:
        raise ValueError('The separation model file is damaged. Run setup again.')
    return EXPECTED


def run(input_file, out, *, max_seconds=120, device="cpu", device_callback=None, overlap=None, diagnostic=lambda *_a, **_k: None):
    diagnostic('imports')
    import numpy as np
    import torch
    import torch.nn.functional as F
    import yaml
    from packaging.version import Version
    if Version(torch.__version__.split("+")[0]) < Version("2.6.0"):
        raise RuntimeError("The separation model needs PyTorch 2.6.0 or newer. Run setup again.")
    from scipy.io import wavfile
    sys.path.insert(0, str(ENGINE))
    model = models_dir()
    from models.bs_roformer.bs_roformer import BSRoformer

    diagnostic('read_audio', torch_version=torch.__version__, mps_available=torch.backends.mps.is_available(), mps_built=torch.backends.mps.is_built())
    rate, audio = wavfile.read(input_file)
    if rate != 44100 or audio.ndim != 2 or audio.shape[1] != 2 or audio.dtype != np.float32:
        raise ValueError('Separation needs stereo float32 WAV at 44.1 kHz.')
    if not 0 < max_seconds <= 600 or not 0 < len(audio) <= 44100 * max_seconds or not np.isfinite(audio).all():
        raise ValueError('Invalid input length or nonfinite audio.')
    if any((out / (name + '.wav')).exists() for name in NAMES):
        raise ValueError('Refusing to overwrite stem files.')
    config_text = (model / 'BS-Rofo-SW-Fixed.yaml').read_text()
    # Only the tuple marker is accepted; SafeLoader still rejects arbitrary Python tags.
    config = yaml.safe_load(config_text.replace('!!python/tuple', ''))
    if config['training']['instruments'] != [x.lower() for x in NAMES]:
        raise ValueError('Unexpected model stem order.')
    model_args = config['model']
    for key in ['freqs_per_bands', 'multi_stft_resolutions_window_sizes']:
        model_args[key] = tuple(model_args[key])
    checkpoint = model / 'BS-Rofo-SW-Fixed.ckpt'
    diagnostic('verify_model')
    digest = verify_checkpoint(checkpoint)
    diagnostic('load_model', model_sha256=digest, config_sha256=hashlib.sha256(config_text.encode()).hexdigest())
    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    net = BSRoformer(**model_args)
    net.load_state_dict(torch.load(checkpoint, map_location='cpu', weights_only=True), strict=True)
    if device not in ("cpu", "mps", "auto"):
        raise ValueError("Unsupported inference device.")
    device = ("mps" if torch.backends.mps.is_available() else "cpu") if device == "auto" else device
    diagnostic('device_transfer', device=device, fft_device='cpu', dtype='float32')
    net.to(device).eval()
    if device_callback:
        device_callback(device)
    write_progress(out, 0.05)
    source = torch.from_numpy(audio.T.copy())
    length = source.shape[-1]
    chunk = int(config['audio']['chunk_size'])
    # overlap=None keeps the checkpoint config's num_overlap (2); more overlap averages more predictions.
    overlap = int(config['inference']['num_overlap']) if overlap is None else int(overlap)
    if not 1 <= overlap <= 8:
        raise ValueError('Unsupported overlap.')
    step = chunk // overlap
    border, fade = chunk - step, chunk // 10
    if length > 2 * border:
        source = F.pad(source, (border, border), mode='reflect')
    output = torch.zeros(6, 2, source.shape[-1])
    count = torch.zeros(source.shape[-1])
    window = torch.ones(chunk)
    window[:fade] = torch.linspace(0, 1, fade)
    window[-fade:] = torch.linspace(1, 0, fade)
    diagnostic('inference', overlap=overlap, chunk_size=chunk, hop_size=step, chunks=len(range(0, source.shape[-1], step)), batch_size=1, threads=torch.get_num_threads(), interop_threads=torch.get_num_interop_threads())
    started = time.monotonic()
    with torch.inference_mode():
        for start in range(0, source.shape[-1], step):
            part = source[:, start:start + chunk]
            valid = part.shape[-1]
            part = F.pad(part, (0, chunk - valid), mode='reflect' if valid > chunk // 2 else 'constant')
            predicted = net(part.unsqueeze(0).to(device))[0].cpu()
            if predicted.shape != (6, 2, chunk) or not torch.isfinite(predicted).all():
                raise ValueError('Invalid six-stem model output.')
            if start == 0:
                diagnostic('first_chunk_complete', first_chunk_seconds=time.monotonic() - started)
            weight = window.clone()
            if start == 0:
                weight[:fade] = 1
            if start + step >= source.shape[-1]:
                weight[-fade:] = 1
            output[..., start:start + valid] += predicted[..., :valid] * weight[:valid]
            count[start:start + valid] += weight[:valid]
            write_progress(out, 0.05 + 0.9 * min(start + step, source.shape[-1]) / source.shape[-1])
    diagnostic('reconstruct', inference_seconds=time.monotonic() - started)
    if not (count > 0).all():
        raise ValueError('Uncovered output samples.')
    output /= count
    if length > 2 * border:
        output = output[..., border:-border]
    if output.shape != (6, 2, length) or not torch.isfinite(output).all():
        raise ValueError('Invalid reconstructed stem length or values.')
    diagnostic('write_intermediate_audio')
    for name, data in zip(NAMES, output.numpy()):
        wavfile.write(out / (name + '.wav'), 44100, data.T.copy())
    (out / 'result.json').write_text(json.dumps({'names': NAMES, 'frames': length, 'sample_rate': 44100, 'inference_seconds': time.monotonic() - started, 'device': device, 'overlap': overlap, 'threads': 4, 'chunk_size': chunk, 'sha256': digest}, indent=2))
    write_progress(out, 1)
