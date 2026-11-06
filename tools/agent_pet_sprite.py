#!/usr/bin/env python3
"""Turn artwork you are entitled to use into a LOCAL cute pixel pet for the whale theme.

    python tools/agent_pet_sprite.py [--from image.png] [--preview out.png]

Without --from it reads the app icon of a locally installed DeepSeek Harness.
The dark silhouette is extracted, rasterised onto a coarse grid and dressed up
in a chibi pixel style: dark outline, shading and highlight, light belly from
the artwork's own cut-outs, one big round eye with a highlight and blush. Seven
frames are derived (rest, tail up/down, blink, happy, alert, squash) by
transforming the silhouette before rasterising. The result is written to
main/local/ (gitignored); the firmware uses it instead of the original whale
when main/local/pet_whale_override.c exists. Third-party logos stay on your
machine: never commit the generated files or distribute firmware built with
them. Requires Pillow.
"""
import argparse
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'main/local'
DEFAULT = Path('/Applications/DeepSeek Harness.app/Contents/Resources/icon.png')
COLS, ROWS, K = 56, 36, 8           # grid cells (2 px each on the overview); supersampling per cell
U = COLS // 28                       # face features are designed on a 28-wide grid
# 0xAARRGGBB. No outline: 'a' is a half-transparent body edge that softens the silhouette.
PALETTE = [0x804D6BFE, 0xFF4D6BFE, 0xFF3A55E0, 0xFF8FA5FF, 0xFFDCE4FF, 0xFF141828, 0xFFFFFFFF, 0xFFFF9DB8]
#           a soft edge  b body      c shade     d light     e belly     f eye       g shine     h blush
# Tail cut for the default artwork, in fractions of the silhouette box.
TAIL = [(0.62, -0.05), (1.05, -0.05), (1.05, 0.34), (0.86, 0.36), (0.80, 0.40),
        (0.72, 0.40), (0.68, 0.32), (0.62, 0.18)]
PIVOT = (0.79, 0.36)


