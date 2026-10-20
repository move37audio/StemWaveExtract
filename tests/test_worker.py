import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
from scipy.io import wavfile

spec = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'engine' / 'separate.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class ExportTests(unittest.TestCase):
    def test_selection_combinations_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); raw = root / 'raw'; raw.mkdir()
            for index, name in enumerate(worker.NAMES):
                wavfile.write(raw / (name + '.wav'), 44100, np.full((129, 2), (index + 1) / 16, np.float32))
            # (outputs, remainder) -> expected files. Without remainder a stem is exported alone.
            cases = {
                (('drums',), False): {'Drums': 2},
                (('acapella',), False): {'Acapella': 4},
                (('instrumental',), False): {'Instrumental': 17},
                (('drums',), True): {'Drums': 2, 'Everything but Drums': 19},
                (('drums', 'bass'), True): {'Bass': 1, 'Drums': 2, 'Everything but Bass and Drums': 18},
                (('acapella',), True): {'Acapella': 4, 'Everything but Vocals': 17},
                (('instrumental',), True): {'Instrumental': 17, 'Everything but Bass and Drums and Other and Guitar and Piano': 4},
                (('acapella', 'instrumental'), True): {'Acapella': 4, 'Instrumental': 17},
                (('acapella', 'vocals'), True): {'Acapella': 4, 'Everything but Vocals': 17},
                (('vocals', 'drums'), True): {'Drums': 2, 'Vocals': 4, 'Everything but Drums and Vocals': 15},
                (tuple(n.lower() for n in worker.NAMES), True): dict(zip(worker.NAMES, range(1, 7))),
                (tuple(sorted(worker.OUTPUTS)), True): {'Acapella': 4, 'Instrumental': 17, 'Bass': 1, 'Drums': 2, 'Other': 3, 'Guitar': 5, 'Piano': 6},
            }
            source = 'Puerto Rico (The Original Mix)'
            for (outputs, remainder), expected in cases.items():
                out = root / ('-'.join(outputs) + ('+rest' if remainder else '')); out.mkdir()
                self.assertEqual(worker.export_selected(raw, out, set(outputs), source, remainder), 129)
                files = sorted(out.glob('*.wav'))
                self.assertEqual([f.name for f in files], sorted(f'{source} ({label}).wav' for label in expected))
                for label, value in expected.items():
                    data = wavfile.read(out / f'{source} ({label}).wav')[1]
                    np.testing.assert_array_equal(data, np.full((129, 2), value / 16, np.float32))
                before = {f.name: f.read_bytes() for f in files}
                with self.assertRaises(ValueError): worker.export_selected(raw, out, set(outputs), source, remainder)
                self.assertEqual(before, {f.name: f.read_bytes() for f in files})
            for bad in [set(), {'all'}, {'../x'}]:
                with self.assertRaises(ValueError): worker.plan(bad)
            wavfile.write(raw / 'Bass.wav', 44100, np.full((129, 2), np.nan, np.float32))
            out = root / 'invalid'; out.mkdir()
            with self.assertRaises(ValueError): worker.export_selected(raw, out, {'bass'}, source)
            self.assertEqual(list(out.iterdir()), [])

    def test_extraction_exports_only_audio(self):
        import json
        import sys
        from types import SimpleNamespace
        from unittest.mock import patch

        def separate(_input, raw, **_kwargs):
            for name in worker.NAMES:
                wavfile.write(raw / (name + '.wav'), 44100, np.zeros((8, 2), np.float32))
            (raw / 'result.json').write_text('{}')

        for subfolder in [True, False]:
            with self.subTest(subfolder=subfolder), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source = root / 'Song.wav'; source.touch()
                output = root / 'output'; output.mkdir()
                work = root / 'work'; work.mkdir()
                progress = work / 'progress.json'
                with patch.dict(sys.modules, core=SimpleNamespace(run=separate)), \
                     patch.object(worker, 'media_duration', return_value=1), \
                     patch.object(worker.subprocess, 'run'):
                    worker.run(source, output, {'drums'}, progress, mode='original', subfolder=subfolder)
                files = sorted(p.relative_to(output).name for p in output.rglob('*') if p.is_file())
                self.assertEqual(files, ['Song (Drums).wav'])
                self.assertEqual(json.loads(progress.read_text())['status'], 'complete')

    def test_naming_patterns(self):
        files = worker.plan({'drums'}, True)
        self.assertEqual(sorted(worker.output_filenames(files, 'Song (Mix)', 'paren').values()), ['Song (Mix) (Drums).wav', 'Song (Mix) (Everything but Drums).wav'])
        self.assertEqual(sorted(worker.output_filenames(files, 'Song', 'dash').values()), ['Song - Drums.wav', 'Song - Everything but Drums.wav'])
        self.assertEqual(sorted(worker.output_filenames(files, 'Song', 'stem').values()), ['Drums.wav', 'Everything but Drums.wav'])
        with self.assertRaises(ValueError): worker.output_filenames(files, 'Song', 'other')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); raw = root / 'raw'; raw.mkdir()
            for name in worker.NAMES:
                wavfile.write(raw / (name + '.wav'), 44100, np.zeros((8, 2), np.float32))
            worker.export_selected(raw, root, {'drums'}, 'Song', False, 'dash')
            self.assertTrue((root / 'Song - Drums.wav').is_file())
            worker.export_selected(raw, root, {'drums'}, 'Other', False, 'stem')
            with self.assertRaises(ValueError):  # stem-only names collide on the next track: refused, not overwritten
                worker.export_selected(raw, root, {'drums'}, 'Third', False, 'stem')

    def test_export_name_validation_precedes_audio_reads(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for source in ['', '.', '..', '../track', 'track/name', 'track\\name', 'track\0name', 'é' * 120]:
                with self.assertRaises(ValueError):
                    worker.export_selected(root / 'missing', root, {'drums'}, source, True)
                self.assertEqual(list(root.iterdir()), [])
            names = worker.output_filenames(worker.plan({'drums'}, True), 'é' * 100 + ' (Mix)')
            self.assertIn('é' * 100 + ' (Mix) (Everything but Drums).wav', names.values())
            longest_suffix = ' (Everything but Drums).wav'
            exact = 'x' * (255 - len(longest_suffix))
            self.assertEqual(len(worker.output_filenames(worker.plan({'drums'}, True), exact)['Everything but Drums'].encode()), 255)
            with self.assertRaisesRegex(ValueError, '255 bytes'):
                worker.output_filenames(worker.plan({'drums'}, True), exact + 'x')

    def test_progress_eta(self):
        import json
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'progress.json'; p = worker.Progress(path)
            p.model_progress(None, .05)
            self.assertIsNone(json.loads(path.read_text())['eta_seconds'])
            p.device = 'Metal GPU'
            p.model_progress(None, .5)
            status = json.loads(path.read_text())
            self.assertIn('Metal GPU', status['message'])
            self.assertGreater(status['progress'], .12)
            self.assertGreaterEqual(status['eta_seconds'], 0)
            self.assertLess(status['progress'], 1)

class CheckpointTests(unittest.TestCase):
    def test_verification_never_writes_into_bundle(self):
        import sys
        import hashlib
        from unittest.mock import patch
        sys.path.insert(0, str(worker.ENGINE))
        import core
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / 'model.ckpt'
            checkpoint.write_bytes(b'fixture')
            expected = hashlib.sha256(b'fixture').hexdigest()
            with patch.object(core, 'EXPECTED', expected):
                self.assertEqual(core.verify_checkpoint(checkpoint), expected)
                self.assertEqual(list(Path(folder).iterdir()), [checkpoint])
                checkpoint.write_bytes(b'corrupt')
                with self.assertRaises(ValueError): core.verify_checkpoint(checkpoint)

class SetupTests(unittest.TestCase):
    def test_bundled_checkpoint_is_checked_before_install(self):
        import hashlib
        import os
        import subprocess
        script = (worker.ENGINE / 'setup.sh').read_text()
        function = 'download()' + script.split('download()', 1)[1].split('\necho "STEP 1/5', 1)[0]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            engine = root / 'engine'; engine.mkdir()
            bundled = root / 'checkpoints'; bundled.mkdir()
            payload = b'test checkpoint'
            (bundled / 'model.ckpt').write_bytes(payload)
            destination = root / 'runtime' / 'model.ckpt'; destination.parent.mkdir()
            env = dict(os.environ, ENGINE=str(engine))
            command = ['bash', '-c', 'set -euo pipefail\n' + function + '\ndownload "$@"', 'test',
                       'https://invalid.example/model', str(destination), hashlib.sha256(payload).hexdigest()]
            subprocess.run(command, env=env, check=True, capture_output=True)
            self.assertEqual(destination.read_bytes(), payload)
            destination.unlink()
            (bundled / 'model.ckpt').write_bytes(b'corrupt')
            result = subprocess.run(command, env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix('.ckpt.part').exists())

class MetalTests(unittest.TestCase):
    def test_real_model_fft_boundary_matches_cpu(self):
        import sys
        import torch
        sys.path.insert(0, str(worker.ENGINE))
        from models.bs_roformer.bs_roformer import BSRoformer
        if not torch.backends.mps.is_available():
            self.skipTest('Metal GPU is unavailable on this machine')
        torch.manual_seed(42)
        model = BSRoformer(dim=16, depth=1, stereo=True, num_stems=6,
                          time_transformer_depth=1, freq_transformer_depth=1,
                          freqs_per_bands=(4, 5), dim_head=8, heads=2,
                          dim_freqs_in=9, stft_n_fft=16, stft_win_length=16,
                          stft_hop_length=4).eval()
        audio = torch.randn(1, 2, 128)
        with torch.inference_mode():
            expected = model(audio)
            actual = model.to('mps')(audio.to('mps')).cpu()
        self.assertEqual(actual.shape, (1, 6, 2, 128))
        self.assertTrue(torch.isfinite(actual).all())
        torch.testing.assert_close(actual, expected, atol=2e-5, rtol=2e-4)

    def test_fast_attention_matches_upstream(self):
        import torch
        worker.install_fast_attention()
        from models.bs_roformer.bs_roformer import Attention
        from rotary_embedding_torch import RotaryEmbedding
        self.assertTrue(Attention.forward.stemwave_fast)
        torch.manual_seed(7)
        for device in ['cpu'] + (['mps'] if torch.backends.mps.is_available() else []):
            rotary = Attention(32, heads=4, dim_head=16, rotary_embed=RotaryEmbedding(dim=16)).to(device).eval()
            plain = Attention(32, heads=4, dim_head=16).to(device).eval()  # falls back to upstream
            for module, shape in [(rotary, (3, 37, 32)), (rotary, (11, 5, 32)), (plain, (2, 9, 32))]:
                x = torch.randn(*shape, device=device)
                with torch.inference_mode():
                    torch.testing.assert_close(module(x), Attention.upstream_forward(module, x), atol=1e-5, rtol=1e-4)

    def test_quality_tta_averages_three_views(self):
        import torch
        worker.install_tta()
        from models.bs_roformer.bs_roformer import BSRoformer
        self.assertTrue(BSRoformer.forward.stemwave_tta)
        torch.manual_seed(3)
        model = BSRoformer(dim=16, depth=1, stereo=True, num_stems=6, time_transformer_depth=1,
                           freq_transformer_depth=1, freqs_per_bands=(4, 5), dim_head=8, heads=2,
                           dim_freqs_in=9, stft_n_fft=16, stft_win_length=16, stft_hop_length=4).eval()
        audio = torch.randn(1, 2, 128)
        audio[:, 1] *= .3  # asymmetric stereo, so the swap matters
        view = lambda x: BSRoformer.upstream_forward(model, x)
        with torch.inference_mode():
            actual = model(audio)
            plain = view(audio)
            expected = (plain + view(audio.flip(1)).flip(2) - view(-audio)) / 3
        self.assertEqual(actual.shape, (1, 6, 2, 128))
        torch.testing.assert_close(actual, expected)
        self.assertFalse(torch.allclose(actual, plain), 'TTA changes the estimate')

    def test_region_and_tag_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            f = Path(folder)
            for start, end, tag in [(5, 2, None), (-1, 2, None), (0, None, None), (0, 601, None), (0, 2, '../x'), (0, 2, '')]:
                with self.assertRaises(ValueError):
                    worker.run(f / 'missing.wav', f, {'drums'}, f / 'p.json', start=start, end=end, tag=tag)

    def test_modes(self):
        self.assertEqual(set(worker.MODES), {'fast', 'good', 'quality', 'original'})
        self.assertEqual((worker.MODES['good']['overlap'], worker.MODES['good']['tta']), (4, False))
        self.assertEqual((worker.MODES['quality']['overlap'], worker.MODES['quality']['tta']), (4, True))
        self.assertFalse(worker.MODES['original']['fast'] or worker.MODES['original']['tta'])
        self.assertIsNone(worker.MODES['fast']['overlap'])
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                worker.run(Path(folder) / 'missing.wav', Path(folder), {'vocals'}, Path(folder) / 'p.json', mode='turbo')

if __name__ == '__main__': unittest.main()
