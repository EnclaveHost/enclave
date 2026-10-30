# Instance binding, device attempt 3 (kept as it is)

STOPPED at A (20:01Z): a PAYLOAD BUG -- the v3 evidence answer ended ']}' + NUL, not ']}\n' (evidence/evidence-001.json, last byte 0x00): the buffer estimate left v3's extra fields one byte short, and snprintf cut the newline. The client refused it as unparseable (fail closed). Fixed in payload/anchor_payload.c (exact sizing; a cut answer is never sent); see ../pvm-cpu-instance-binding/NOTES.md.

The passing run and all four attempts are described in ../pvm-cpu-instance-binding/NOTES.md.
