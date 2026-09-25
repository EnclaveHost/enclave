# list an IGVM file's supported platforms (IGVM_VHT_SUPPORTED_PLATFORM, 0x1) and whether it carries a VBS measurement (0x311)
import struct, sys, hashlib
NAMES = {0: "NATIVE", 1: "VSM_ISOLATION", 2: "SEV_SNP", 3: "TDX", 4: "SEV", 5: "SEV_ES"}
for p in sys.argv[1:]:
    b = open(p, "rb").read()
    magic, ver, voff, vsz, total, _ = struct.unpack_from("<IIIIII", b, 0)
    assert magic == 0x4D564749, p
    o, end, plats, counts = voff, voff + vsz, [], {}
    while o + 8 <= end:
        t, l = struct.unpack_from("<II", b, o)
        counts[t] = counts.get(t, 0) + 1
        if t == 0x1:
            mask, vtl, pt, pv, sgb = struct.unpack_from("<IBBHQ", b, o + 8)
            plats.append(f"{NAMES.get(pt, pt)}(mask={mask:#x},highest_vtl={vtl},ver={pv},shared_gpa_boundary={sgb:#x})")
        o += 8 + ((l + 7) & ~7)
    print(f"{hashlib.sha256(b).hexdigest()[:8]} {p.split('/')[-1]}: v{ver} platforms={plats} vbs_measurement_headers={counts.get(0x311, 0)}")
