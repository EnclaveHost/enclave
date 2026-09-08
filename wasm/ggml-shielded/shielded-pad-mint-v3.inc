/* Standalone CPU sparse mint. Included here to reuse registered private weights
 * and the exact SIMD r.W kernels without changing the integrated v2 mint. */
#include "shielded-pad-mint-v3.h"

enum { SH_SPARSE_MINT_BATCH = 16 };
typedef struct sh_sparse_mint_plan sh_sparse_mint_plan;
typedef struct {
    sh_sparse_mint_plan *plan;
    uint32_t lane;
    uint8_t *scratch;
    int32_t *r, *u, *acc;
    uint8_t *planes, *plain, *box;
    size_t scratch_bytes, r_bytes, u_bytes, acc_bytes, plane_bytes;
} sh_sparse_mint_task;
struct sh_sparse_mint_plan {
    sh_link *link;
    const uint8_t *seed;
    const sh_pads_span *spans;
    sh_pads_v3_writer *writer;
    uint32_t canonical[SH_PADS_MANIFEST_MAX_GROUPS];
    uint32_t active[SH_PADS_MANIFEST_MAX_GROUPS];
    sh_mint_assignment assignment;
    uint32_t threads;
    int failed;
    size_t cell_bytes;
    sh_sparse_mint_task tasks[SH_MINT_BALANCE_THREADS];
};

static void sh_sparse_mint_fail(sh_sparse_mint_plan *p, int rc) {
    int expected=SH_OK;
    __atomic_compare_exchange_n(&p->failed,&expected,rc,false,__ATOMIC_RELEASE,__ATOMIC_RELAXED);
}
static void sh_sparse_mint_clear(sh_sparse_mint_plan *p) {
    if (!p) return;
    if (p->writer) sh_pads_v3_writer_abort(p->writer);
    for (uint32_t i=0;i<p->threads;i++) if (p->tasks[i].scratch) {
        volatile uint8_t *v=p->tasks[i].scratch;
        for (size_t n=0;n<p->tasks[i].scratch_bytes;n++) v[n]=0;
        free(p->tasks[i].scratch);
    }
    free(p);
}

static void *sh_sparse_mint_worker(void *opaque) {
    sh_sparse_mint_task *t=opaque;
    sh_sparse_mint_plan *p=t->plan;
    sh_link *l=p->link;
    for (uint32_t at=p->assignment.offsets[t->lane];
            at<p->assignment.offsets[t->lane+1] && __atomic_load_n(&p->failed,__ATOMIC_ACQUIRE)==SH_OK;at++) {
        const uint32_t gi=p->active[p->assignment.order[at]], canonical=p->canonical[gi];
        const sh_group *g=&l->groups[gi];
        const sh_pads_span span=p->spans[canonical];
        for (uint64_t relative=0;relative<span.count && __atomic_load_n(&p->failed,__ATOMIC_ACQUIRE)==SH_OK;relative+=SH_SPARSE_MINT_BATCH) {
            const int b=(int)(span.count-relative<SH_SPARSE_MINT_BATCH ? span.count-relative : SH_SPARSE_MINT_BATCH);
            for (int i=0;i<b;i++) sh_pad_r(p->seed,canonical,span.index0+relative+(uint64_t)i,g->K,t->r+(size_t)i*g->K);
            l->simd->pad_planes(t->r,(size_t)b*g->K,t->planes,t->planes+(size_t)b*g->K,t->planes+(size_t)2*b*g->K);
            for (int n=0;n<g->n_nodes;n++) {
                const sh_node *node=&l->nodes[g->nodes[n]];
                l->simd->refill(t->planes,b,node->w,g->K,node->N,t->u+node->u_off,g->u_len,t->acc);
            }
            for (int i=0;i<b;i++) {
                const int rc=sh_pads_v3_writer_cell_with(p->writer,canonical,span.index0+relative+(uint64_t)i,
                        t->u+(size_t)i*g->u_len,(size_t)g->u_len,t->plain,t->box,p->cell_bytes);
                if (rc!=SH_OK) { sh_sparse_mint_fail(p,rc); return NULL; }
            }
        }
    }
    return NULL;
}

/* Checked scratch extents before any task allocation. */
static int sh_sparse_mint_size(uint64_t count, uint64_t unit, size_t *out) {
    if (count>SIZE_MAX/unit) return SH_ERR_RANGE;
    *out=(size_t)(count*unit); return SH_OK;
}

