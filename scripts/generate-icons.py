"""Render the code-defined app mark without external image dependencies."""
import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "build"
OUTPUT.mkdir(exist_ok=True)

def rounded_distance(x, y, left, top, right, bottom, radius):
    qx = abs(x - (left + right) / 2) - (right - left) / 2 + radius
    qy = abs(y - (top + bottom) / 2) - (bottom - top) / 2 + radius
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - radius

def segment_distance(x, y, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = min(1, max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - ax - t * dx, y - ay - t * dy)

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)

def render(size, simple=None):
    simple = size <= 64 if simple is None else simple
    rows = bytearray()
    scale = 1024 / size
    for y in range(size):
        rows.append(0)
        for x in range(size):
            px, py = (x + .5) * scale, (y + .5) * scale
            outer = rounded_distance(px, py, 42, 42, 982, 982, 210)
            alpha = min(1, max(0, .5 - outer / scale))
            color = [22, 28, 40]
            coral = [255, 122, 92]
            if simple:
                # Menu and list sizes: the thin frame turns to mush, so draw a bold prompt only.
                strength = 0
                mark = min(segment_distance(px, py, 270, 300, 500, 512), segment_distance(px, py, 500, 512, 270, 724), segment_distance(px, py, 570, 724, 790, 724))
                strength = min(1, max(0, .5 - (mark - 62) / scale))
            else:
                border = rounded_distance(px, py, 127, 176, 897, 848, 117)
                strength = min(1, max(0, .5 - (abs(border) - 17) / scale))
                mark = min(segment_distance(px, py, 300, 362, 454, 511), segment_distance(px, py, 454, 511, 300, 660), segment_distance(px, py, 552, 665, 735, 665))
                strength = max(strength, min(1, max(0, .5 - (mark - 29) / scale)))
            color = [round(a * (1 - strength) + b * strength) for a, b in zip(color, coral)]
            rows.extend([*color, round(alpha * 255)])
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")

png = render(1024)
(OUTPUT / "icon.png").write_bytes(png)
small = render(256)
# Windows picks the closest size, so ship the small, simplified ones too.
ico_images = [(size, render(size)) for size in (16, 24, 32, 48, 64)] + [(256, small)]
offset = 6 + 16 * len(ico_images)
entries, blobs = b'', b''
for size, data in ico_images:
    entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
    blobs += data
    offset += len(data)
(OUTPUT / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(ico_images)) + entries + blobs)
types = [('icp4', 16), ('icp5', 32), ('icp6', 64), ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024), ('ic11', 32), ('ic12', 64), ('ic13', 256), ('ic14', 512)]
images = {1024: png, 256: small}
chunks = []
for kind, size in types:
    if size not in images:
        images[size] = render(size)
    data = images[size]
    chunks.append(kind.encode() + struct.pack('>I', len(data) + 8) + data)
body = b''.join(chunks)
(OUTPUT / 'icon.icns').write_bytes(b'icns' + struct.pack('>I', len(body) + 8) + body)
(OUTPUT / "icon.svg").write_text('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="42" y="42" width="940" height="940" rx="210" fill="#161c28"/><rect x="127" y="176" width="770" height="672" rx="117" stroke="#ff7a5c" stroke-width="34" fill="none"/><path d="m300 362 154 149-154 149m252 5h183" fill="none" stroke="#ff7a5c" stroke-width="58" stroke-linecap="round" stroke-linejoin="round"/></svg>''')
print("Generated build/icon.png, icon.ico, icon.icns and icon.svg")
