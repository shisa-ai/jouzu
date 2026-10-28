"""Check provenance of a bounded visual observation; no image decoding or UI."""
import hashlib
import json
from pathlib import Path
import struct
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
record = json.loads((HERE / 'icon-visual-observation.json').read_text(encoding='utf8'))
assert record['source_revision'] == '346d1e481757a55eb62fc066e43bbc7999b8e6dd'
assert record['path'] == 'apps/launcher/src-tauri/icons/icon.ico'
source = record['source_revision'] + ':' + record['path']
body = subprocess.check_output(['git', 'show', source], cwd=ROOT)
assert hashlib.sha256(body).hexdigest() == record['source_sha256']
assert subprocess.check_output(['git', 'rev-parse', source], cwd=ROOT).decode().strip() == record['git_blob']
assert struct.unpack_from('<HHH', body) == (0, 1, 9)
assert record['frame_index_zero_based'] == 8
w, h, _, _, _, depth, size, offset = struct.unpack_from('<BBBBHHII', body, 6 + 16 * 8)
assert (w or 256, h or 256, depth, size, offset) == (256, 256, 32, 4042, 110662)
assert (record['frame_width'], record['frame_height'], record['frame_bits_per_pixel'],
        record['frame_byte_length'], record['frame_byte_offset']) == (256, 256, 32, size, offset)
frame = body[offset:offset + size]
assert frame.startswith(b'\x89PNG\r\n\x1a\n')
assert hashlib.sha256(frame).hexdigest() == record['frame_sha256'] == '4dc6c8925c2e0371b90f30c47688089ae09f11c177f00dae8efc2a14ca2846e9'
assert record['fixed_English_sentence_observed'] is False
assert 'other eight DIB frames' in record['observation_extent']
assert record['visible_content'] == 'Dotted JZ brand mark: cyan dots form J on the left; purple/pink dots form Z on the right.'
print('PASS exact Git/ICO/embedded PNG provenance; visual observation is bounded to one frame, not repeated by this source-only check.')
