#include "ggml-shielded.h"
#include "ggml-backend-impl.h"
#include "ggml-impl.h"

extern "C" {
#include "shielded-field.h"
#include "shielded-tee.h"
}

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#define SH_LOG(...) do { if (sh_verbose()) fprintf(stderr, "[shielded] " __VA_ARGS__); } while (0)

static bool sh_verbose() {
    static int v = -1;
    if (v < 0) { const char *e = getenv("SHIELDED_VERBOSE"); v = (e && *e && strcmp(e, "0")) ? 1 : 0; }
    return v != 0;
}

/* q8_0, as ggml stores it: one fp16 scale then 32 quants, per block, per row. */
struct sh_block_q8_0 { uint16_t d; int8_t qs[32]; };
static_assert(sizeof(sh_block_q8_0) == 34, "unexpected q8_0 block layout");

/* --------------------------------------------------------------------------
 * Calibration.
 *
 * Two public, offline constants per site: the activation exponent and the
 * outlier channel set. Both are properties of the PUBLIC weights, calibrated on
 * public text and shipped like an imatrix, so neither leaks anything about a
 * request -- and both must be per-model constants rather than adapted to the
 * activation in hand, since an adaptive exponent would leak activation
 * magnitude. A site with no calibration is not offloaded at all: supports_op
 * says no and ggml_backend_sched quietly runs it on the CPU, in the enclave.
 * ----------------------------------------------------------------------- */
struct sh_calib_site {
    int act_frac = 0;
    std::vector<int64_t> outliers;
};

/* q/k/v come from one attn_norm and gate/up from one ffn_norm, so they share an
 * activation -- and therefore share one exponent, one outlier set and, at run
 * time, ONE PAD. That is not a bandwidth optimisation: masking the same x three
 * times under three pads would hand the adversary three encryptions of one
 * value for no benefit. */
static std::string sh_group_key(const std::string &name) {
    static const std::pair<const char *, const char *> members[] = {
        { "attn_k",   "attn_q" }, { "attn_v",  "attn_q" },
        { "ffn_up",   "ffn_gate" },
    };
    for (const auto &m : members) {
        const size_t p = name.find(m.first);
        if (p != std::string::npos) {
            std::string out = name;
            out.replace(p, strlen(m.first), m.second);
            return out;
        }
    }
    return name;
}

struct sh_state {
    std::mutex mu;
    std::string host = "127.0.0.1";
    int port = 9500;
    std::string calib_path;
    bool configured = false;
    bool calib_loaded = false;
    bool link_failed = false;
    std::map<std::string, sh_calib_site> calib;

    sh_link *link = nullptr;
    /* Weight tensor name -> everything needed to run and to check it. */
    struct entry {
        int node = -1;
        int f_w = 0;
        int64_t K = 0, N = 0;
        const sh_calib_site *site = nullptr;
        std::vector<int8_t> out_rows;   /* encoded weights for the TEE-side outlier term */
    };
    std::map<std::string, entry> weights;
    bool dirty = false;                 /* new weights since the last start() */

    uint64_t offloaded_nodes = 0, local_nodes = 0, macs = 0, verify_fail = 0;
};

static sh_state &sh_get() { static sh_state s; return s; }

void ggml_backend_shielded_configure(const char *host, int port, const char *calib_path) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    if (host && *host) s.host = host;
    if (port > 0) s.port = port;
    if (calib_path && *calib_path) { s.calib_path = calib_path; s.calib_loaded = false; }
    s.configured = true;
}

void ggml_backend_shielded_stats(uint64_t *off, uint64_t *loc, uint64_t *macs, uint64_t *vf) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);
    if (off)  *off  = s.offloaded_nodes;
    if (loc)  *loc  = s.local_nodes;
    if (macs) *macs = s.macs;
    if (vf)   *vf   = s.verify_fail;
}

/* Read the environment once, so enabling the tier is launch configuration rather
 * than an app-visible API -- existing catalog guests keep their wasi-nn contract
 * unchanged, which is the point of putting the split here at all. An explicit
 * ggml_backend_shielded_configure() still wins. */
static void sh_env_defaults(sh_state &s) {
    if (s.configured) return;
    s.configured = true;
    if (const char *h = getenv("SHIELDED_HOST")) if (*h) s.host = h;
    if (const char *p = getenv("SHIELDED_PORT")) if (*p) { const int v = atoi(p); if (v > 0) s.port = v; }
}

