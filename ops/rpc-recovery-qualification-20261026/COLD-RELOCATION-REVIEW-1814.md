# Cold relocation review and first copy, 2026-10-26 18:14 UTC

The first gguf-e2b fresh copy completed and independently verified all78 files/99 entries (43,957,352,504 bytes). Logical digest7f993d7ce3cd294a1d573adc52a16baeb44049911d7780fae4ad6d0035dbc3de matches the unchanged prior source inventory. The original remains a directory; no cutover or reclamation occurred. The copy ran under main512/continuous16GiB floor and a200MiB/s rsync cap. Larger copies are held to yield the main lane to the coordinated native-app recovery task.

Independent r7 review cleared source safety/privacy/device pinning for a FIRST fresh copy, but found defects in retry capacity checks and repairing a failed verification/reinventory. Do not automatically resume r7. Its privileged writer-check handoff also has unsafe chown/bytecode/pinning behavior: DO NOT EXECUTE the r7 sudo helper. r8 fixes are being prepared and require review and tests before use. No privileged helper has been emitted or run. Originals must remain until the fixed privileged check, verified destination, preserved inbound paths and separately reviewed reclamation all pass.

No new NVMe capacity has been reclaimed by this44GB copy. Production chain VM remains off; download continues independently. Administrator controls and live apps are unchanged.
