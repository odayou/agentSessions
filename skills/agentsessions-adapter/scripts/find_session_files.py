#!/usr/bin/env python3
"""按关键字/ID 在数据目录里定位会话文件（只读，跳过运行时大文件与依赖目录）。"""
import argparse
import os
import stat
import sys

DEFAULT_ROOTS = [
    '~/AppData/Local',
    '~/AppData/Roaming',
    '~/Library/Application Support',
    '~/.config',
    '~/Doubao',
]
SKIP_DIRS = {
    'node_modules', '.git', 'target', 'dist', 'build', '.venv', 'venv',
    '__pycache__', 'bases', 'downloads', 'sandbox_runtime', '.cache',
    'Application Data', 'Temporary Internet Files', 'History', 'Cache',
    'Cache_Data', 'Code Cache', 'GPUCache', 'Crashpad', 'prepared_packages',
    'sandbox_envs_dir', 'EBWebView',
}
PREFERRED_EXT = ('.jsonl', '.json', '.md', '.db', '.sqlite')


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--keyword', action='append', default=[], help='待搜索的关键字，可重复（任一命中即输出）')
    p.add_argument('--roots', nargs='*', help='覆盖默认搜索根目录')
    p.add_argument('--max-mb', type=float, default=30, help='跳过超过该体积的文件（默认 30MB）')
    p.add_argument('--limit', type=int, default=50, help='最多输出命中数（默认 50）')
    p.add_argument('--ext', default='', help='仅搜这些扩展名，逗号分隔，如 .jsonl,.json')
    return p.parse_args()


def is_reparse(path):
    try:
        st = os.stat(path, follow_symlinks=False)
        return bool(getattr(st, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)
    except (OSError, AttributeError):
        return False


def snippet(data, needle):
    i = data.find(needle)
    if i < 0:
        return ''
    start = max(0, i - 60)
    return data[start:i + len(needle) + 120].decode('utf-8', errors='replace').replace('\r', ' ').replace('\n', ' ')


def priority(fp, size):
    norm = fp.replace('\\', '/').lower()
    session_hint = 0 if ('.sessions/' in norm or 'coding/snapshot/' in norm) else 1
    fmt_hint = 0 if norm.endswith(PREFERRED_EXT) else 1
    return (session_hint, fmt_hint, size)


def main():
    args = parse_args()
    if not args.keyword:
        sys.exit('至少需要 --keyword')
    needles = [k.encode('utf-8') for k in args.keyword if k]
    exts = tuple(x.strip().lower() for x in args.ext.split(',') if x.strip())
    roots = [(os.path.expanduser(r) if r.startswith('~') else r) for r in (args.roots or DEFAULT_ROOTS)]
    max_bytes = int(args.max_mb * 1024 * 1024)
    hits = []
    scanned = 0
    cap = max(args.limit * 10, 200)
    for root in roots:
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not is_reparse(os.path.join(dirpath, d))]
            for name in filenames:
                fp = os.path.join(dirpath, name)
                try:
                    if exts and not name.lower().endswith(exts):
                        continue
                    size = os.path.getsize(fp)
                    if size > max_bytes:
                        continue
                    with open(fp, 'rb') as fh:
                        data = fh.read()
                except OSError:
                    continue
                scanned += 1
                matched = next((n for n in needles if n in data), None)
                if not matched:
                    continue
                hits.append((fp, size, snippet(data, matched)))
                if len(hits) >= cap:
                    break
            if len(hits) >= cap:
                break
        if len(hits) >= cap:
            break
    hits.sort(key=lambda h: priority(h[0], h[1]))
    for fp, size, text in hits[:args.limit]:
        print(f'{size}B  {fp}')
        print(f'    ...{text}...')
    print(f'扫描 {scanned} 个文件，命中 {len(hits)} 个，输出 {min(len(hits), args.limit)} 个')


if __name__ == '__main__':
    main()
