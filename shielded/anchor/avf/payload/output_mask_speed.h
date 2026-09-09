#ifndef ASTRA_OUTPUT_MASK_SPEED_H
#define ASTRA_OUTPUT_MASK_SPEED_H
/* Performance probe of the EXISTING input-mask sampler on public inputs.
 * It is not an output-mask protocol implementation or a security test.
 * The caller supplies the exact shipped sh_pad_r symbol, a monotonic clock
 * in microseconds, and its existing line logger. No model or pad state is used.
 */
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>

typedef void (*astra_pad_r_fn)(const uint8_t[32], uint32_t, uint64_t, int64_t, int32_t *);
typedef int64_t (*astra_probe_clock_fn)(void);
typedef void (*astra_probe_line_fn)(const char *);

static int astra_output_mask_speed(astra_pad_r_fn sample,
        astra_probe_clock_fn clock_us, astra_probe_line_fn line) {
    const int64_t widths[] = {5120, 34816, 248320};
    const uint8_t public_seed[32] = {
        0x41,0x53,0x54,0x52,0x41,0x2d,0x50,0x55,
        0x42,0x4c,0x49,0x43,0x2d,0x42,0x45,0x4e,
        0x43,0x48,0x2d,0x4f,0x4e,0x4c,0x59,0x2d,
        0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x31
    };
    if (!sample || !clock_us || !line) return 2;
    int32_t *out = (int32_t *)malloc((size_t)widths[2] * sizeof(*out));
    if (!out) return 2;
    const int64_t global_start = clock_us();
    if (global_start < 0) { free(out); return 2; }
    line("PRG_SPEED begin: existing sh_pad_r; public fixed seed; one calling thread; generation-only; no inference");
    for (uint32_t c = 0; c < 3; c++) {
        const int64_t width = widths[c];
        sample(public_seed, c, 0, width, out); /* one untimed warm-up */
        const int64_t start = clock_us();
        uint64_t calls = 0, checksum = 0;
        int64_t now = start;
        if (start < global_start || start - global_start > 10000000) {
            free(out); return 2;
        }
        do {
            /* Public benchmark indices only, separate from every live session. */
            sample(public_seed, c, calls + 1, width, out);
            checksum += (uint32_t)out[calls % (uint64_t)width];
            calls++;
            now = clock_us();
            if (now < start || now - global_start > 10000000) {
                free(out); return 2;
            }
        } while (calls < 65536 && now - start < 1500000);
        if (now <= start || now - start < 1000000) { free(out); return 2; }
        char msg[384];
        snprintf(msg, sizeof(msg),
            "PRG_SPEED case=%u width=%lld calls=%llu elements=%llu elapsed_us=%lld checksum=%llu",
            c, (long long)width, (unsigned long long)calls,
            (unsigned long long)(calls * (uint64_t)width),
            (long long)(now - start), (unsigned long long)checksum);
        line(msg);
    }
    free(out);
    line("PRG_SPEED end: complete; three cases; output-mask domains and sampling are not implemented");
    return 0;
}
#endif
