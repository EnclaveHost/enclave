/* modelvol.h - the deployment's MODEL VOLUMES in the per-app guest's init (dominit.c includes this after insmod()).
 *
 * The shared runtime (wasm/wasm_manager.py) mounts each attached model volume read-only at /models/<name>, lists the
 * names in ENCLAVE_MODELS, gives wasi-nn to the tenant and preloads ggml graphs from a staged per-volume dir, smallest
 * first, never past the tenant's memory, naming what it preloaded in ENCLAVE_NN_PRELOADS. This is that, inside a
 * measured guest whose host is not trusted with the weights' identity:
 *   - which volumes: the front, from the deployment's config (the catalog's "volumes" names), sends one "M1" block;
 *   - what each IS: this image's own measured table (MV_TABLE, rt/model-volumes.table, pinned at release build) gives
 *     its dm-verity root, salt and geometry. A name not in the table is refused, so the host decides nothing about
 *     identity;
 *   - where its bytes are: a host-attached read-only virtio disk whose serial is "mv" + the root's first 18 hex digits
 *     (the host cannot misdirect a volume to another slot without the verity mount failing);
 *   - every block the app reads is verified against the pinned root (mverity.h), and the ext4 mount is read-only,
 *     nodev, nosuid and noexec.
 * Any failure powers the domain off before the app starts: an app deployed around a model never runs without it, the
 * standard runtime's rule for volumes that are not attached. */
#include <dirent.h>
#include <strings.h>
#include <sys/mount.h>
#ifndef MV_NO_MOUNT
#include "mverity.h"
#endif

#ifndef MV_TABLE
#define MV_TABLE "/rt/model-volumes.table"     /* the measured pinned table */
#endif
#ifndef MV_ROOT
#define MV_ROOT "/models"                      /* where volumes mount (wasm_manager VOL_GUEST_ROOT) */
#endif
#ifndef MV_SYS_BLOCK
#define MV_SYS_BLOCK "/sys/block"
#endif
#ifndef MV_DEV
#define MV_DEV "/dev"
#endif
#ifndef MV_NN_MARKER
#define MV_NN_MARKER "/rt/nn-ggml.enabled"     /* the runtime's measured probe: wasi-nn with the ggml CPU backend */
#endif
#ifndef MV_STAGE
#define MV_STAGE "/tmp/nn-graph"               /* staged graph dirs (wasm_manager _stage_nn_graph) */
#endif
#ifndef MV_BACKEND_DIR
#define MV_BACKEND_DIR "/rt/backends"           /* the runtime's ggml backends (ENCLAVE_GGML_BACKEND_DIR) */
#endif
#define MV_MAX 8
#define MV_RESERVE_MIB 256ULL                  /* kept for the runtime and the app beside preloaded weights */

struct mv_entry {
    char name[65], root[65], salt[257], preload[8], graph[241], serial[21];
    unsigned long long dbs, hbs, dblocks, hstart, image_bytes, staged_bytes;
    int preloaded;
};
static int mv_n;
static struct mv_entry mv[MV_MAX];
static int mv_nn;                                              /* the runtime has wasi-nn + ggml (MV_NN_MARKER) */
static char mv_dir_args[MV_MAX][300];                          /* "/models/<name>::/models/<name>" */
static char mv_graph_args[MV_MAX][320];                        /* "nn-graph=ggml::/tmp/nn-graph/<name>" */
static char mv_env_models[16 + MV_MAX * 66];                   /* ENCLAVE_MODELS=a,b */
static char mv_env_preloads[24 + MV_MAX * 66];                 /* ENCLAVE_NN_PRELOADS=a */
static char mv_env_serve[64];                                  /* ENCLAVE_NN_SERVE_BYTES=<budget> */

