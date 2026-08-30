#!/usr/bin/env python3
"""
hivepatch.py -- minimal Windows registry hive reader/patcher.

Exists because this host has no chntpw/hivex and installing packages on a
production box to fix a USB boot is the wrong trade. Scope is deliberately tiny:
navigate to a key, list or read its values, and optionally overwrite a REG_DWORD
IN PLACE.

In-place only. A DWORD whose data is <= 4 bytes is stored inline inside the vk
record (data_size has bit 31 set, data lives in the data_offset field), so
changing one rewrites exactly 4 bytes and never reallocates a cell. That is what
makes this safe to write from scratch: no free-list handling, no cell resizing,
no hbin growth -- the parts of the format that are genuinely hard.

Format reference: regf header is 4096 bytes; all cell offsets are relative to
0x1000. Cells carry a signed int32 size, negative meaning allocated.
"""
import struct, sys

BASE = 0x1000


class Hive:
    def __init__(self, path):
        self.path = path
        with open(path, 'rb') as f:
            self.d = bytearray(f.read())
        if self.d[:4] != b'regf':
            raise ValueError(f'{path}: not a registry hive (bad magic)')
        self.root = struct.unpack_from('<I', self.d, 0x24)[0]

    # --- cell helpers ------------------------------------------------------
    def cell(self, off):
        """Return (data_offset, size) for the cell at hive-relative `off`."""
        abs_off = BASE + off
        size = struct.unpack_from('<i', self.d, abs_off)[0]
        return abs_off + 4, abs(size) - 4

    def u32(self, at):
        return struct.unpack_from('<I', self.d, at)[0]

    def u16(self, at):
        return struct.unpack_from('<H', self.d, at)[0]

    # --- key traversal -----------------------------------------------------
    def nk_name(self, nk):
        n = self.u16(nk + 72)
        raw = bytes(self.d[nk + 76: nk + 76 + n])
        flags = self.u16(nk + 2)
        return raw.decode('latin-1' if flags & 0x20 else 'utf-16-le', 'replace')

    def subkey_offsets(self, nk):
        count = self.u32(nk + 20)
        lst = self.u32(nk + 28)
        if count == 0 or lst == 0xFFFFFFFF:
            return []
        return self._list_offsets(lst)

    def _list_offsets(self, lst):
        base, _ = self.cell(lst)
        sig = bytes(self.d[base:base + 2])
        n = self.u16(base + 2)
        out = []
        if sig in (b'lf', b'lh'):
            for i in range(n):
                out.append(self.u32(base + 4 + i * 8))
        elif sig == b'li':
            for i in range(n):
                out.append(self.u32(base + 4 + i * 4))
        elif sig == b'ri':
            for i in range(n):
                out.extend(self._list_offsets(self.u32(base + 4 + i * 4)))
        else:
            raise ValueError(f'unknown subkey list signature {sig!r}')
        return out

    def find_key(self, path):
        """Walk a backslash-separated path from the root key."""
        nk, _ = self.cell(self.root)
        if bytes(self.d[nk:nk + 2]) != b'nk':
            raise ValueError('root cell is not an nk record')
        for part in [p for p in path.split('\\') if p]:
            for off in self.subkey_offsets(nk):
                child, _ = self.cell(off)
                if bytes(self.d[child:child + 2]) != b'nk':
                    continue
                if self.nk_name(child).lower() == part.lower():
                    nk = child
                    break
            else:
                return None
        return nk

    # --- values ------------------------------------------------------------
    def find_value(self, nk, name):
        count = self.u32(nk + 36)
        lst = self.u32(nk + 40)
        if count == 0 or lst == 0xFFFFFFFF:
            return None
        base, _ = self.cell(lst)
        for i in range(count):
            vk, _ = self.cell(self.u32(base + i * 4))
            if bytes(self.d[vk:vk + 2]) != b'vk':
                continue
            nlen = self.u16(vk + 2)
            flags = self.u16(vk + 16)
            raw = bytes(self.d[vk + 20: vk + 20 + nlen])
            vname = raw.decode('latin-1' if flags & 1 else 'utf-16-le', 'replace')
            if vname.lower() == name.lower():
                return vk
        return None

    TYPES = {0: 'REG_NONE', 1: 'REG_SZ', 2: 'REG_EXPAND_SZ', 3: 'REG_BINARY',
             4: 'REG_DWORD', 5: 'REG_DWORD_BE', 7: 'REG_MULTI_SZ',
             11: 'REG_QWORD'}

    def value_names(self, nk):
        count = self.u32(nk + 36)
        lst = self.u32(nk + 40)
        if count == 0 or lst == 0xFFFFFFFF:
            return []
        base, _ = self.cell(lst)
        out = []
        for i in range(count):
            vk, _ = self.cell(self.u32(base + i * 4))
            if bytes(self.d[vk:vk + 2]) != b'vk':
                continue
            nlen = self.u16(vk + 2)
            flags = self.u16(vk + 16)
            raw = bytes(self.d[vk + 20: vk + 20 + nlen])
            out.append((raw.decode('latin-1' if flags & 1 else 'utf-16-le', 'replace'), vk))
        return out

    def read_value(self, vk):
        """Return (type_name, python value) for any vk record."""
        size = self.u32(vk + 4)
        off = self.u32(vk + 8)
        vtype = self.u32(vk + 12)
        tname = self.TYPES.get(vtype, f'type{vtype}')
        if size & 0x80000000:
            n = size & 0x7FFFFFFF
            raw = bytes(self.d[vk + 8: vk + 8 + min(n, 4)])
        else:
            if size > 16344:
                return tname, '<big data, not supported>'
            start, _ = self.cell(off)
            raw = bytes(self.d[start:start + size])
        if vtype in (1, 2):
            return tname, raw.decode('utf-16-le', 'replace').rstrip('\x00')
        if vtype == 7:
            return tname, raw.decode('utf-16-le', 'replace').rstrip('\x00').split('\x00')
        if vtype == 4 and len(raw) >= 4:
            return tname, struct.unpack_from('<I', raw)[0]
        if vtype == 11 and len(raw) >= 8:
            return tname, struct.unpack_from('<Q', raw)[0]
        return tname, raw.hex()

    def read_dword(self, vk):
        size = self.u32(vk + 4)
        if not (size & 0x80000000):
            return None          # not inline; out of scope for this tool
        return self.u32(vk + 8)

    def write_dword(self, vk, value):
        size = self.u32(vk + 4)
        if not (size & 0x80000000) or (size & 0x7FFFFFFF) > 4:
            raise ValueError('value is not an inline DWORD; refusing to patch')
        struct.pack_into('<I', self.d, vk + 8, value)

    def save(self):
        with open(self.path, 'r+b') as f:
            f.write(self.d)


