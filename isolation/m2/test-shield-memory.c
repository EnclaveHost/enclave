#include <assert.h>
#include "shield-memory.h"
int main(void) {
 assert(!shield_memory_fits(0,1));
 assert(!shield_memory_fits(6691*SHIELD_MIB,1));
 assert(!shield_memory_fits(71680*SHIELD_MIB-1,1));
 assert(shield_memory_fits(71680*SHIELD_MIB,1));
 assert(shield_memory_fits(72158*SHIELD_MIB,1));
 assert(shield_memory_fits(8000*SHIELD_MIB,0));
 assert(shield_serve_budget(6691*SHIELD_MIB,1,0)==5667*SHIELD_MIB);
 assert(shield_serve_budget(73600*SHIELD_MIB,1,1)==32768*SHIELD_MIB);
 assert(shield_serve_budget(0,1,0)==1);
}
