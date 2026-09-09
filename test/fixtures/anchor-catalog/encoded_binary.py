"""Fixed EWCAT001 serializer; used by the offline publisher prototype."""
import struct


def encode(model, source_catalog, calib, converter, entries):
    if not 0 < len(entries) <= 4096:
        raise ValueError('invalid entry count')
    raw=bytearray(b'EWCAT001'+struct.pack('<6I',len(entries),1<<20,1,32,8,119))
    for d in (model,source_catalog,calib,converter):
        value=bytes.fromhex(d)
        if len(value)!=32:raise ValueError('digest length')
        raw+=value
    raw+=bytes(32)
    if len(raw)!=192:raise ValueError('header length')
    previous=b''
    for e in entries:
        name=bytes.fromhex(e['name_hex'])
        if not 0<len(name)<128 or b'\0' in name or name<=previous:raise ValueError('noncanonical entry name/order')
        previous=name
        fw=bytes.fromhex(e['exponents_le_i32_hex'])
        n=e['ne'][1];size=e['encoded_bytes'];blocks=e['block_sha256']
        if len(fw)!=n*4 or len(blocks)!=(size-1)//(1<<20)+1:raise ValueError('entry arrays mismatch')
        raw+=name.ljust(128,b'\0')
        raw+=struct.pack('<II4Q',e['type'],e['n_dims'],*e['ne'])
        raw+=bytes.fromhex(e['source_tensor_sha256'])
        raw+=struct.pack('<QQQ',size,n,len(blocks))
        raw+=bytes.fromhex(e['encoded_sha256'])
        raw+=fw+b''.join(bytes.fromhex(h) for h in blocks)
    struct.pack_into('<Q',raw,160,len(raw))
    if len(raw)>(64<<20):raise ValueError('catalog cap')
    return bytes(raw)
