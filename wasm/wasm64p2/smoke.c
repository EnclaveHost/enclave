/* Image smoke test: a heap past the 4 GiB line, touched page by page.
 * Built through the whole chain at image build; the structural check on the
 * output is classify.py. The RUNTIME proof (6 GiB + WASI from high buffers,
 * tools/mem64-probe/mem64test.c on the pinned engine) is in docs/wasm64.md. */
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  size_t n = 5ull << 30;
  unsigned char *p = malloc(n);
  if (!p) { printf("malloc failed\n"); return 1; }
  for (size_t off = 0; off < n; off += 4096) p[off] = (unsigned char)(off >> 12);
  printf("sizeof(void*)=%zu, %zu GiB touched\n", sizeof(void *), n >> 30);
  return 0;
}
