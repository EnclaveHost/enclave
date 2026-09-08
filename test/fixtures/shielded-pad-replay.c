#include "../../wasm/ggml-shielded/shielded-wire.c"
#include "../../wasm/ggml-shielded/shielded-tee.c"
#include "../../wasm/ggml-shielded/tweetnacl.h"
#include <assert.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/resource.h>

enum { K = 64, N = 3 };
static int8_t weights[K*N];
typedef struct { uint64_t lo, hi; int rc, calls; } window;
static int give_window(void *opaque, uint64_t want, uint64_t *lo, uint64_t *hi) {
    window *w = opaque; assert(want == 8); w->calls++;
    *lo = w->lo; *hi = w->hi; return w->rc;
}
static int small_window(void *opaque, uint64_t want, uint64_t *lo, uint64_t *hi) {
    uint64_t *mark = opaque; assert(want == 2);
    *lo = *mark; *hi = *mark += want; return SH_OK;
}
static sh_link *link_new(void) {
    int err = 0; sh_link *l = sh_link_open("127.0.0.1", 1, false, &err);
    assert(l && err == 0);
    assert(sh_link_add_weight(l, "test.weight", weights, K, N, 1, -1) == 0);
    return l;
}
static void ledger_write(const char *path, const char *text) {
    FILE *f = fopen(path, "w"); assert(f); assert(fputs(text, f) >= 0); assert(fclose(f) == 0);
}
static int cmp_u64(const void *a, const void *b) {
    const uint64_t x = *(const uint64_t *)a, y = *(const uint64_t *)b;
    return x < y ? -1 : x > y;
}