def main():
    if len(sys.argv) < 4:
        print('usage: hivepatch.py <hive> get|set|dump <KeyPath> [<Value>] [newdword]')
        return 2
    hive_path, op, keypath = sys.argv[1:4]
    h = Hive(hive_path)
    nk = h.find_key(keypath)
    if nk is None:
        print(f'  {keypath}: KEY NOT FOUND')
        return 1

    if op == 'dump':
        print(f'  [{keypath}]')
        for name, vk in h.value_names(nk):
            tname, val = h.read_value(vk)
            print(f'    {name or "(Default)":<28} {tname:<14} {val!r}')
        subs = [h.nk_name(h.cell(o)[0]) for o in h.subkey_offsets(nk)]
        if subs:
            print(f'    subkeys: {", ".join(sorted(subs))}')
        return 0

    if len(sys.argv) < 5:
        print('usage: hivepatch.py <hive> get|set <KeyPath> <Value> [newdword]')
        return 2
    valname = sys.argv[4]
    vk = h.find_value(nk, valname)
    if vk is None:
        print(f'  {keypath}\\{valname}: VALUE NOT FOUND')
        return 1
    cur = h.read_dword(vk)
    if op == 'get':
        print(f'  {keypath}\\{valname} = {cur}')
        return 0
    new = int(sys.argv[5])
    if cur == new:
        print(f'  {keypath}\\{valname} already {new}')
        return 0
    h.write_dword(vk, new)
    h.save()
    print(f'  {keypath}\\{valname}: {cur} -> {new}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
