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
assert record['observation_extent'].startswith('All nine source frames observed:')
assert record['visible_content'] == 'Dotted JZ brand mark: cyan dots form J on the left; purple/pink dots form Z on the right.'
observations = record['additional_DIB_frame_observations']
assert len(observations) == 8
for index, item in enumerate(observations):
    w, h, _, _, _, depth, size, offset = struct.unpack_from('<BBBBHHII', body, 6 + 16 * index)
    part = body[offset:offset + size]
    assert struct.unpack_from('<IiiHHI', part) == (40, w, 2 * h, 1, 32, 0)
    pixels = part[40:40 + w * h * 4]
    mask = part[40 + w * h * 4:]
    assert len(mask) == ((w + 31) // 32) * 4 * h
    rgba = bytearray()
    for y in range(h - 1, -1, -1):
        row = pixels[y * w * 4:(y + 1) * w * 4]
        for x in range(w):
            blue, green, red, alpha = row[4 * x:4 * x + 4]
            rgba.extend((red, green, blue, alpha))
    assert (item['frame_index'], item['width'], item['height'], item['source_offset'], item['source_length']) == (index, w, h, offset, size)
    for key, value in [('source_frame_sha256', part), ('source_BGRA_sha256', pixels),
                       ('AND_mask_sha256', mask), ('decoded_RGBA_sha256', rgba)]:
        assert hashlib.sha256(value).hexdigest() == item[key]
    assert item['fixed_English_sentence_observed'] is False
    assert item['visible_content'] == 'Dotted cyan J and purple/pink Z brand mark; no English sentence observed.'
print('PASS exact Git/ICO/PNG and eight BGRA/RGBA/mask provenance records; nine visual observations are not repeated by this source-only check.')