int main(int argc, char **argv) {
    assert(argc == 2);
    struct rlimit core = {0, 0}; assert(setrlimit(RLIMIT_CORE, &core) == 0);
    for (int i = 0; i < K*N; i++) weights[i] = (int8_t)(i%17-8);
    uint8_t seed[32], sid[16], digest[32], pk[32], sk[32];
    memset(seed, 7, sizeof seed); memset(sid, 8, sizeof sid); memset(digest, 9, sizeof digest);
    crypto_box_keypair(pk, sk);
    char file[1024], last[1024], bad[1024], ledger[1024];
    snprintf(file, sizeof file, "%s/good.pads", argv[1]);
    snprintf(last, sizeof last, "%s/last.pads", argv[1]);
    snprintf(bad, sizeof bad, "%s/invalid.pads", argv[1]);
    snprintf(ledger, sizeof ledger, "%s/ledger", argv[1]);
    sh_link *dealer = link_new();
    assert(sh_link_mint_shipment(dealer, seed, sid, digest, 0, 32, pk, file) == SH_OK);
    assert(sh_link_mint_shipment(dealer, seed, sid, digest, SH_PADS_INDEX_LIMIT-1, 1, pk, last) == SH_OK);
    assert(sh_link_mint_shipment(dealer, seed, sid, digest, SH_PADS_INDEX_LIMIT, 1, pk, bad) == SH_ERR_RANGE);
    assert(sh_link_mint_shipment(dealer, seed, sid, digest, SH_PADS_INDEX_LIMIT-1, 2, pk, bad) == SH_ERR_RANGE);
    assert(sh_link_mint_shipment(dealer, seed, sid, digest, UINT64_MAX, 2, pk, bad) == SH_ERR_RANGE);
    assert(access(bad, F_OK) != 0);
    sh_pads_group table; assert(sh_link_group_table(dealer, &table, 1) == 1);
    int err; table.K = (uint32_t)SH_PADS_K_LIMIT+1;
    assert(!sh_pads_writer_open(bad, digest, sid, &table, 1, 0, 1, pk, &err) && err == SH_ERR_RANGE);
    table.K = K; table.group = SH_PADS_GROUP_LIMIT;
    assert(!sh_pads_writer_open(bad, digest, sid, &table, 1, 0, 1, pk, &err) && err == SH_ERR_RANGE);
    assert(!sh_pads_writer_open(bad, digest, sid, &table, SH_PADS_GROUP_LIMIT, 0, 1, pk, &err) && err == SH_ERR_RANGE);
    assert(access(bad, F_OK) != 0); sh_link_close(dealer);

    char hs[65], hid[33], hsk[65];
    sh_pads_bin2hex(seed, 32, hs); sh_pads_bin2hex(sid, 16, hid); sh_pads_bin2hex(sk, 32, hsk);
    setenv("SHIELDED_PAD_SOURCE", argv[1], 1); setenv("SHIELDED_PAD_SEED", hs, 1);
    setenv("SHIELDED_PAD_SEED_ID", hid, 1); setenv("SHIELDED_PAD_SK", hsk, 1);
    setenv("SHIELDED_PAD_WINDOW", "8", 1); setenv("SHIELDED_PAD_WAIT_MS", "0", 1);
    sh_link *l = link_new(); window w = {0,8,0,0}; sh_link_set_window_provider(l, give_window, &w);
    int32_t r[3*K], u[3*N], ref[K];
    assert(sh_link_dealt_selftest(l, 3, r, u) == 3 && l->win_hi == 8);
    sh_pad_r(seed, 0, 0, K, ref); assert(!memcmp(r, ref, sizeof ref));
    /* The worker can force reconnects; the app can replay a valid old window.
     * The link retains the entire previously reserved range, not just rows
     * consumed, and rejects before writing r/u for any rewound window. */
    memset(r, 0x5a, sizeof r); memset(u, 0x5a, sizeof u);
    assert(sh_link_dealt_selftest(l, 3, r, u) == SH_ERR_VERIFY);
    for (size_t i = 0; i < sizeof r; i++) assert(((uint8_t *)r)[i] == 0x5a);
    for (size_t i = 0; i < sizeof u; i++) assert(((uint8_t *)u)[i] == 0x5a);
    w.lo=7; w.hi=16; assert(sh_link_dealt_selftest(l, 3, r, u) == SH_ERR_VERIFY);
    w.lo=8; w.hi=8; assert(sh_link_dealt_selftest(l, 3, r, u) == SH_ERR_VERIFY);
    w.hi=7; assert(sh_link_dealt_selftest(l, 3, r, u) == SH_ERR_VERIFY);
    w.hi=SH_PADS_INDEX_LIMIT+1; assert(sh_link_dealt_selftest(l, 3, r, u) == SH_ERR_EXHAUST);
    assert(l->win_hi == 8);
    w.hi=16; assert(sh_link_dealt_selftest(l, 3, r, u) == 3);
    sh_pad_r(seed, 0, 8, K, ref); assert(!memcmp(r, ref, sizeof ref));
    w.lo=24; w.hi=32; assert(sh_link_dealt_selftest(l, 3, r, u) == 3);
    sh_pad_r(seed, 0, 24, K, ref); assert(!memcmp(r, ref, sizeof ref));
    sh_link_close(l);
    l=link_new(); sh_link_set_window_provider(l, give_window, &w);
    w.lo=SH_PADS_INDEX_LIMIT-1; w.hi=SH_PADS_INDEX_LIMIT;
    assert(sh_link_dealt_selftest(l, 1, r, u) == 1);
    sh_pad_r(seed, 0, SH_PADS_INDEX_LIMIT-1, K, ref); assert(!memcmp(r, ref, sizeof ref));
    w.lo=SH_PADS_INDEX_LIMIT; w.hi=SH_PADS_INDEX_LIMIT+1;
    assert(sh_link_dealt_selftest(l, 1, r, u) == SH_ERR_EXHAUST); sh_link_close(l);

    /* An eight-row refill must reserve ALL four two-row windows before
     * publishing any pads, including when its first reservation is short. */
    l=link_new(); uint64_t small_mark=0;
    l->pad_window=2; l->refill_batch=8; l->pool_depth=8;
    sh_link_set_window_provider(l, small_window, &small_mark);
    assert(start_pools(l)==SH_OK); stop_threads(l);
    assert(l->groups[0].count==8 && l->groups[0].cursor==8 && l->win_hi==8 && small_mark==8);
    sh_link_close(l);

    /* Direct primitive misuse must abort rather than truncate counter bits. */
    for (int which=0; which<3; which++) {
        pid_t pid=fork(); assert(pid>=0);
        if (!pid) {
            sh_pad_r(seed, which==1 ? SH_PADS_GROUP_LIMIT : 0,
                which==0 ? SH_PADS_INDEX_LIMIT : 0, which==2 ? SH_PADS_K_LIMIT+1 : K, r);
            _exit(0);
        }
        int status; assert(waitpid(pid,&status,0)==pid); assert(WIFSIGNALED(status) && WTERMSIG(status)==SIGABRT);
    }
    uint64_t lo=123,hi=456;
    ledger_write(ledger,"16777215\n");
    assert(sh_pads_window_reserve(ledger,1,&lo,&hi)==SH_OK && lo==SH_PADS_INDEX_LIMIT-1 && hi==SH_PADS_INDEX_LIMIT);
    assert(sh_pads_window_reserve(ledger,1,&lo,&hi)==SH_ERR_EXHAUST);
    const char *invalid[]={"garbage\n","-1\n"," 5\n","5garbage","5\n0","9999999999999999999999999999999",
        "000000000000000000000000000000000000000000000000000000001"};
    for(size_t i=0;i<sizeof invalid/sizeof *invalid;i++) {
        ledger_write(ledger,invalid[i]); lo=123;hi=456;
        assert(sh_pads_window_reserve(ledger,1,&lo,&hi)!=SH_OK && lo==123 && hi==456);
    }
    /* Separate callers sharing one trusted local ledger cannot reserve the
     * same indices. All children start together and return their issuance. */
    enum { CHILDREN=8, PER_CHILD=16 };
    uint64_t *issued=mmap(NULL,CHILDREN*PER_CHILD*sizeof(uint64_t),PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
    assert(issued!=MAP_FAILED); ledger_write(ledger,"0\n");
    int gate[2];assert(pipe(gate)==0);pid_t children[CHILDREN];
    for(int c=0;c<CHILDREN;c++) {
        children[c]=fork();assert(children[c]>=0);
        if(!children[c]) {
            close(gate[1]);char go;assert(read(gate[0],&go,1)==1);close(gate[0]);
            for(int j=0;j<PER_CHILD;j++) {uint64_t a,b;assert(sh_pads_window_reserve(ledger,1,&a,&b)==SH_OK && b==a+1);issued[c*PER_CHILD+j]=a;}
            _exit(0);
        }
    }
    close(gate[0]);assert(write(gate[1],"xxxxxxxx",CHILDREN)==CHILDREN);close(gate[1]);
    for(int c=0;c<CHILDREN;c++){int status;assert(waitpid(children[c],&status,0)==children[c] && WIFEXITED(status) && WEXITSTATUS(status)==0);}
    qsort(issued,CHILDREN*PER_CHILD,sizeof(uint64_t),cmp_u64);
    for(int i=0;i<CHILDREN*PER_CHILD;i++)assert(issued[i]==(uint64_t)i);
    assert(munmap(issued,CHILDREN*PER_CHILD*sizeof(uint64_t))==0);
    puts("pad replay/counter/ledger: ok");return 0;
}