static void sh_load_calib(sh_state &s) {
    if (s.calib_loaded) return;
    s.calib_loaded = true;
    if (s.calib_path.empty()) {
        const char *e = getenv("SHIELDED_CALIB");
        if (e && *e) s.calib_path = e;
    }
    if (s.calib_path.empty()) {
        SH_LOG("no calibration configured; nothing will be offloaded\n");
        return;
    }
    FILE *f = fopen(s.calib_path.c_str(), "r");
    if (!f) { SH_LOG("calibration %s unreadable; nothing will be offloaded\n", s.calib_path.c_str()); return; }
    char line[8192];
    while (fgets(line, sizeof line, f)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        char name[512]; int af = 0, nout = 0; int pos = 0;
        if (sscanf(line, "site %511s %d %d%n", name, &af, &nout, &pos) < 3) continue;
        sh_calib_site site;
        site.act_frac = af;
        const char *p = line + pos;
        for (int i = 0; i < nout; i++) {
            long long v = 0; int adv = 0;
            if (sscanf(p, " %lld%n", &v, &adv) != 1) break;
            site.outliers.push_back((int64_t)v);
            p += adv;
        }
        s.calib[name] = std::move(site);
    }
    fclose(f);
    SH_LOG("calibration: %zu sites from %s\n", s.calib.size(), s.calib_path.c_str());
}

static const sh_calib_site *sh_site_for(sh_state &s, const char *name) {
    sh_env_defaults(s);
    sh_load_calib(s);
    auto it = s.calib.find(sh_group_key(name));
    return it == s.calib.end() ? nullptr : &it->second;
}

/* --------------------------------------------------------------------------
 * Weight registration: ggml's q8_0 -> the worker's (K,N) / (K/QK,N) layout.
 * ----------------------------------------------------------------------- */
static bool sh_register(sh_state &s, const ggml_tensor *w) {
    const std::string name = ggml_get_name(w);
    if (s.weights.count(name)) return true;

    const int64_t K = w->ne[0], N = w->ne[1];
    const sh_calib_site *site = sh_site_for(s, name.c_str());
    if (!site) return false;
    if (K % SH_QK != 0) return false;

    const int64_t nb = K / SH_QK;
    std::vector<int8_t>   wq((size_t)K * N);
    std::vector<uint16_t> wd_raw((size_t)nb * N), wd_scaled((size_t)nb * N);

    /* ggml stores row i as nb consecutive blocks; the worker wants channel-major
     * planes. One transpose here, once, at registration. */
    const sh_block_q8_0 *blocks = (const sh_block_q8_0 *)w->data;
    for (int64_t i = 0; i < N; i++)
        for (int64_t b = 0; b < nb; b++) {
            const sh_block_q8_0 &bl = blocks[i * nb + b];
            wd_raw[(size_t)b * N + i] = bl.d;
            for (int t = 0; t < SH_QK; t++)
                wq[(size_t)(b * SH_QK + t) * N + i] = bl.qs[t];
        }

    const int f_w = sh_prepare_weight(wd_raw.data(), wq.data(), K, N, wd_scaled.data());
    if (f_w < 0) { SH_LOG("%s: no weight exponent fits the int8 lane; staying on CPU\n", name.c_str()); return false; }

    if (!s.link) {
        int err = SH_OK;
        s.link = sh_link_open(s.host.c_str(), s.port, true, &err);
        if (!s.link) { s.link_failed = true; return false; }
    }
    /* sh_link borrows wq/wd, so they have to outlive it: park them in the entry. */
    sh_state::entry e;
    e.K = K; e.N = N; e.f_w = f_w; e.site = site;

    static std::vector<std::vector<int8_t>>   wq_store;
    static std::vector<std::vector<uint16_t>> wd_store;
    wq_store.push_back(std::move(wq));
    wd_store.push_back(std::move(wd_scaled));

    const int node = sh_link_add_weight(s.link, name.c_str(), wq_store.back().data(),
                                        wd_store.back().data(), K, N, /*max_m*/ 512, -1);
    if (node < 0) { SH_LOG("%s: %s\n", name.c_str(), sh_link_last_error(s.link)); return false; }
    e.node = node;

    /* The outlier rows, kept in the TEE. Their contribution is computed here in
     * plain int64 where nothing can wrap, and the offloaded activation has those
     * channels zeroed -- so the channels that would have broken Z_M are exactly
     * the ones the field never has to hold. */
    const int8_t *wf = sh_link_weight_rows(s.link, node);
    e.out_rows.resize(site->outliers.size() * (size_t)N);
    for (size_t r = 0; r < site->outliers.size(); r++) {
        const int64_t k = site->outliers[r];
        if (k < 0 || k >= K) { SH_LOG("%s: outlier channel %lld out of range\n", name.c_str(), (long long)k); return false; }
        memcpy(&e.out_rows[r * (size_t)N], wf + k * N, (size_t)N);
    }

    s.weights[name] = std::move(e);
    s.dirty = true;
    SH_LOG("registered %s K=%lld N=%lld f_w=%d act_frac=%d outliers=%zu\n",
           name.c_str(), (long long)K, (long long)N, f_w, site->act_frac, site->outliers.size());
    return true;
}

