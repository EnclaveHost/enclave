#define _GNU_SOURCE
#include "../../wasm/ggml-shielded/shielded-source-profile.h"
int other_profile_probe(void) {
    sh_sp_stamp s=sh_sp_now();SH_SP_END(s,"other",0,0);sh_sp_dump("other");
    return sh_sp_count!=0;
}
