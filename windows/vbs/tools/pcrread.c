// Read SHA256 PCRs 0-23 through the Windows TPM Base Services API (raw TPM2_PCR_Read).
#include <windows.h>
#include <tbs.h>
#include <stdio.h>
#pragma comment(lib, "tbs.lib")
static int be32(const BYTE* p){ return (p[0]<<24)|(p[1]<<16)|(p[2]<<8)|p[3]; }
int main(void){
    TBS_CONTEXT_PARAMS2 prm = {0}; prm.version = TBS_CONTEXT_VERSION_TWO; prm.includeTpm20 = 1;
    TBS_HCONTEXT h; TBS_RESULT r = Tbsi_Context_Create((PCTBS_CONTEXT_PARAMS)&prm, &h);
    if (r != TBS_SUCCESS) { printf("Tbsi_Context_Create failed 0x%08x\n", r); return 1; }
    for (int bank = 0; bank < 3; bank++) {
        BYTE cmd[20] = {0x80,0x01, 0,0,0,20, 0,0,0x01,0x7E, 0,0,0,1, 0x00,0x0B, 3, 0,0,0};
        cmd[17+bank] = 0xFF;
        BYTE rsp[1024]; UINT32 rlen = sizeof rsp;
        r = Tbsip_Submit_Command(h, TBS_COMMAND_LOCALITY_ZERO, TBS_COMMAND_PRIORITY_NORMAL, cmd, sizeof cmd, rsp, &rlen);
        if (r != TBS_SUCCESS) { printf("submit failed 0x%08x\n", r); return 1; }
        int rc = be32(rsp+6); if (rc) { printf("TPM rc 0x%08x\n", rc); return 1; }
        const BYTE* p = rsp + 10; p += 4;                 // pcrUpdateCounter
        int nsel = be32(p); p += 4;                        // TPML_PCR_SELECTION out
        BYTE selected[3] = {0,0,0};
        for (int i = 0; i < nsel; i++) { int sz = p[2]; if (sz == 3) memcpy(selected, p+3, 3); p += 3 + sz; }
        int ndig = be32(p); p += 4;                        // TPML_DIGEST
        int idx = 0;
        for (int pcr = 0; pcr < 24 && idx < ndig; pcr++) {
            if (!(selected[pcr/8] & (1 << (pcr%8)))) continue;
            int sz = (p[0]<<8)|p[1]; p += 2;
            printf("%d ", pcr); for (int j = 0; j < sz; j++) printf("%02x", p[j]); printf("\n");
            p += sz; idx++;
        }
    }
    Tbsip_Context_Close(h);
    return 0;
}
