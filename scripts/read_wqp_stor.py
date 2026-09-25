"""Read WQP_* keys from the extension's LevelDB (snappy-compressed .ldb + .log).

Pure-python minimal reader: table footer -> index block -> data blocks.
Usage: python read_wqp_stor.py [key-substring]
"""
import glob
import json
import os
import struct
import sys

import cramjam

DB_DIR = r"C:\Users\XCrab\AppData\Local\Microsoft\Edge\User Data\Default\Local Extension Settings\ahmcgokancacjhdlkknjfgkfggddlonk"
MAGIC = 0xDB4775248B80FB57


def varint(buf, pos):
    result = 0
    shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def read_block(raw, offset, size):
    body = raw[offset:offset + size]
    btype = raw[offset + size]
    if btype == 0:
        return body
    if btype == 1:
        return bytes(cramjam.snappy.decompress_raw(body))
    raise ValueError(f'unsupported compression {btype}')


def iter_entries(block):
    # restart array lives at the end: [restarts...][uint32 num_restarts]
    num_restarts = struct.unpack('<I', block[-4:])[0]
    restarts_end = len(block) - 4 - 4 * num_restarts
    pos = 0
    key = b''
    while pos < restarts_end:
        shared, pos = varint(block, pos)
        non_shared, pos = varint(block, pos)
        value_len, pos = varint(block, pos)
        key = key[:shared] + block[pos:pos + non_shared]
        pos += non_shared
        value = block[pos:pos + value_len]
        pos += value_len
        yield key, value


def read_table(path):
    raw = open(path, 'rb').read()
    footer = raw[-48:]
    magic = struct.unpack('<Q', footer[-8:])[0]
    if magic != MAGIC:
        return
    pos = 0
    _, pos = varint(footer, pos)  # metaindex offset
    _, pos = varint(footer, pos)  # metaindex size
    idx_off, pos = varint(footer, pos)
    idx_size, pos = varint(footer, pos)
    index = read_block(raw, idx_off, idx_size)
    for _, handle in iter_entries(index):
        hpos = 0
        off, hpos = varint(handle, hpos)
        size, hpos = varint(handle, hpos)
        block = read_block(raw, off, size)
        yield from iter_entries(block)


LOG_BLOCK = 32768


def read_log(path):
    raw = open(path, 'rb').read()
    pos = 0
    pending = b''
    pending_type = 0
    while pos + 7 <= len(raw):
        if (pos % LOG_BLOCK) + 7 > LOG_BLOCK:
            pos += LOG_BLOCK - (pos % LOG_BLOCK)
            continue
        _crc, length, btype = struct.unpack('<IHB', raw[pos:pos + 7])
        pos += 7
        record = raw[pos:pos + length]
        pos += length
        if btype == 1:  # full
            if not pending_type:
                yield from parse_batch(record)
        elif btype == 2:  # first fragment
            pending, pending_type = record, 2
        elif btype == 3:  # middle
            if pending_type in (2, 3):
                pending += record
                pending_type = 3
        elif btype == 4:  # last
            if pending_type in (2, 3):
                pending += record
                yield from parse_batch(pending)
            pending, pending_type = b'', 0


def parse_batch(record):
    if len(record) < 12:
        return
    count = struct.unpack('<I', record[8:12])[0]
    pos = 12
    for _ in range(count):
        etype = record[pos]
        pos += 1
        klen, pos = varint(record, pos)
        key = record[pos:pos + klen]
        pos += klen
        if etype == 0:
            yield key, None
            continue
        vlen, pos = varint(record, pos)
        value = record[pos:pos + vlen]
        pos += vlen
        yield key, value


def main():
    needle = (sys.argv[1] if len(sys.argv) > 1 else 'WQP_').encode()
    found = {}
    # .ldb 先按序号读,活动的 .log 一定最新,放最后覆盖旧值
    files = sorted(glob.glob(os.path.join(DB_DIR, '*.ldb'))) \
        + sorted(glob.glob(os.path.join(DB_DIR, '*.log')))
    for path in files:
        try:
            n = 0
            reader = read_log(path) if path.endswith('.log') else read_table(path)
            for key, value in reader:
                n += 1
                if value is not None and needle in key:
                    found[key.decode('utf-8', 'replace')] = value
            print(f'[{os.path.basename(path)}] {n} entries', file=sys.stderr)
        except Exception as exc:
            print(f'[{os.path.basename(path)}] {exc}', file=sys.stderr)
    for key, value in found.items():
        safe = ''.join(ch if 32 <= ord(ch) < 127 else '#' for ch in key)[:80]
        out = os.path.join(os.path.dirname(__file__), 'extracted', safe)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, 'wb').write(value)
        try:
            parsed = json.loads(value)
            summary = f'json ok, {len(parsed) if hasattr(parsed, "__len__") else "?"} top-level'
        except Exception:
            summary = f'{len(value)} bytes raw'
        print(f'{key[:60]!r}: {summary} -> {os.path.basename(out)}')


if __name__ == '__main__':
    main()