int sh_link_mint_sparse_v3(sh_link *l, const sh_pads_v3_source *source,
        const sh_pads_v3_policy *policy, const sh_pads_span *spans,
        const uint8_t seed[32], const uint8_t consumer_pk[32],
        int directory_fd, const char *name, uint32_t threads,
        uint64_t max_scratch_bytes, bool *published) {
    if (!published) return SH_ERR_RANGE;
    *published=false;
    if (!l || !source || !policy || !policy->manifest || !spans || !seed || !consumer_pk || !name ||
        directory_fd<0 || !threads || threads>SH_MINT_BALANCE_THREADS || !max_scratch_bytes ||
        !policy->max_cell_bytes || policy->max_cell_bytes>(UINT64_C(64)<<20)) return SH_ERR_RANGE;
    if (sh_integrity_failed(l)) return SH_ERR_VERIFY;
    if (l->pipe || l->threads_running) return SH_ERR_RANGE;
    int rc=sh_pads_manifest_validate(policy->manifest);
    if (rc!=SH_OK) return rc;
    if (memcmp(source->model_digest,policy->manifest->model_digest,32) ||
        memcmp(source->calib_digest,policy->manifest->calib_digest,32) ||
        memcmp(source->encoding_digest,policy->manifest->encoding_digest,32)) return SH_ERR_VERIFY;
    uint32_t ng=0,nm=0;
    rc=sh_link_manifest_geometry(l,NULL,0,NULL,0,&ng,&nm);
    if (rc!=SH_OK) return rc;
    if (ng!=policy->manifest->group_count || nm!=policy->manifest->member_count) return SH_ERR_VERIFY;
    for (size_t i=0;i<l->n_nodes;i++) if (!l->nodes[i].w) return SH_ERR_RANGE;
    sh_sparse_mint_plan *p=calloc(1,sizeof *p);
    sh_pads_manifest_group *groups=calloc(ng,sizeof *groups);
    sh_pads_member *members=calloc(nm,sizeof *members);
    sh_pads_group *expected=calloc(ng,sizeof *expected);
    uint64_t *offsets=calloc(ng,sizeof *offsets);
    if (!p || !groups || !members || !expected || !offsets) { rc=SH_ERR_NOMEM; goto done; }
    p->link=l; p->seed=seed; p->spans=spans;
    rc=sh_link_manifest_geometry(l,groups,ng,members,nm,&ng,&nm);
    if (rc!=SH_OK) goto done;
    sh_pads_manifest local={0};
    memcpy(local.model_digest,source->model_digest,32); memcpy(local.calib_digest,source->calib_digest,32);
    memcpy(local.encoding_digest,source->encoding_digest,32);
    local.groups=groups; local.members=members; local.group_count=ng; local.member_count=nm;
    rc=sh_pads_manifest_bind(policy->manifest,&local,p->canonical,ng);
    if (rc!=SH_OK) goto done;
    for (uint32_t i=0;i<ng;i++) expected[i]=policy->manifest->groups[i].identity;
    sh_pads_sparse_extent extent;
    rc=sh_pads_sparse_layout(expected,ng,expected,spans,ng,policy->reserved_lo,policy->reserved_hi,
            policy->max_file_bytes,offsets,ng,&extent);
    if (rc!=SH_OK) goto done;
    if (extent.cells>SH_PADS_WRITER_MAX_CELLS) { rc=SH_ERR_RANGE; goto done; }
    uint64_t costs[SH_PADS_MANIFEST_MAX_GROUPS], max_u=0;
    uint32_t active=0;
    for (uint32_t gi=0;gi<ng;gi++) {
        const sh_group *g=&l->groups[gi];
        const uint64_t count=spans[p->canonical[gi]].count;
        if (!count) continue;
        const uint64_t k=(uint64_t)g->K,u=(uint64_t)g->u_len;
        if (k>UINT64_MAX/u || k*u>UINT64_MAX/count || u>(SIZE_MAX-SH_PADS_CELL_TAG)/3 ||
            SH_PADS_CELL_TAG+3*u>policy->max_cell_bytes) { rc=SH_ERR_RANGE; goto done; }
        p->active[active]=gi; costs[active++]=k*u*count;
        if (u>max_u) max_u=u;
    }
    if (!active) { rc=SH_ERR_RANGE; goto done; }
    p->threads=threads<active ? threads : active;
    rc=sh_mint_balance(costs,active,p->threads,&p->assignment);
    if (rc!=SH_MINT_BALANCE_OK) { rc=rc==SH_MINT_BALANCE_NOMEM ? SH_ERR_NOMEM : SH_ERR_RANGE; goto done; }
    p->cell_bytes=(size_t)(SH_PADS_CELL_TAG+3*max_u);
    /* Include the v3 writer's two shared scratch buffers, although parallel
     * callers use their own buffers. Its public metadata/bitmap are separate. */
    uint64_t total_scratch=2*(uint64_t)p->cell_bytes;
    if (total_scratch>max_scratch_bytes) { rc=SH_ERR_RANGE; goto done; }
    /* Each lane only visits its immutable assigned groups. Do not allocate
     * the output head's maximum-sized u/acc buffers on every other lane. */
    for (uint32_t i=0;i<p->threads;i++) {
        sh_sparse_mint_task *t=&p->tasks[i]; t->plan=p; t->lane=i;
        uint64_t lane_k=0,lane_u=0,lane_n=0;
        for (uint32_t at=p->assignment.offsets[i];at<p->assignment.offsets[i+1];at++) {
            const sh_group *g=&l->groups[p->active[p->assignment.order[at]]];
            if ((uint64_t)g->K>lane_k) lane_k=(uint64_t)g->K;
            if ((uint64_t)g->u_len>lane_u) lane_u=(uint64_t)g->u_len;
            for (int n=0;n<g->n_nodes;n++) if ((uint64_t)l->nodes[g->nodes[n]].N>lane_n) lane_n=(uint64_t)l->nodes[g->nodes[n]].N;
        }
        if (!lane_k || !lane_u || !lane_n ||
            sh_sparse_mint_size(lane_k,SH_SPARSE_MINT_BATCH*sizeof(int32_t),&t->r_bytes)!=SH_OK ||
            sh_sparse_mint_size(lane_u,SH_SPARSE_MINT_BATCH*sizeof(int32_t),&t->u_bytes)!=SH_OK ||
            sh_sparse_mint_size(lane_n,12*sizeof(int32_t),&t->acc_bytes)!=SH_OK ||
            sh_sparse_mint_size(lane_k,3*SH_SPARSE_MINT_BATCH,&t->plane_bytes)!=SH_OK) { rc=SH_ERR_RANGE; goto done; }
        const size_t sizes[]={t->r_bytes,t->u_bytes,t->acc_bytes,t->plane_bytes,p->cell_bytes,p->cell_bytes};
        for (unsigned j=0;j<sizeof sizes/sizeof sizes[0];j++) {
            if (sizes[j]>SIZE_MAX-t->scratch_bytes) { rc=SH_ERR_RANGE; goto done; }
            t->scratch_bytes+=sizes[j];
        }
        if (t->scratch_bytes>max_scratch_bytes-total_scratch) { rc=SH_ERR_RANGE; goto done; }
        total_scratch+=t->scratch_bytes;
    }
    /* The entire aggregate is admitted before allocating even the first lane. */
    for (uint32_t i=0;i<p->threads;i++) {
        sh_sparse_mint_task *t=&p->tasks[i];
        t->scratch=malloc(t->scratch_bytes);
        if (!t->scratch) { rc=SH_ERR_NOMEM; goto done; }
        uint8_t *at=t->scratch;
        t->r=(int32_t *)at; at+=t->r_bytes;
        t->u=(int32_t *)at; at+=t->u_bytes;
        t->acc=(int32_t *)at; at+=t->acc_bytes;
        t->planes=at; at+=t->plane_bytes;
        t->plain=at; at+=p->cell_bytes; t->box=at;
    }
    p->writer=sh_pads_v3_writer_open(directory_fd,name,policy,spans,consumer_pk,&rc);
    if (!p->writer) goto done;
    if (sh_pads_v3_writer_scratch_bytes(p->writer)!=p->cell_bytes) { rc=SH_ERR_RANGE; goto done; }
    if (p->threads==1) sh_sparse_mint_worker(&p->tasks[0]);
    else {
        pthread_t handles[SH_MINT_BALANCE_THREADS];
        bool started[SH_MINT_BALANCE_THREADS]={0};
        for (uint32_t i=0;i<p->threads;i++) started[i]=pthread_create(&handles[i],NULL,sh_sparse_mint_worker,&p->tasks[i])==0;
        for (uint32_t i=0;i<p->threads;i++) if (!started[i]) sh_sparse_mint_worker(&p->tasks[i]);
        for (uint32_t i=0;i<p->threads;i++) if (started[i]) pthread_join(handles[i],NULL);
    }
    rc=__atomic_load_n(&p->failed,__ATOMIC_ACQUIRE);
    if (rc==SH_OK && sh_integrity_failed(l)) rc=SH_ERR_VERIFY;
    if (rc==SH_OK) {
        rc=sh_pads_v3_writer_finish(p->writer,published);
        p->writer=NULL;
    }
done:
    free(groups); free(members); free(expected); free(offsets);
    sh_sparse_mint_clear(p);
    return rc;
}