/* --------------------------------------------------------------------------
 * The backend
 * ----------------------------------------------------------------------- */
static const char *ggml_backend_shielded_get_name(ggml_backend_t) { return "Shielded"; }
static void ggml_backend_shielded_free(ggml_backend_t backend) { delete backend; }

static bool sh_claimable(const ggml_tensor *op) {
    if (op->op != GGML_OP_MUL_MAT) return false;
    const ggml_tensor *src0 = op->src[0];
    const ggml_tensor *src1 = op->src[1];
    if (!src0 || !src1) return false;
    if (src0->type != GGML_TYPE_Q8_0) return false;      /* the tier's weight format */
    if (src1->type != GGML_TYPE_F32) return false;
    if (op->type != GGML_TYPE_F32) return false;
    if (!ggml_is_contiguous(src0) || !ggml_is_contiguous(src1)) return false;
    if (src0->ne[2] != 1 || src0->ne[3] != 1) return false;
    if (src1->ne[2] != 1 || src1->ne[3] != 1) return false;
    if (src0->ne[0] % SH_QK != 0) return false;
    /* A weight tensor has a name and calibration; an activation-activation
     * product (attention) has neither, and must never come here -- TwinShield's
     * OutAttnMult is broken at the group sizes real GQA uses. */
    const char *nm = ggml_get_name(src0);
    if (!nm || !*nm) return false;
    sh_state &s = sh_get();
    return sh_site_for(s, nm) != nullptr;
}

static enum ggml_status ggml_backend_shielded_graph_compute(ggml_backend_t, ggml_cgraph *cgraph) {
    sh_state &s = sh_get();
    std::lock_guard<std::mutex> lk(s.mu);

    /* Register everything this graph needs first, so weights discovered mid-graph
     * do not each trigger their own reconnect. */
    for (int i = 0; i < ggml_graph_n_nodes(cgraph); i++) {
        ggml_tensor *node = ggml_graph_node(cgraph, i);
        if (sh_claimable(node)) sh_register(s, node->src[0]);
    }
    if (s.dirty && s.link && !s.link_failed) {
        const int rc = sh_link_start(s.link);
        if (rc != SH_OK) {
            SH_LOG("worker unavailable (%s); computing in the enclave instead\n",
                   sh_link_last_error(s.link));
            s.link_failed = true;
        } else {
            SH_LOG("worker live at %s:%d with %zu weights\n", s.host.c_str(), s.port, s.weights.size());
        }
        s.dirty = false;
    }

