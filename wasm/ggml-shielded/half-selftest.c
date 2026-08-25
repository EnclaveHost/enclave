/* fp32 -> fp16 bits, one value per line, for the numpy comparison in
 * test/shielded-cbackend.test.mjs. */
#include "shielded-field.h"
#include <stdio.h>
int main(void) { double d; while (scanf("%lf", &d) == 1) printf("%u\n", sh_float_to_half((float)d)); return 0; }
