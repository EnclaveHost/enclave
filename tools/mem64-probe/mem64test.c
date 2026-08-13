/* mem64test: proves a wasm64 guest addresses >4 GiB of linear memory and
 * that WASI keeps working from buffers past the 4 GiB line (the marshalling
 * shim's whole job). Exit 0 = every check passed. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define GIB (1024ull * 1024 * 1024)

int main(void) {
  /* 6 x 1 GiB: the heap must cross the 4 GiB waterline */
  enum { N = 6 };
  uint8_t *blocks[N];
  uint64_t high = 0;
  for (int i = 0; i < N; i++) {
    blocks[i] = malloc(GIB);
    if (!blocks[i]) {
      printf("FAIL: malloc %d of %d GiB\n", i + 1, N);
      return 1;
    }
    uintptr_t a = (uintptr_t)blocks[i];
    if (a + GIB > high) high = a + GIB;
    /* touch every 4 KiB page with an address-derived pattern */
    for (uint64_t off = 0; off < GIB; off += 4096)
      blocks[i][off] = (uint8_t)((a + off) * 2654435761u >> 24);
    printf("block %d at %p (ends %.2f GiB)\n", i, (void *)blocks[i],
           (double)(a + GIB) / (double)GIB);
  }
  if (high <= 4 * GIB) {
    printf("FAIL: heap never crossed 4 GiB (high=%llu)\n",
           (unsigned long long)high);
    return 1;
  }
  /* verify all patterns (catches aliasing: a truncated 32-bit mapping would
   * fold high pages onto low ones and corrupt the pattern) */
  for (int i = 0; i < N; i++) {
    uintptr_t a = (uintptr_t)blocks[i];
    for (uint64_t off = 0; off < GIB; off += 4096)
      if (blocks[i][off] != (uint8_t)((a + off) * 2654435761u >> 24)) {
        printf("FAIL: pattern mismatch block %d off %llu\n", i,
               (unsigned long long)off);
        return 1;
      }
  }
  printf("verified %d GiB, heap top %.2f GiB\n", N, (double)high / (double)GIB);

  /* WASI from ABOVE the line: find a block past 4 GiB and do real I/O
   * with it — printf of a high string (fd_write via bounce), plus a
   * write+readback through stdio into high memory */
  uint8_t *hb = NULL;
  for (int i = 0; i < N; i++)
    if ((uintptr_t)blocks[i] >= 4 * GIB) { hb = blocks[i]; break; }
  if (!hb) {
    printf("FAIL: no block fully above 4 GiB\n");
    return 1;
  }
  strcpy((char *)hb, "high-buffer I/O ok");
  printf("%s (from %p)\n", (char *)hb, (void *)hb);

  /* file I/O with high buffers in BOTH directions (write staging and read
   * unstaging through the bounce arena): 8 MiB out of high memory, read
   * back into a different high region, compare */
  enum { IOSZ = 8 * 1024 * 1024 };
  uint8_t *src = hb + GIB / 4, *dst = hb + GIB / 2;
  for (uint64_t i = 0; i < IOSZ; i++)
    src[i] = (uint8_t)(i * 131 + 7);
  FILE *f = fopen("/data/mem64test.bin", "wb");
  if (f) {
    if (fwrite(src, 1, IOSZ, f) != IOSZ) {
      printf("FAIL: high fwrite short\n");
      return 1;
    }
    fclose(f);
    f = fopen("/data/mem64test.bin", "rb");
    if (!f || fread(dst, 1, IOSZ, f) != IOSZ) {
      printf("FAIL: high fread short\n");
      return 1;
    }
    fclose(f);
    remove("/data/mem64test.bin");
    if (memcmp(src, dst, IOSZ) != 0) {
      printf("FAIL: high file roundtrip mismatch\n");
      return 1;
    }
    printf("high file I/O roundtrip 8 MiB ok\n");
  } else {
    printf("no /data preopen; skipping high file I/O\n");
  }
  printf("PASS: wasm64 guest addressed %.2f GiB\n", (double)high / (double)GIB);
  return 0;
}
