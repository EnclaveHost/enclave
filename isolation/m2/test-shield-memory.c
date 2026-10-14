#include <assert.h>
#include <limits.h>
#include "shield-memory.h"
int main(void) {
 assert(shield_memory_budget(0,0)==0);
 assert(shield_memory_budget(128*SHIELD_MIB,128*SHIELD_MIB)==0);
 /* Same model may be tried at any allocation with platform headroom. */
 assert(shield_memory_budget(6691*SHIELD_MIB,5000*SHIELD_MIB)>0);
 assert(shield_memory_budget(44053*SHIELD_MIB,42000*SHIELD_MIB)==42000*SHIELD_MIB-44053*SHIELD_MIB/20);
 assert(shield_memory_budget(70000*SHIELD_MIB,200*SHIELD_MIB)==0);
 assert(shield_memory_budget(8000*SHIELD_MIB,9000*SHIELD_MIB)==7600*SHIELD_MIB);
 assert(shield_memory_budget(ULLONG_MAX,ULLONG_MAX)==ULLONG_MAX-ULLONG_MAX/20);
 return 0;
}
