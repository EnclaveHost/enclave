/* Benchmark aliases use the same implementation selected by production. */
#include "shielded-pad-r4.h"
#define astra_chacha4 sh_chacha20_four_blocks
#define astra_pad_r4 sh_pad_r_four_blocks
