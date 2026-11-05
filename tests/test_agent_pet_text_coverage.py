#!/usr/bin/env python3
"""Every runtime status has Chinese copy, and every UI character has a glyph."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / 'assets/fonts/agent-pet'


def literals(fragment):
    return [m.encode('latin-1', 'backslashreplace').decode('unicode_escape') if '\\' in m else m
            for m in re.findall(r'"((?:[^"\\]|\\.)*)"', fragment)]


def runtime_statuses():
    source = (ROOT / 'main/agent_pet_runtime.c').read_text(encoding='utf-8')
    found = set()
    args = r'((?:"(?:[^"\\]|\\.)*"|[^;"])*)'
    for pattern in (r'\bstatus\(' + args + r'\);', r'snprintf\(status_text,sizeof\(status_text\),' + args + r'\);',
                    r'status_text\[\d+\]=("[^"]*")'):
        for fragment in re.findall(pattern, source):
            found.update(s for s in literals(fragment) if s and s != '%s')
    found.add('Runtime unavailable')
    return found


def table():
    source = (ROOT / 'main/agent_pet_text.c').read_text(encoding='utf-8')
    known = set(re.findall(r'\{"([^"]+)","[^"]*"\}', source))
    known.add('Service synchronized')
    return known


def coverage(name):
    return {int(line[2:], 16) for line in (FONTS / name).read_text().split()}


def main():
    problems = []
    statuses = runtime_statuses()
    if len(statuses) < 20:
        problems.append(f'only {len(statuses)} runtime statuses found; extraction pattern is stale')
    for status in sorted(statuses - table()):
        problems.append(f'runtime status has no Chinese copy: {status!r}')
    gb2312, ui = coverage('coverage.txt'), coverage('coverage-ui.txt')
    for name in ('main/main.c', 'main/agent_pet_text.c'):
        text = (ROOT / name).read_text(encoding='utf-8')
        for char in sorted({c for c in text if ord(c) > 126}):
            if ord(char) not in gb2312:
                problems.append(f'{name}: {char!r} U+{ord(char):04X} is outside the 16 px GB2312 font')
            if ord(char) not in ui:
                problems.append(f'{name}: {char!r} U+{ord(char):04X} missing from UI subset fonts; run tools/agent_pet_font.py')
    for symbol in ('pet_font_ui_14', 'pet_font_ui_24'):
        generated = (FONTS / f'{symbol}.c').read_text()
        if f'const lv_font_t {symbol} = {{' not in generated:
            problems.append(f'{symbol}.c does not export {symbol}')
    if problems:
        print('\n'.join(problems), file=sys.stderr)
        return 1
    print(f'Chinese UI copy: {len(statuses)} runtime statuses translated; all UI characters covered')
    return 0


if __name__ == '__main__':
    sys.exit(main())