    for (int i = 0; i < ggml_graph_n_nodes(cgraph); i++) {
        ggml_tensor *node = ggml_graph_node(cgraph, i);
        switch (node->op) {
            case GGML_OP_NONE: case GGML_OP_RESHAPE: case GGML_OP_VIEW:
            case GGML_OP_PERMUTE: case GGML_OP_TRANSPOSE:
                continue;
            case GGML_OP_MUL_MAT: break;
            default:
                return GGML_STATUS_FAILED;      /* fail closed: we claimed only matmuls */
        }

        const ggml_tensor *w  = node->src[0];
        const ggml_tensor *a  = node->src[1];
        auto it = s.weights.find(ggml_get_name(w));
        if (it == s.weights.end()) return GGML_STATUS_FAILED;
        sh_state::entry &e = it->second;

        const int64_t K = e.K, N = e.N;
        const int32_t m = (int32_t)a->ne[1];
        const int af = e.site->act_frac;

        /* x_field = round(x * 2^af), with the outlier channels held back. The
         * exponent is a public model constant; deriving it from the activation in
         * hand would buy field headroom by leaking activation magnitude. */
        std::vector<int64_t> x_gpu((size_t)m * K), x_tee;
        const float *src = (const float *)a->data;
        const double scale = ldexp(1.0, af);
        for (int64_t t = 0; t < (int64_t)m * K; t++)
            x_gpu[t] = (int64_t)llrint((double)src[t] * scale);

        const size_t nout = e.site->outliers.size();
        if (nout) {
            x_tee.resize((size_t)m * nout);
            for (int32_t r = 0; r < m; r++)
                for (size_t c = 0; c < nout; c++) {
                    const int64_t k = e.site->outliers[c];
                    x_tee[(size_t)r * nout + c] = x_gpu[(size_t)r * K + k];
                    x_gpu[(size_t)r * K + k] = 0;
                }
        }

        std::vector<int64_t> y((size_t)m * N);
        int64_t *yp[1] = { y.data() };
        const int nodes[1] = { e.node };
        int rc;
        if (s.link && !s.link_failed && sh_link_is_live(s.link)) {
            rc = sh_link_gemm(s.link, nodes, 1, x_gpu.data(), m, yp);
            if (rc == SH_ERR_VERIFY) {
                /* A corrupted product must never reach the caller: it would be
                 * sampled, streamed, or written into the KV cache, where one bad
                 * entry poisons every future token that attends to it. */
                s.verify_fail++;
                fprintf(stderr, "[shielded] %s: %s\n", ggml_get_name(w), sh_link_last_error(s.link));
                return GGML_STATUS_FAILED;
            }
            if (rc != SH_OK) {
                SH_LOG("%s: offload failed (%s); falling back to the enclave\n",
                       ggml_get_name(w), sh_link_last_error(s.link));
                s.link_failed = true;
                rc = sh_link_gemm_local(s.link, nodes, 1, x_gpu.data(), m, yp);
                s.local_nodes++;
            } else {
                s.offloaded_nodes++;
            }
        } else {
            rc = sh_link_gemm_local(s.link, nodes, 1, x_gpu.data(), m, yp);
            s.local_nodes++;
        }
        if (rc != SH_OK) return GGML_STATUS_FAILED;

        /* The outlier term, in the TEE, outside the field. */
        if (nout) {
            for (int32_t r = 0; r < m; r++) {
                int64_t *yr = y.data() + (size_t)r * N;
                for (size_t c = 0; c < nout; c++) {
                    const int64_t xv = x_tee[(size_t)r * nout + c];
                    if (!xv) continue;
                    const int8_t *wrow = &e.out_rows[c * (size_t)N];
                    for (int64_t j = 0; j < N; j++) yr[j] += xv * wrow[j];
                }
            }
        }

        float *dst = (float *)node->data;
        const double inv = ldexp(1.0, -(af + e.f_w));
        for (int64_t t = 0; t < (int64_t)m * N; t++) dst[t] = (float)((double)y[t] * inv);
        s.macs += (uint64_t)m * (uint64_t)K * (uint64_t)N;
    }
    return GGML_STATUS_SUCCESS;
}

static const struct ggml_backend_i ggml_backend_shielded_i = {
    /* .get_name            = */ ggml_backend_shielded_get_name,
    /* .free                = */ ggml_backend_shielded_free,
    /* .set_tensor_async    = */ NULL,
    /* .get_tensor_async    = */ NULL,
    /* .set_tensor_2d_async = */ NULL,
    /* .get_tensor_2d_async = */ NULL,
    /* .cpy_tensor_async    = */ NULL,
    /* .synchronize         = */ NULL,
    /* .graph_plan_create   = */ NULL,
    /* .graph_plan_free     = */ NULL,
    /* .graph_plan_update   = */ NULL,
    /* .graph_plan_compute  = */ NULL,
    /* .graph_compute       = */ ggml_backend_shielded_graph_compute,
    /* .event_record        = */ NULL,
    /* .event_wait          = */ NULL,
    /* .graph_optimize      = */ NULL,
};

static ggml_guid_t ggml_backend_shielded_guid(void) {
    static ggml_guid guid = { 0x51, 0x48, 0x1e, 0x1d, 0x22, 0x0b, 0x4c, 0x77,
                              0x9a, 0x3e, 0x6f, 0x14, 0xd0, 0x8b, 0x2a, 0x63 };
    return &guid;
}

bool ggml_backend_is_shielded(ggml_backend_t backend) {
    return backend != NULL && ggml_guid_matches(backend->guid, ggml_backend_shielded_guid());
}

