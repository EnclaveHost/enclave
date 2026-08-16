/*
 * Self-test for enclave_nvenc: proves the encoder works AND that the three
 * settings the spec calls out are actually in the bitstream.
 *
 * Frame counts prove nothing here — an encoder that emits perfectly valid
 * H.264 which Moonlight cannot see reports exactly the same numbers as one
 * that works. So this parses the NALs back out:
 *
 *   1. every keyframe's access unit STARTS with an SPS (repeatSPSPPS)
 *   2. no filler NALs anywhere (enableFillerDataInsertion = 0)
 *   3. a forced IDR mid-stream really is an IDR (NV_ENC_PIC_FLAG_FORCEIDR)
 *
 *   cc -O2 -I. nvenc-selftest.c -L. -lenclave_nvenc -o nvenc-selftest
 *   LD_LIBRARY_PATH=. ./nvenc-selftest [out.h264]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "enclave_nvenc.h"

#define W 1024
#define H 768
#define FRAMES 60
#define FORCE_AT 30

/* A moving pattern, so the encoder has real residual to code and P-frames are
   not trivially empty. */
static void make_frame(uint8_t *nv12, int n) {
    for (int y = 0; y < H; y++)
        for (int x = 0; x < W; x++)
            nv12[y * W + x] = (uint8_t)((x + y + n * 7) ^ (y >> 2));
    memset(nv12 + W * H, 128, (size_t)W * H / 2);
}

/* Walk Annex-B start codes; return the type of the first VCL-or-parameter NAL
   and whether a filler (type 12) appears anywhere. */
static void scan_nals(const uint8_t *b, size_t n, int *first_type, int *has_filler,
                      int *has_idr_slice) {
    *first_type = -1;
    *has_filler = 0;
    *has_idr_slice = 0;
    for (size_t i = 0; i + 3 < n; i++) {
        int sc3 = (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 1);
        int sc4 = (b[i] == 0 && b[i + 1] == 0 && b[i + 2] == 0 && b[i + 3] == 1);
        if (!sc3 && !sc4) continue;
        size_t h = i + (sc4 ? 4 : 3);
        if (h >= n) break;
        int type = b[h] & 0x1f;
        if (*first_type < 0) *first_type = type;
        if (type == 12) *has_filler = 1;
        if (type == 5) *has_idr_slice = 1;
        i = h;
    }
}

int main(int argc, char **argv) {
    uint32_t caps = env_caps();
    printf("caps: 0x%x  h264=%d hevc=%d av1=%d\n", caps, !!(caps & ENV_CAP_H264),
           !!(caps & ENV_CAP_HEVC), !!(caps & ENV_CAP_AV1));
    if (!(caps & ENV_CAP_H264)) {
        printf("FAIL: no h264 encode on this host (%s)\n", env_last_error());
        return 1;
    }

    env_config cfg = {0};
    cfg.codec = "h264";
    cfg.format = "nv12";
    cfg.width = W;
    cfg.height = H;
    cfg.fps_num = 60;
    cfg.fps_den = 1;
    cfg.bitrate = 16000000;
    cfg.gop = 0; /* no automatic IDRs: keyframes only when asked */

    env_session *s = env_open(&cfg);
    if (!s) {
        printf("FAIL: env_open: %s\n", env_last_error());
        return 1;
    }

    uint8_t *frame = malloc((size_t)W * H * 3 / 2);
    uint8_t *out = malloc(4 << 20);
    FILE *f = argc > 1 ? fopen(argv[1], "wb") : NULL;

    int keyframes = 0, filler_seen = 0, bad_key_start = 0, forced_ok = 0;
    size_t total = 0, key_bytes = 0, inter_bytes = 0;

    for (int n = 0; n < FRAMES; n++) {
        make_frame(frame, n);
        int force = (n == FORCE_AT);
        size_t len = 0;
        int key = 0;
        int rc = env_encode(s, frame, (size_t)W * H * 3 / 2, force, out, 4 << 20, &len, &key);
        if (rc != ENV_OK) {
            printf("FAIL: frame %d: rc=%d %s\n", n, rc, env_last_error());
            return 1;
        }
        if (!len) continue;
        total += len;

        int first, filler, idr_slice;
        scan_nals(out, len, &first, &filler, &idr_slice);
        if (filler) filler_seen++;
        if (key) {
            keyframes++;
            key_bytes += len;
            /* 7 = SPS. This is the check that matters: Moonlight looks for an
               access unit beginning with an SPS and ignores everything else. */
            if (first != 7) {
                bad_key_start++;
                printf("  frame %2d: KEYFRAME but the AU starts with NAL type %d, not SPS\n",
                       n, first);
            }
            if (n == FORCE_AT && idr_slice) forced_ok = 1;
            printf("  frame %2d: keyframe %6zu bytes, first NAL type %d%s\n", n, len, first,
                   idr_slice ? " (IDR slice present)" : "");
        } else {
            inter_bytes += len;
        }
        if (f) fwrite(out, 1, len, f);
    }
    if (f) fclose(f);
    env_close(s);
    free(frame);
    free(out);

    printf("\n%d frames, %zu bytes total, %d keyframes\n", FRAMES, total, keyframes);
    if (keyframes) printf("  mean keyframe: %zu bytes\n", key_bytes / keyframes);
    if (FRAMES - keyframes)
        printf("  mean interframe: %zu bytes\n", inter_bytes / (FRAMES - keyframes));

    int fail = 0;
    printf("\n1. every keyframe AU starts with an SPS: %s\n",
           bad_key_start ? (fail = 1, "FAIL") : "ok");
    printf("2. no filler NALs in the stream:          %s\n",
           filler_seen ? (fail = 1, "FAIL") : "ok");
    printf("3. the forced IDR at frame %d is an IDR:  %s\n", FORCE_AT,
           forced_ok ? "ok" : (fail = 1, "FAIL"));
    /* With gop=0 the only keyframes should be frame 0 and the forced one. An
       encoder inserting its own is a bandwidth spike nobody asked for. */
    printf("4. exactly 2 keyframes (0 and forced):    %s (%d)\n",
           keyframes == 2 ? "ok" : (fail = 1, "FAIL"), keyframes);
    return fail;
}