static int mv_name_ok(const char *v, size_t n) {   /* ^[a-z0-9][a-z0-9._-]{0,63}$ (_VOL_NAME_RE) */
    if (n < 1 || n > 64) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = v[i];
        int alnum = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
        if (!alnum && (i == 0 || (c != '.' && c != '_' && c != '-'))) return 0;
    }
    return 1;
}
static int mv_hex(const char *v, size_t min, size_t max) {
    size_t n = strlen(v);
    if (n < min || n > max) return 0;
    for (size_t i = 0; i < n; i++) if (!((v[i] >= '0' && v[i] <= '9') || (v[i] >= 'a' && v[i] <= 'f'))) return 0;
    return 1;
}
static int mv_graph_ok(const char *g) {   /* a relative path of plain segments */
    size_t n = strlen(g), seg = 0;
    if (n < 1 || n > 240 || g[0] == '/') return 0;
    for (size_t i = 0; i <= n; i++) {
        if (i == n || g[i] == '/') {
            if (seg == 0 || (seg == 1 && g[i - 1] == '.') || (seg == 2 && g[i - 1] == '.' && g[i - 2] == '.')) return 0;
            seg = 0;
            continue;
        }
        char c = g[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' || c == '+')) return 0;
        seg++;
    }
    return 1;
}

/* "M1\n" then 1..8 "vol=<name>\n", nothing else, no name twice. */
static const char *model_block(const char *t, size_t n) {
    mv_n = 0;
    if (n < 3 || memcmp(t, "M1\n", 3) != 0) return "sent a model-volume block that is not M1";
    for (size_t i = 3; i < n;) {
        const char *nl = memchr(t + i, '\n', n - i);
        if (!nl) return "sent a model-volume block with an unterminated line";
        const char *l = t + i;
        size_t ll = (size_t)(nl - l);
        if (ll <= 4 || memcmp(l, "vol=", 4) != 0) return "sent a model-volume block with an unexpected line";
        if (mv_n >= MV_MAX || !mv_name_ok(l + 4, ll - 4)) return "sent a bad or excess model volume name";
        for (int k = 0; k < mv_n; k++) if (strlen(mv[k].name) == ll - 4 && memcmp(mv[k].name, l + 4, ll - 4) == 0)
            return "sent a duplicate model volume name";
        memset(&mv[mv_n], 0, sizeof mv[mv_n]);
        memcpy(mv[mv_n].name, l + 4, ll - 4);
        mv_n++;
        i += ll + 1;
    }
    if (mv_n == 0) return "sent an empty model-volume block";
    return NULL;
}

static int mv_num(const char *s, unsigned long long *out) {
    if (!*s || *s == '0' || strlen(s) > 16) return 0;
    unsigned long long v = 0;
    for (const char *p = s; *p; p++) { if (*p < '0' || *p > '9') return 0; v = v * 10 + (unsigned)(*p - '0'); }
    *out = v;
    return 1;
}

/* Every requested name, looked up in this image's measured table (sdk/storage/model-volumes.mjs tableLine):
 *   name root salt dataBS hashBS dataBlocks hashStartBlock imageBytes preload graph pin */
static const char *mv_table(void) {
    FILE *f = fopen(MV_TABLE, "r");
    if (!f) return "this image carries no model-volume table: it cannot mount the deployment's model volumes";
    char line[1024];
    int found = 0;
    while (fgets(line, sizeof line, f)) {
        size_t ll = strlen(line);
        if (ll == 0 || line[ll - 1] != '\n') { fclose(f); return "the model-volume table is malformed"; }
        line[ll - 1] = 0;
        char *fld[12]; int nf = 0;
        for (char *save = NULL, *p = strtok_r(line, " ", &save); p && nf < 12; p = strtok_r(NULL, " ", &save)) fld[nf++] = p;
        if (nf != 11) { fclose(f); return "the model-volume table is malformed"; }
        for (int k = 0; k < mv_n; k++) {
            if (strcmp(fld[0], mv[k].name)) continue;
            struct mv_entry *e = &mv[k];
            if (e->root[0]) { fclose(f); return "the model-volume table names a volume twice"; }
            if (!mv_hex(fld[1], 64, 64) || !mv_hex(fld[2], 2, 256) || strlen(fld[2]) % 2 || !mv_num(fld[3], &e->dbs) || e->dbs != 4096 ||
                !mv_num(fld[4], &e->hbs) || e->hbs != 4096 || !mv_num(fld[5], &e->dblocks) || !mv_num(fld[6], &e->hstart) ||
                e->hstart <= e->dblocks || !mv_num(fld[7], &e->image_bytes) || e->image_bytes <= e->hstart * 4096 ||
                (strcmp(fld[8], "ggml") && strcmp(fld[8], "sd") && strcmp(fld[8], "none")) ||
                (!strcmp(fld[8], "none") != !strcmp(fld[9], "-")) || (strcmp(fld[9], "-") && !mv_graph_ok(fld[9])) ||
                !mv_hex(fld[10], 64, 64)) { fclose(f); return "the model-volume table has a malformed entry"; }
            snprintf(e->root, sizeof e->root, "%s", fld[1]);
            snprintf(e->salt, sizeof e->salt, "%s", fld[2]);
            snprintf(e->preload, sizeof e->preload, "%s", fld[8]);
            snprintf(e->graph, sizeof e->graph, "%s", fld[9]);
            snprintf(e->serial, sizeof e->serial, "mv%.18s", e->root);
            found++;
        }
    }
    fclose(f);
    if (found != mv_n) return "the deployment names a model volume this image's measured table does not carry";
    return NULL;
}

#ifndef MV_NO_MOUNT
/* the virtio disk whose serial is e->serial -> path[len], or 0 */
static int mv_find_disk(const struct mv_entry *e, char *path, size_t len) {
    DIR *d = opendir(MV_SYS_BLOCK);
    if (!d) return 0;
    struct dirent *de;
    int hit = 0;
    while (!hit && (de = readdir(d))) {
        if (strncmp(de->d_name, "vd", 2)) continue;
        char p[300], s[64] = {0};
        snprintf(p, sizeof p, MV_SYS_BLOCK "/%.64s/serial", de->d_name);
        FILE *f = fopen(p, "r");
        if (!f) continue;
        if (fgets(s, sizeof s, f)) {
            s[strcspn(s, "\n")] = 0;
            if (!strcmp(s, e->serial)) { snprintf(path, len, MV_DEV "/%.64s", de->d_name); hit = 1; }
        }
        fclose(f);
    }
    closedir(d);
    return hit;
}

/* load the device-mapper modules (the template carries them beside vsock's), then bring each volume up and mount it */
static const char *mv_mount_all(char *who, size_t wlen) {
    if (!mv_n) return NULL;
    insmod("/dm-mod.ko.zst");
    insmod("/dm-bufio.ko.zst");
    insmod("/reed_solomon.ko.zst");
    insmod("/dm-verity.ko.zst");
    mkdir(MV_ROOT, 0755);
    for (int k = 0; k < mv_n; k++) {
        struct mv_entry *e = &mv[k];
        snprintf(who, wlen, "%s", e->name);
        char disk[128], node[160], mapname[80], at[200];
        int tries = 0;
        while (!mv_find_disk(e, disk, sizeof disk)) {   /* virtio disks can appear after init starts */
            if (++tries > 50) return "its disk is not attached (no virtio disk with its serial)";
            usleep(100000);
        }
        snprintf(mapname, sizeof mapname, "mv-%.64s", e->name);
        const char *why = mverity_setup(mapname, disk, e->dbs, e->hbs, e->dblocks, e->hstart, "sha256", e->root, e->salt, node, sizeof node);
        if (why) return why;
        snprintf(at, sizeof at, MV_ROOT "/%.64s", e->name);
        if (mkdir(at, 0755) != 0 && errno != EEXIST) return "mkdir its mount point";
        /* a wrong image under a right serial fails here: ext4 reads its superblock through the verity device */
        if (mount(node, at, "ext4", MS_RDONLY | MS_NODEV | MS_NOSUID | MS_NOEXEC, "") != 0) return "mount (read-only ext4 over dm-verity)";
        snprintf(mv_dir_args[k], sizeof mv_dir_args[k], MV_ROOT "/%s::/models/%s", e->name, e->name);
    }
    return NULL;
}
#endif

/* volumes another component verified and mounted (the Windows partition's monitor binds each read-only at
 * MV_ROOT/<name> in the domain, m3/monitor/modelvol.go): each must be there, as a directory */
static const char *mv_dirs(void) {
    for (int k = 0; k < mv_n; k++) {
        char at[200];
        struct stat st;
        snprintf(at, sizeof at, MV_ROOT "/%s", mv[k].name);
        if (lstat(at, &st) != 0 || !S_ISDIR(st.st_mode)) return "a model volume is not mounted in this domain";
        snprintf(mv_dir_args[k], sizeof mv_dir_args[k], MV_ROOT "/%s::/models/%s", mv[k].name, mv[k].name);
    }
    return NULL;
}

static unsigned long long mv_size(const char *p) { struct stat st; return stat(p, &st) == 0 && S_ISREG(st.st_mode) ? (unsigned long long)st.st_size : 0; }

/* <dir>/<name> -> <stage>/<as>, adding its size to *bytes; -> 0 on failure */
static int mv_link(const char *target, const char *stage, const char *as, unsigned long long *bytes) {
    char l[600];
    snprintf(l, sizeof l, "%s/%s", stage, as);
    unsigned long long s = mv_size(target);
    if (!s || symlink(target, l) != 0) return 0;
    *bytes += s;
    return 1;
}

/* wasm_manager _stage_nn_graph: a dir named after the VOLUME, holding model.gguf -> the graph file, or every part of a
 * split family under its real name, plus any *mmproj*.gguf projector beside it under its real name. -> 0 = no stage */
static int mv_stage(struct mv_entry *e) {
    char stage[200], gdir[600], target[900];
    snprintf(stage, sizeof stage, MV_STAGE "/%.64s", e->name);
    mkdir(MV_STAGE, 0755);
    if (mkdir(stage, 0755) != 0) return 0;
    const char *slash = strrchr(e->graph, '/');
    const char *base = slash ? slash + 1 : e->graph;
    if (slash) snprintf(gdir, sizeof gdir, MV_ROOT "/%s/%.*s", e->name, (int)(slash - e->graph), e->graph);
    else snprintf(gdir, sizeof gdir, MV_ROOT "/%s", e->name);
    size_t bl = strlen(base);
    /* a split part: <stem>-NNNNN-of-MMMMM.gguf (llama.cpp derives the siblings from part 1's name) */
    const char *of = bl > 20 ? strstr(base, "-of-") : NULL;
    int split = of && bl > 5 && !strcasecmp(base + bl - 5, ".gguf") && of - base > 6 && of[-6] == '-';
    DIR *d = opendir(gdir);
    if (!d) return 0;
    struct dirent *de;
    int ok = 1;
    if (!split) {
        snprintf(target, sizeof target, "%s/%s", gdir, base);
        ok = mv_link(target, stage, "model.gguf", &e->staged_bytes);
    }
    while (ok && (de = readdir(d))) {
        size_t nl = strlen(de->d_name);
        if (nl <= 5 || strcasecmp(de->d_name + nl - 5, ".gguf")) continue;
        int mmproj = 0;
        for (size_t i = 0; i + 6 <= nl; i++) if (!strncasecmp(de->d_name + i, "mmproj", 6)) mmproj = 1;
        int part = 0;
        if (split && !mmproj && nl == bl) {
            size_t stem = (size_t)(of - base) - 6;
            part = !strncmp(de->d_name, base, stem) && !strcmp(de->d_name + stem + 6, of);
        }
        if (!mmproj && !part) continue;
        snprintf(target, sizeof target, "%s/%s", gdir, de->d_name);
        ok = mv_link(target, stage, de->d_name, &e->staged_bytes);
    }
    closedir(d);
    return ok && e->staged_bytes > 0;
}

/* Preload the ggml volumes the runtime can serve, smallest first, never past the guest's memory (wasm_manager: the
 * emission STOPS at the tenant's budget; over-budget volumes stay mounted and listed, just not preloaded). */
static void mv_preloads(unsigned long long mem_bytes) {
    mv_nn = access(MV_NN_MARKER, F_OK) == 0;
    unsigned long long budget = mem_bytes > (MV_RESERVE_MIB << 20) ? mem_bytes - (MV_RESERVE_MIB << 20) : 0, used = 0;
    snprintf(mv_env_serve, sizeof mv_env_serve, "ENCLAVE_NN_SERVE_BYTES=%llu", budget);
    size_t o = (size_t)snprintf(mv_env_models, sizeof mv_env_models, "ENCLAVE_MODELS=");
    for (int k = 0; k < mv_n; k++) o += (size_t)snprintf(mv_env_models + o, sizeof mv_env_models - o, "%s%s", k ? "," : "", mv[k].name);
    snprintf(mv_env_preloads, sizeof mv_env_preloads, "ENCLAVE_NN_PRELOADS=");
    if (!mv_nn) {
        if (mv_n) printf("DOM model volumes: %d mounted; this runtime has no ggml preload, so none is preloaded\n", mv_n);
        return;
    }
    int order[MV_MAX], m = 0;
    for (int k = 0; k < mv_n; k++) {
        if (strcmp(mv[k].preload, "ggml")) continue;
        if (!mv_stage(&mv[k])) { printf("DOM model volume %s: no preloadable graph staged; mounted only\n", mv[k].name); continue; }
        order[m++] = k;
    }
    for (int i = 1; i < m; i++)   /* smallest first */
        for (int j = i; j > 0 && mv[order[j]].staged_bytes < mv[order[j - 1]].staged_bytes; j--) { int t = order[j]; order[j] = order[j - 1]; order[j - 1] = t; }
    size_t po = strlen(mv_env_preloads);
    for (int i = 0; i < m; i++) {
        struct mv_entry *e = &mv[order[i]];
        if (used + e->staged_bytes > budget) {
            printf("DOM model volume %s: %llu MiB of weights would pass the guest's %llu MiB budget; mounted only\n", e->name,
                   e->staged_bytes >> 20, budget >> 20);
            continue;
        }
        used += e->staged_bytes;
        e->preloaded = 1;
        snprintf(mv_graph_args[order[i]], sizeof mv_graph_args[order[i]], "nn-graph=ggml::" MV_STAGE "/%s", e->name);
        po += (size_t)snprintf(mv_env_preloads + po, sizeof mv_env_preloads - po, "%s%s", po > sizeof "ENCLAVE_NN_PRELOADS=" - 1 ? "," : "", e->name);
    }
}

/* argv before /app.wasm: -S nn when the runtime has it (the shared runtime gives wasi-nn to every tenant), then each
 * preloaded graph smallest first, each volume's read-only preopen and the env names (values ride the environment) */
static int mv_argv(char **app, int k) {
    if (mv_nn) {
        app[k++] = "-S"; app[k++] = "nn";
        int idx[MV_MAX], m = 0;
        for (int i = 0; i < mv_n; i++) if (mv[i].preloaded) idx[m++] = i;
        for (int i = 1; i < m; i++)
            for (int j = i; j > 0 && mv[idx[j]].staged_bytes < mv[idx[j - 1]].staged_bytes; j--) { int t = idx[j]; idx[j] = idx[j - 1]; idx[j - 1] = t; }
        for (int i = 0; i < m; i++) { app[k++] = "-S"; app[k++] = mv_graph_args[idx[i]]; }
    }
    for (int i = 0; i < mv_n; i++) { app[k++] = "--dir"; app[k++] = mv_dir_args[i]; }
    if (mv_n) { app[k++] = "--env"; app[k++] = "ENCLAVE_MODELS"; }
    if (mv_nn) {
        app[k++] = "--env"; app[k++] = "ENCLAVE_NN_PRELOADS";
        app[k++] = "--env"; app[k++] = "ENCLAVE_NN_SERVE_BYTES";
        app[k++] = "--env"; app[k++] = "ENCLAVE_NN_SERVE_KIND";
    }
    return k;
}

/* the runtime process's environment: the values the --env names above read, and the ggml CPU backend */
static int mv_env(char **envp, int ei) {
    if (mv_n) envp[ei++] = mv_env_models;
    if (mv_nn) {
        envp[ei++] = mv_env_preloads;
        envp[ei++] = mv_env_serve;
        envp[ei++] = "ENCLAVE_NN_SERVE_KIND=RAM";
        envp[ei++] = "ENCLAVE_GGML_BACKEND_DIR=" MV_BACKEND_DIR;
        envp[ei++] = "ENCLAVE_GGML_N_GPU_LAYERS=0";
    }
    return ei;
}