def silhouette(path, threshold=40):
    image = Image.open(path).convert('RGBA')
    gray = image.convert('L')
    alpha = image.getchannel('A')
    # Darkness above the threshold becomes opacity; light background drops out.
    span = max(1, 200 - threshold)
    mask = gray.point(lambda v: 0 if 255 - v <= threshold else min(255, (255 - v - threshold) * 255 // span))
    mask = Image.composite(mask, Image.new('L', mask.size, 0), alpha)
    bbox = mask.point(lambda v: 255 if v > 32 else 0).getbbox()
    if not bbox:
        raise SystemExit('no dark silhouette found; pass a dark-on-light image')
    return mask.crop(bbox)


def place(mask):
    """Fit the silhouette into the grid canvas, leaving one cell for the outline."""
    inner = ((COLS - 2) * K, (ROWS - 2) * K)
    scale = min(inner[0] / mask.width, inner[1] / mask.height)
    size = (round(mask.width * scale), round(mask.height * scale))
    canvas = Image.new('L', (COLS * K, ROWS * K), 0)
    origin = (K + (inner[0] - size[0]) // 2, K + (inner[1] - size[1]) // 2)
    canvas.paste(mask.resize(size, Image.LANCZOS), origin)
    return canvas, origin, size


def to_canvas(fx, fy, origin, size):
    return (origin[0] + fx * size[0], origin[1] + fy * size[1])


def wag(canvas, origin, size, degrees):
    """Rotate only the tail around its base."""
    poly = [to_canvas(x, y, origin, size) for x, y in TAIL]
    region = Image.new('L', canvas.size, 0)
    ImageDraw.Draw(region).polygon(poly, fill=255)
    tail = Image.composite(canvas, Image.new('L', canvas.size, 0), region)
    body = Image.composite(Image.new('L', canvas.size, 0), canvas, region)
    pivot = to_canvas(*PIVOT, origin, size)
    turned = tail.rotate(degrees, resample=Image.BICUBIC, center=pivot)
    return Image.composite(Image.new('L', canvas.size, 255), body, turned.point(lambda v: 255 if v > 127 else 0))


def tilt(canvas, degrees):
    return canvas.rotate(degrees, resample=Image.BICUBIC, center=(canvas.width / 2, canvas.height * 0.6))


def squash(canvas):
    w, h = canvas.size
    bbox = canvas.getbbox()
    shape = canvas.crop(bbox)
    new = shape.resize((round(shape.width * 1.08), round(shape.height * 0.88)), Image.LANCZOS)
    out = Image.new('L', canvas.size, 0)
    out.paste(new, ((w - new.width) // 2, min(h - K, bbox[3]) - new.height))
    return out


def raster(canvas):
    """Cells: 'b' body, 'e' interior cut-out (belly/eye), 'a' partly covered edge, '.' outside."""
    solid = canvas.point(lambda v: 255 if v > 127 else 0)
    outside = solid.copy()
    ImageDraw.floodfill(outside, (0, 0), 128)   # background reachable from the edge
    grid = []
    for r in range(ROWS):
        row = ''
        for c in range(COLS):
            box = (c * K, r * K, (c + 1) * K, (r + 1) * K)
            cell = outside.crop(box)
            hist = cell.histogram()
            total = K * K
            body, hole = hist[255] / total, hist[0] / total
            row += 'b' if body >= 0.5 else 'e' if hole >= 0.5 else 'a' if body >= 0.2 else '.'
        grid.append(list(row))
    return grid


def components(grid, kind):
    seen, parts = set(), []
    for r in range(ROWS):
        for c in range(COLS):
            if grid[r][c] != kind or (r, c) in seen:
                continue
            stack, part = [(r, c)], []
            seen.add((r, c))
            while stack:
                y, x = stack.pop()
                part.append((y, x))
                for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                    if 0 <= ny < ROWS and 0 <= nx < COLS and grid[ny][nx] == kind and (ny, nx) not in seen:
                        seen.add((ny, nx))
                        stack.append((ny, nx))
            parts.append(part)
    return parts


def dress(grid, eye, face):
    """Soft shading, highlight and a chibi face around `eye` (row, col). No outline."""
    filled = lambda y, x: 0 <= y < ROWS and 0 <= x < COLS and grid[y][x] in 'be'
    # Small cut-outs (the artwork's eye) become body; the big one stays a light belly.
    for part in components(grid, 'e'):
        if len(part) <= 6 * U * U:
            for y, x in part:
                grid[y][x] = 'b'
    out = [row[:] for row in grid]
    for y in range(ROWS):
        for x in range(COLS):
            if grid[y][x] == 'b':
                if not filled(y + 1, x) or not filled(y, x + 1):
                    out[y][x] = 'c'
                elif not filled(y - 1, x) and x < COLS * 0.55:
                    out[y][x] = 'd'
    ey, ex = eye
    def put(y, x, v):
        if 0 <= y < ROWS and 0 <= x < COLS and out[y][x] in ('bcdef' if v == 'g' else 'bcde'):
            out[y][x] = v
    def blob(top, left, w, h, v):
        """Filled rectangle with its four corner cells trimmed: reads as round."""
        for dy in range(h):
            for dx in range(w):
                if (dy in (0, h - 1)) and (dx in (0, w - 1)):
                    continue
                put(top + dy, left + dx, v)
    if face == 'blink':
        put(ey + 2, ex, 'f'); put(ey + 2, ex + 4, 'f')
        for dx in range(1, 4):
            put(ey + 3, ex + dx, 'f')
    elif face == 'happy':
        for dy, dx in ((3, -1), (2, 0), (1, 1), (1, 2), (2, 3), (3, 4)):
            put(ey + dy, ex + dx, 'f'); put(ey + dy + 1, ex + dx, 'f')
    else:
        alert = face == 'alert'
        top = ey - (2 if alert else 0)
        blob(top, ex, 5, 8 if alert else 6, 'f')
        put(top + 1, ex + 1, 'g'); put(top + 1, ex + 2, 'g'); put(top + 2, ex + 1, 'g')
        if alert:
            put(top + 5, ex + 3, 'g')
    blob(ey + 7, ex + 1, 5, 2, 'h')
    return [''.join(row) for row in out]


def eye_of(grid):
    """Centre of the artwork's own small cut-outs, else a head-ish default."""
    small = [p for p in components(grid, 'e') if len(p) <= 6 * U * U]
    cells = [cell for part in small for cell in part]
    if not cells:
        return (ROWS // 2 - 1, COLS // 2)
    y = round(sum(r for r, _ in cells) / len(cells)) - 2 * U
    x = round(sum(c for _, c in cells) / len(cells)) - 2 * U
    return (y, x)


def frames(mask):
    canvas, origin, size = place(mask)
    base = raster(canvas)
    eye = eye_of(base)
    def frame(img, face='open', shift=(0, 0)):
        grid = raster(img)
        e = eye_of(grid) if face == 'alert' else (eye[0] + shift[0], eye[1] + shift[1])
        return dress(grid, e, face)
    return {
        'REST': frame(canvas),
        'TAIL_UP': frame(wag(canvas, origin, size, 14)),
        'TAIL_DOWN': frame(wag(canvas, origin, size, -12)),
        'BLINK': frame(canvas, 'blink'),
        'HAPPY': frame(wag(canvas, origin, size, 14), 'happy'),
        'ALERT': frame(tilt(canvas, -8), 'alert'),
        'SQUASH': frame(squash(canvas), 'open', (U, 0)),
    }, eye


def emit_of(grid):
    for y, row in enumerate(grid):
        for x, cell in enumerate(row[:COLS // 2]):
            if cell != '.':
                return x + 1, max(0, y - 1)
    return COLS // 3, 1


def preview(all_frames, path):
    scale = 3
    sheet = Image.new('RGB', ((COLS * scale + 8) * 4, (ROWS * scale + 8) * 2), (238, 242, 255))
    draw = ImageDraw.Draw(sheet)
    for i, grid in enumerate(all_frames.values()):
        ox, oy = (i % 4) * (COLS * scale + 8) + 4, (i // 4) * (ROWS * scale + 8) + 4
        for y, row in enumerate(grid):
            for x, cell in enumerate(row):
                if cell != '.':
                    color = PALETTE[ord(cell) - 97]
                    a = (color >> 24) / 255
                    bg = (238, 242, 255)
                    rgb = tuple(round(((color >> sh) & 255) * a + bg[i] * (1 - a)) for i, sh in enumerate((16, 8, 0)))
                    draw.rectangle([ox + x * scale, oy + y * scale, ox + x * scale + scale - 1, oy + y * scale + scale - 1], fill=rgb)
    sheet.save(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--from', dest='source', type=Path, default=DEFAULT)
    parser.add_argument('--threshold', type=int, default=40, help='darkness (0-199) below which pixels are background')
    parser.add_argument('--preview', type=Path, help='also save a magnified sheet of all frames')
    args = parser.parse_args()
    if not args.source.exists():
        raise SystemExit(f'{args.source} not found; pass --from <image.png>')
    all_frames, _ = frames(silhouette(args.source, args.threshold))
    emit = emit_of(all_frames['REST'])
    OUT.mkdir(exist_ok=True)
    body = '\n'.join(f'    [PET_PIXEL_{name}] =\n' + '\n'.join(f'        "{row}"' for row in grid) + ','
                     for name, grid in all_frames.items())
    palette = ', '.join(f'0x{c:08X}' for c in PALETTE)
    (OUT / 'pet_whale_override.h').write_text(
        '/* LOCAL ONLY, generated by tools/agent_pet_sprite.py. Do not commit. */\n'
        '#include "pet_pixel.h"\n#define PET_WHALE_PIXEL 1\n'
        '#define PET_WHALE_EYE_X -1  /* the pixel frames draw their own eye */\n#define PET_WHALE_EYE_Y 0\n'
        f'#define PET_WHALE_EMIT_X {emit[0] * (112 // COLS)}\n#define PET_WHALE_EMIT_Y {emit[1] * (112 // COLS)}\n'
        'extern const pet_pixel_sprite_t pet_whale_pixel;\n')
    (OUT / 'pet_whale_override.c').write_text(
        '/* LOCAL ONLY, generated by tools/agent_pet_sprite.py from user-supplied artwork. Do not commit. */\n'
        '#include "pet_whale_img.h"\n\n'
        f'const pet_pixel_sprite_t pet_whale_pixel = {{\n    .w = {COLS}, .h = {ROWS},\n'
        f'    .palette = {{{palette}}},\n    .emit_x = {emit[0]}, .emit_y = {emit[1]},\n'
        f'    .frames = {{\n{body}\n    }},\n}};\n')
    if args.preview:
        preview(all_frames, args.preview)
    print(f'wrote {OUT.relative_to(ROOT)}/pet_whale_override.c: {len(all_frames)} pixel frames, {COLS}x{ROWS} cells')


if __name__ == '__main__':
    main()