/* --- device ------------------------------------------------------------- */
static const char *sh_dev_get_name(ggml_backend_dev_t) { return "Shielded"; }
static const char *sh_dev_get_description(ggml_backend_dev_t) {
    return "masked offload to an untrusted GPU";
}
static void sh_dev_get_memory(ggml_backend_dev_t, size_t *free, size_t *total) {
    *free = *total = 0;   /* the activations live in host memory, inside the CVM */
}
static enum ggml_backend_dev_type sh_dev_get_type(ggml_backend_dev_t) {
    /* ACCEL, not GPU: the card is real but it is not inside the enclave, and the
     * distinction is the whole product. A caller enumerating GPUs must not find
     * this and conclude it has one. */
    return GGML_BACKEND_DEVICE_TYPE_ACCEL;
}
static void sh_dev_get_props(ggml_backend_dev_t dev, struct ggml_backend_dev_props *props) {
    props->name        = sh_dev_get_name(dev);
    props->description = sh_dev_get_description(dev);
    props->type        = sh_dev_get_type(dev);
    sh_dev_get_memory(dev, &props->memory_free, &props->memory_total);
    props->caps = { /* async */ false, /* host_buffer */ false,
                    /* buffer_from_host_ptr */ true, /* events */ false };
}
static ggml_backend_t sh_dev_init_backend(ggml_backend_dev_t dev, const char *) {
    ggml_backend_t backend = new ggml_backend {
        /* .guid    = */ ggml_backend_shielded_guid(),
        /* .iface   = */ ggml_backend_shielded_i,
        /* .device  = */ dev,
        /* .context = */ NULL,
    };
    return backend;
}
static ggml_backend_buffer_type_t sh_dev_get_buffer_type(ggml_backend_dev_t) {
    /* Host memory, like the BLAS backend. What reaches the untrusted side is
     * decided explicitly in graph_compute -- never by ggml's buffer plumbing,
     * which has no idea some of these bytes are secret. */
    return ggml_backend_cpu_buffer_type();
}
static bool sh_dev_supports_op(ggml_backend_dev_t, const struct ggml_tensor *op) {
    switch (op->op) {
        case GGML_OP_NONE: case GGML_OP_RESHAPE: case GGML_OP_VIEW:
        case GGML_OP_PERMUTE: case GGML_OP_TRANSPOSE:
            return true;
        case GGML_OP_MUL_MAT:
            return sh_claimable(op);
        default:
            return false;   /* everything nonlinear or position-aware stays in the TEE */
    }
}
static bool sh_dev_supports_buft(ggml_backend_dev_t, ggml_backend_buffer_type_t buft) {
    return ggml_backend_buft_is_host(buft);
}

static const struct ggml_backend_device_i ggml_backend_shielded_device_i = {
    /* .get_name             = */ sh_dev_get_name,
    /* .get_description      = */ sh_dev_get_description,
    /* .get_memory           = */ sh_dev_get_memory,
    /* .get_type             = */ sh_dev_get_type,
    /* .get_props            = */ sh_dev_get_props,
    /* .init_backend         = */ sh_dev_init_backend,
    /* .get_buffer_type      = */ sh_dev_get_buffer_type,
    /* .get_host_buffer_type = */ NULL,
    /* .buffer_from_host_ptr = */ NULL,
    /* .supports_op          = */ sh_dev_supports_op,
    /* .supports_buft        = */ sh_dev_supports_buft,
    /* .offload_op           = */ NULL,
    /* .event_new            = */ NULL,
    /* .event_free           = */ NULL,
    /* .event_synchronize    = */ NULL,
};

/* --- reg ---------------------------------------------------------------- */
static const char *sh_reg_get_name(ggml_backend_reg_t) { return "Shielded"; }
static size_t sh_reg_get_device_count(ggml_backend_reg_t) { return 1; }
static ggml_backend_dev_t sh_reg_get_device(ggml_backend_reg_t reg, size_t) {
    static ggml_backend_device dev = {
        /* .iface   = */ ggml_backend_shielded_device_i,
        /* .reg     = */ reg,
        /* .context = */ NULL,
    };
    return &dev;
}
static const struct ggml_backend_reg_i ggml_backend_shielded_reg_i = {
    /* .get_name         = */ sh_reg_get_name,
    /* .get_device_count = */ sh_reg_get_device_count,
    /* .get_device       = */ sh_reg_get_device,
    /* .get_proc_address = */ NULL,
};

ggml_backend_reg_t ggml_backend_shielded_reg(void) {
    static ggml_backend_reg reg = {
        /* .api_version = */ GGML_BACKEND_API_VERSION,
        /* .iface       = */ ggml_backend_shielded_reg_i,
        /* .context     = */ NULL,
    };
    return &reg;
}

ggml_backend_t ggml_backend_shielded_init(void) {
    return sh_dev_init_backend(sh_reg_get_device(ggml_backend_shielded_reg(), 0), NULL);
}

/* Loadable as a module, so an engine picks the tier up as launch configuration
 * rather than a rebuild -- ggml_backend_load_all() finds it beside the binary or
 * on GGML_BACKEND_PATH. Only compiled in for the shared-library build; the static
 * one links ggml_backend_shielded_reg() directly. */
#ifdef GGML_BACKEND_DL
GGML_BACKEND_DL_IMPL(ggml_backend_shielded_reg)
#endif
