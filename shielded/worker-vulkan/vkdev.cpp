/* vkdev.cpp -- see vkdev.h. */
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include "vkdev.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <map>
#include <mutex>
#include <chrono>
#include <algorithm>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <dlfcn.h>
#include <libgen.h>
#include <unistd.h>
#endif

/* ---- loader ------------------------------------------------------------------------------ */
static PFN_vkGetInstanceProcAddr gipa;
#define VKFN(name) static PFN_##name name;
#define VK_INSTANCE_FNS(X) X(vkEnumeratePhysicalDevices) X(vkGetPhysicalDeviceProperties2) X(vkGetPhysicalDeviceFeatures2) \
  X(vkGetPhysicalDeviceQueueFamilyProperties) X(vkGetPhysicalDeviceMemoryProperties) X(vkGetPhysicalDeviceMemoryProperties2) \
  X(vkEnumerateDeviceExtensionProperties) X(vkCreateDevice) X(vkGetDeviceProcAddr)
#define VK_DEVICE_FNS(X) X(vkGetDeviceQueue) X(vkCreateBuffer) X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) \
  X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory) X(vkMapMemory) X(vkUnmapMemory) X(vkGetBufferDeviceAddress) \
  X(vkCreateShaderModule) X(vkDestroyShaderModule) X(vkCreatePipelineLayout) X(vkCreateComputePipelines) \
  X(vkCreateCommandPool) X(vkDestroyCommandPool) X(vkAllocateCommandBuffers) X(vkFreeCommandBuffers) X(vkBeginCommandBuffer) \
  X(vkEndCommandBuffer) X(vkResetCommandBuffer) X(vkCmdBindPipeline) X(vkCmdPushConstants) X(vkCmdDispatch) X(vkCmdPipelineBarrier) \
  X(vkCmdCopyBuffer) X(vkCmdFillBuffer) X(vkQueueSubmit) X(vkCreateFence) X(vkDestroyFence) X(vkWaitForFences) X(vkResetFences) \
  X(vkGetFenceStatus) X(vkQueueWaitIdle) X(vkDeviceWaitIdle)
VKFN(vkCreateInstance) VK_INSTANCE_FNS(VKFN) VK_DEVICE_FNS(VKFN)

static void fatal(const char *m, int code = 75) { fprintf(stderr, "[shielded-worker] vulkan: %s\n", m); exit(code); }
static cudaError_t g_last = cudaSuccess;
static cudaError_t fail(cudaError_t e) { g_last = e; return e; }

/* ---- device ------------------------------------------------------------------------------ */
struct Dev {
    VkInstance inst = VK_NULL_HANDLE; VkPhysicalDevice phys = VK_NULL_HANDLE; VkDevice dev = VK_NULL_HANDLE; VkQueue queue = VK_NULL_HANDLE; uint32_t qf = 0;
    VkPhysicalDeviceMemoryProperties mem{}; std::string name; int cus = 32; size_t total_local = 0; bool budget_ext = false;
    bool spin = false; std::mutex queue_mu;
} D;

static uint32_t mem_type(uint32_t bits, VkMemoryPropertyFlags want, VkMemoryPropertyFlags avoid = 0) {
    for (uint32_t i = 0; i < D.mem.memoryTypeCount; i++)
        if ((bits & (1u << i)) && (D.mem.memoryTypes[i].propertyFlags & want) == want && !(D.mem.memoryTypes[i].propertyFlags & avoid)) return i;
    return UINT32_MAX;
}

/* ---- streams and command buffers --------------------------------------------------------- */
struct VkGraphImpl { VkCommandBuffer cb = VK_NULL_HANDLE; VkCommandPool pool = VK_NULL_HANDLE; };
struct VkStreamImpl {
    VkCommandPool pool = VK_NULL_HANDLE; VkFence fence = VK_NULL_HANDLE;
    VkCommandBuffer open = VK_NULL_HANDLE;      /* being recorded */
    bool capturing = false; bool pending = false;   /* pending: a submitted buffer not yet waited on */
    VkCommandBuffer submitted = VK_NULL_HANDLE; bool submitted_is_graph = false;
};
static VkStreamImpl *g_immediate = nullptr;
static VkStreamImpl *stream_of(cudaStream_t s) { return s ? s : g_immediate; }

static void cmd_barrier(VkCommandBuffer cb) {
    VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER};
    mb.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT;
    mb.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_TRANSFER_WRITE_BIT | VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT,
                         VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, nullptr, 0, nullptr);
}
static VkStreamImpl *new_stream() {
    VkStreamImpl *s = new VkStreamImpl;
    VkCommandPoolCreateInfo cpi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO}; cpi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT; cpi.queueFamilyIndex = D.qf;
    if (vkCreateCommandPool(D.dev, &cpi, nullptr, &s->pool) != VK_SUCCESS) fatal("command pool");
    VkFenceCreateInfo fci{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO}; if (vkCreateFence(D.dev, &fci, nullptr, &s->fence) != VK_SUCCESS) fatal("fence");
    return s;
}
static void wait_pending(VkStreamImpl *s) {
    if (!s->pending) return;
    if (D.spin) { while (vkGetFenceStatus(D.dev, s->fence) == VK_NOT_READY) {} }
    else vkWaitForFences(D.dev, 1, &s->fence, VK_TRUE, ~0ull);
    if (!s->submitted_is_graph && s->submitted) vkFreeCommandBuffers(D.dev, s->pool, 1, &s->submitted);
    s->submitted = VK_NULL_HANDLE; s->pending = false;
}
/* The command buffer being recorded on a stream, opened on first use. */
static VkCommandBuffer cb_of(VkStreamImpl *s) {
    if (s->open) return s->open;
    if (!s->capturing) wait_pending(s);
    VkCommandBufferAllocateInfo cai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO}; cai.commandPool = s->pool; cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cai.commandBufferCount = 1;
    if (vkAllocateCommandBuffers(D.dev, &cai, &s->open) != VK_SUCCESS) fatal("command buffer");
    VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; if (!s->capturing) bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    if (vkBeginCommandBuffer(s->open, &bi) != VK_SUCCESS) fatal("begin command buffer");
    return s->open;
}
static void submit(VkStreamImpl *s, VkCommandBuffer cb, bool is_graph) {
    wait_pending(s);
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO}; si.commandBufferCount = 1; si.pCommandBuffers = &cb;
    std::lock_guard<std::mutex> lk(D.queue_mu);
    vkResetFences(D.dev, 1, &s->fence);
    if (vkQueueSubmit(D.queue, 1, &si, s->fence) != VK_SUCCESS) fatal("queue submit");
    s->pending = true; s->submitted = cb; s->submitted_is_graph = is_graph;
}
/* Submit whatever is recorded (not while capturing) and wait for it. */
static void flush(VkStreamImpl *s) {
    if (s->capturing) return;
    if (s->open) { vkEndCommandBuffer(s->open); VkCommandBuffer cb = s->open; s->open = VK_NULL_HANDLE; submit(s, cb, false); }
    wait_pending(s);
}

/* ---- device memory: the arena that is the pool ------------------------------------------- */
struct Block {
    VkBuffer buf = VK_NULL_HANDLE; VkDeviceMemory mem = VK_NULL_HANDLE; uint64_t base = 0; size_t size = 0;
    std::vector<std::pair<size_t, size_t>> free;        /* (offset, length), sorted, coalesced */
    size_t used = 0;
};
static std::map<uint64_t, Block *> g_blocks;             /* by base address */
static std::mutex g_mem_mu;
static uint64_t g_threshold = 0;                          /* release threshold, as the pool's */
static const size_t BLOCK_MIN = 64ull << 20, ALLOC_ALIGN = 256;

static Block *new_block(size_t size) {
    Block *b = new Block; b->size = size;
    VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO}; bi.size = size;
    bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    if (vkCreateBuffer(D.dev, &bi, nullptr, &b->buf) != VK_SUCCESS) { delete b; return nullptr; }
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(D.dev, b->buf, &mr);
    uint32_t t = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT);
    if (t == UINT32_MAX) t = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    VkMemoryAllocateFlagsInfo fl{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO}; fl.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
    VkMemoryAllocateInfo mai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; mai.pNext = &fl; mai.allocationSize = mr.size; mai.memoryTypeIndex = t;
    if (t == UINT32_MAX || vkAllocateMemory(D.dev, &mai, nullptr, &b->mem) != VK_SUCCESS) { vkDestroyBuffer(D.dev, b->buf, nullptr); delete b; return nullptr; }
    vkBindBufferMemory(D.dev, b->buf, b->mem, 0);
    VkBufferDeviceAddressInfo dai{VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO}; dai.buffer = b->buf; b->base = vkGetBufferDeviceAddress(D.dev, &dai);
    b->free.push_back({0, size});
    g_blocks[b->base] = b;
    return b;
}
static void release_block(Block *b) { g_blocks.erase(b->base); vkDestroyBuffer(D.dev, b->buf, nullptr); vkFreeMemory(D.dev, b->mem, nullptr); delete b; }
static uint64_t reserved_now() { uint64_t r = 0; for (auto &kv : g_blocks) r += kv.second->size; return r; }
static void trim_to(size_t keep) {
    std::vector<Block *> empty; for (auto &kv : g_blocks) if (kv.second->used == 0) empty.push_back(kv.second);
    for (Block *b : empty) { if (reserved_now() <= keep) break; release_block(b); }
}
static void *arena_alloc(size_t n) {
    n = (n + ALLOC_ALIGN - 1) & ~(ALLOC_ALIGN - 1);
    for (auto &kv : g_blocks) {
        Block *b = kv.second;
        for (size_t i = 0; i < b->free.size(); i++) if (b->free[i].second >= n) {
            const size_t off = b->free[i].first;
            if (b->free[i].second == n) b->free.erase(b->free.begin() + i); else { b->free[i].first += n; b->free[i].second -= n; }
            b->used += n; return (void *)(uintptr_t)(b->base + off);
        }
    }
    Block *b = new_block(std::max(n, BLOCK_MIN)); if (!b) return nullptr;
    b->free[0].first += n; b->free[0].second -= n; if (b->free[0].second == 0) b->free.clear();
    b->used += n; return (void *)(uintptr_t)b->base;
}
/* (block, offset) of a device address, or nullptr. */
static Block *find_block(uint64_t addr, size_t *off) {
    auto it = g_blocks.upper_bound(addr); if (it == g_blocks.begin()) return nullptr; --it;
    Block *b = it->second; if (addr < b->base || addr >= b->base + b->size) return nullptr; *off = (size_t)(addr - b->base); return b;
}
static void arena_free(void *p) {
    size_t off; Block *b = find_block((uint64_t)(uintptr_t)p, &off); if (!b) return;
    /* The length is recovered from the neighbours: allocations are contiguous between free ranges. */
    size_t end = b->size; for (auto &f : b->free) if (f.first > off) { end = f.first; break; }
    size_t len = end - off; b->free.push_back({off, len}); b->used -= std::min(b->used, len);
    std::sort(b->free.begin(), b->free.end());
    std::vector<std::pair<size_t, size_t>> m;
    for (auto &f : b->free) { if (!m.empty() && m.back().first + m.back().second == f.first) m.back().second += f.second; else m.push_back(f); }
    b->free.swap(m);
    if (b->used == 0 && reserved_now() > g_threshold) release_block(b);
}

/* ---- pinned host memory ------------------------------------------------------------------ */
struct HostBuf { VkBuffer buf; VkDeviceMemory mem; void *map; uint64_t addr; size_t size; };
static std::map<uintptr_t, HostBuf> g_host;               /* by host pointer */
static HostBuf *find_host(const void *p, size_t *off) {
    auto it = g_host.upper_bound((uintptr_t)p); if (it == g_host.begin()) return nullptr; --it;
    HostBuf &h = it->second; if ((uintptr_t)p < it->first || (uintptr_t)p >= it->first + h.size) return nullptr; *off = (uintptr_t)p - it->first; return &h;
}
static bool host_alloc(size_t n, bool mapped, HostBuf *out) {
    VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO}; bi.size = n ? n : 16;
    bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    if (vkCreateBuffer(D.dev, &bi, nullptr, &out->buf) != VK_SUCCESS) return false;
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(D.dev, out->buf, &mr);
    /* the reply that the kernel writes: prefer device-local host-visible (ReBAR) memory; the request staging: plain host memory */
    uint32_t t = UINT32_MAX;
    if (mapped) t = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (t == UINT32_MAX) t = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT);
    if (t == UINT32_MAX) t = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (t == UINT32_MAX) { vkDestroyBuffer(D.dev, out->buf, nullptr); return false; }
    VkMemoryAllocateFlagsInfo fl{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO}; fl.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
    VkMemoryAllocateInfo mai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; mai.pNext = &fl; mai.allocationSize = mr.size; mai.memoryTypeIndex = t;
    if (vkAllocateMemory(D.dev, &mai, nullptr, &out->mem) != VK_SUCCESS) { vkDestroyBuffer(D.dev, out->buf, nullptr); return false; }
    vkBindBufferMemory(D.dev, out->buf, out->mem, 0);
    if (vkMapMemory(D.dev, out->mem, 0, VK_WHOLE_SIZE, 0, &out->map) != VK_SUCCESS) fatal("map");
    VkBufferDeviceAddressInfo dai{VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO}; dai.buffer = out->buf; out->addr = vkGetBufferDeviceAddress(D.dev, &dai);
    out->size = bi.size; return true;
}
static void host_free(HostBuf &h) { vkUnmapMemory(D.dev, h.mem); vkDestroyBuffer(D.dev, h.buf, nullptr); vkFreeMemory(D.dev, h.mem, nullptr); }

/* ---- copies and fills, recorded on a stream ---------------------------------------------- */
static bool cmd_copy(VkStreamImpl *s, void *dst, const void *src, size_t n, cudaMemcpyKind kind, std::vector<HostBuf> *staging) {
    if (!n) return true;
    VkBuffer sb, db; size_t so, dofs;
    if (kind == cudaMemcpyHostToDevice) {
        Block *b = find_block((uint64_t)(uintptr_t)dst, &dofs); if (!b) return false; db = b->buf;
        size_t hoff; HostBuf *h = find_host(src, &hoff);
        if (h) { sb = h->buf; so = hoff; }
        else { HostBuf st; if (!host_alloc(n, false, &st)) return false; memcpy(st.map, src, n); staging->push_back(st); sb = st.buf; so = 0; }
    } else if (kind == cudaMemcpyDeviceToHost) {
        Block *b = find_block((uint64_t)(uintptr_t)src, &so); if (!b) return false; sb = b->buf;
        size_t hoff; HostBuf *h = find_host(dst, &hoff);
        if (h) { db = h->buf; dofs = hoff; }
        else { HostBuf st; if (!host_alloc(n, false, &st)) return false; staging->push_back(st); db = st.buf; dofs = 0; }
    } else {
        Block *b1 = find_block((uint64_t)(uintptr_t)src, &so), *b2 = find_block((uint64_t)(uintptr_t)dst, &dofs); if (!b1 || !b2) return false; sb = b1->buf; db = b2->buf;
    }
    VkCommandBuffer cb = cb_of(s); VkBufferCopy c{so, dofs, n}; vkCmdCopyBuffer(cb, sb, db, 1, &c); cmd_barrier(cb);
    return true;
}

/* ---- pipelines --------------------------------------------------------------------------- */
struct PC { uint64_t W[8], Y[8]; int32_t N[8], blk0[8]; uint64_t X; int32_t K, xs16, ps16, n, pack; };
struct PCpack { uint64_t y, o; int32_t E; };
static VkPipelineLayout g_layout, g_layout_pack; static VkPipeline g_gemm[9][9], g_pack;
static std::vector<char> read_file(const std::string &p) {
    FILE *f = fopen(p.c_str(), "rb"); if (!f) { fprintf(stderr, "[shielded-worker] vulkan: cannot open %s\n", p.c_str()); exit(75); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); std::vector<char> v(n); if (fread(v.data(), 1, n, f) != (size_t)n) exit(75); fclose(f); return v;
}
static VkPipeline make_pipeline(const std::string &spv, VkPipelineLayout layout, bool subgroup32) {
    std::vector<char> code = read_file(spv);
    VkShaderModuleCreateInfo smi{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO}; smi.codeSize = code.size(); smi.pCode = (const uint32_t *)code.data();
    VkShaderModule mod; if (vkCreateShaderModule(D.dev, &smi, nullptr, &mod) != VK_SUCCESS) fatal("shader module");
    VkPipelineShaderStageRequiredSubgroupSizeCreateInfo rs{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_REQUIRED_SUBGROUP_SIZE_CREATE_INFO}; rs.requiredSubgroupSize = 32;
    VkComputePipelineCreateInfo ci{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO; ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; ci.stage.module = mod; ci.stage.pName = "main";
    if (subgroup32) { ci.stage.pNext = &rs; ci.stage.flags = VK_PIPELINE_SHADER_STAGE_CREATE_REQUIRE_FULL_SUBGROUPS_BIT; }
    ci.layout = layout;
    VkPipeline p; if (vkCreateComputePipelines(D.dev, VK_NULL_HANDLE, 1, &ci, nullptr, &p) != VK_SUCCESS) fatal("compute pipeline");
    vkDestroyShaderModule(D.dev, mod, nullptr); return p;
}

/* ---- init -------------------------------------------------------------------------------- */
static std::string g_shader_dir;
void vk_init(const char *argv0) {
#ifdef _WIN32
    HMODULE h = LoadLibraryA("vulkan-1.dll"); if (!h) fatal("vulkan-1.dll not found");
    gipa = (PFN_vkGetInstanceProcAddr)GetProcAddress(h, "vkGetInstanceProcAddr");
#else
    void *h = dlopen("libvulkan.so.1", RTLD_NOW); if (!h) h = dlopen("libvulkan.so", RTLD_NOW); if (!h) fatal("libvulkan.so.1 not found");
    gipa = (PFN_vkGetInstanceProcAddr)dlsym(h, "vkGetInstanceProcAddr");
#endif
    if (!gipa) fatal("vkGetInstanceProcAddr");
    vkCreateInstance = (PFN_vkCreateInstance)gipa(nullptr, "vkCreateInstance");
    VkApplicationInfo ai{VK_STRUCTURE_TYPE_APPLICATION_INFO}; ai.pApplicationName = "shielded-worker"; ai.apiVersion = VK_API_VERSION_1_3;
    VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO}; ici.pApplicationInfo = &ai;
    if (vkCreateInstance(&ici, nullptr, &D.inst) != VK_SUCCESS) fatal("vkCreateInstance");
#define LOADI(n) n = (PFN_##n)gipa(D.inst, #n); if (!n) fatal("missing " #n);
    VK_INSTANCE_FNS(LOADI)
    uint32_t np = 0; vkEnumeratePhysicalDevices(D.inst, &np, nullptr); std::vector<VkPhysicalDevice> pd(np); vkEnumeratePhysicalDevices(D.inst, &np, pd.data());
    if (!np) fatal("no Vulkan device; the shielded worker is the GPU half by definition");
    int want = getenv("SHIELDED_VK_DEVICE") ? atoi(getenv("SHIELDED_VK_DEVICE")) : 0; if (want < 0 || want >= (int)np) want = 0;
    D.phys = pd[want];
    VkPhysicalDeviceSubgroupSizeControlProperties ssp{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_PROPERTIES};
    VkPhysicalDeviceProperties2 p2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; p2.pNext = &ssp; vkGetPhysicalDeviceProperties2(D.phys, &p2);
    D.name = p2.properties.deviceName;
    if (p2.properties.apiVersion < VK_API_VERSION_1_3) fatal("Vulkan 1.3 required");
    if (ssp.minSubgroupSize > 32 || ssp.maxSubgroupSize < 32) fatal("device cannot run subgroup size 32");
    /* SM / CU count where a vendor extension says; the planner's threshold. */
    uint32_t next = 0; vkEnumerateDeviceExtensionProperties(D.phys, nullptr, &next, nullptr); std::vector<VkExtensionProperties> ext(next); vkEnumerateDeviceExtensionProperties(D.phys, nullptr, &next, ext.data());
    bool has_nv_sm = false, has_amd_core = false;
    for (auto &e : ext) { if (!strcmp(e.extensionName, "VK_NV_shader_sm_builtins")) has_nv_sm = true; if (!strcmp(e.extensionName, "VK_AMD_shader_core_properties")) has_amd_core = true; if (!strcmp(e.extensionName, "VK_EXT_memory_budget")) D.budget_ext = true; }
    if (has_nv_sm) { VkPhysicalDeviceShaderSMBuiltinsPropertiesNV sm{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_SM_BUILTINS_PROPERTIES_NV}; VkPhysicalDeviceProperties2 q{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; q.pNext = &sm; vkGetPhysicalDeviceProperties2(D.phys, &q); if (sm.shaderSMCount) D.cus = (int)sm.shaderSMCount; }
    else if (has_amd_core) { VkPhysicalDeviceShaderCorePropertiesAMD cp{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_CORE_PROPERTIES_AMD}; VkPhysicalDeviceProperties2 q{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; q.pNext = &cp; vkGetPhysicalDeviceProperties2(D.phys, &q); const int n = (int)(cp.shaderEngineCount * cp.shaderArraysPerEngineCount * cp.computeUnitsPerShaderArray); if (n) D.cus = n; }
    if (getenv("SHIELDED_VK_CUS")) D.cus = atoi(getenv("SHIELDED_VK_CUS"));
    VkPhysicalDeviceVulkan13Features f13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceVulkan12Features f12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES}; f12.pNext = &f13;
    VkPhysicalDeviceFeatures2 f2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2}; f2.pNext = &f12; vkGetPhysicalDeviceFeatures2(D.phys, &f2);
    if (!f12.bufferDeviceAddress || !f12.storageBuffer8BitAccess || !f2.features.shaderInt64 || !f12.shaderInt8 || !f13.shaderIntegerDotProduct || !f13.subgroupSizeControl || !f13.computeFullSubgroups)
        fatal("device lacks a required feature (buffer device address, 8-bit storage, int64/int8, integer dot product, subgroup size control)");
    uint32_t nq = 0; vkGetPhysicalDeviceQueueFamilyProperties(D.phys, &nq, nullptr); std::vector<VkQueueFamilyProperties> qp(nq); vkGetPhysicalDeviceQueueFamilyProperties(D.phys, &nq, qp.data());
    D.qf = UINT32_MAX;
    for (uint32_t i = 0; i < nq; i++) if ((qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(qp[i].queueFlags & VK_QUEUE_GRAPHICS_BIT)) { D.qf = i; break; }
    if (D.qf == UINT32_MAX) for (uint32_t i = 0; i < nq; i++) if (qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { D.qf = i; break; }
    float prio = 1.0f; VkDeviceQueueCreateInfo qci{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO}; qci.queueFamilyIndex = D.qf; qci.queueCount = 1; qci.pQueuePriorities = &prio;
    VkPhysicalDeviceVulkan13Features e13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES}; e13.shaderIntegerDotProduct = 1; e13.subgroupSizeControl = 1; e13.computeFullSubgroups = 1;
    VkPhysicalDeviceVulkan12Features e12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES}; e12.pNext = &e13; e12.bufferDeviceAddress = 1; e12.storageBuffer8BitAccess = 1; e12.shaderInt8 = 1;
    VkPhysicalDeviceFeatures2 e2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2}; e2.pNext = &e12; e2.features.shaderInt64 = 1;
    const char *exts[2]; uint32_t ne = 0; if (D.budget_ext) exts[ne++] = "VK_EXT_memory_budget";
    VkDeviceCreateInfo dci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO}; dci.pNext = &e2; dci.queueCreateInfoCount = 1; dci.pQueueCreateInfos = &qci; dci.enabledExtensionCount = ne; dci.ppEnabledExtensionNames = exts;
    if (vkCreateDevice(D.phys, &dci, nullptr, &D.dev) != VK_SUCCESS) fatal("vkCreateDevice");
#define LOADD(n) n = (PFN_##n)vkGetDeviceProcAddr(D.dev, #n); if (!n) fatal("missing " #n);
    VK_DEVICE_FNS(LOADD)
    vkGetDeviceQueue(D.dev, D.qf, 0, &D.queue);
    vkGetPhysicalDeviceMemoryProperties(D.phys, &D.mem);
    for (uint32_t i = 0; i < D.mem.memoryHeapCount; i++) if (D.mem.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) D.total_local += D.mem.memoryHeaps[i].size;
    D.spin = getenv("SHIELDED_VK_SPIN") && atoi(getenv("SHIELDED_VK_SPIN"));
    g_immediate = new_stream();
    /* shaders: env, else beside the binary */
    if (getenv("SHIELDED_VK_SHADERS")) g_shader_dir = getenv("SHIELDED_VK_SHADERS");
    else {
        std::string exe = argv0 ? argv0 : ".";
#ifdef _WIN32
        char buf[MAX_PATH]; if (GetModuleFileNameA(nullptr, buf, MAX_PATH)) exe = buf;
        size_t k = exe.find_last_of("\\/"); g_shader_dir = (k == std::string::npos ? std::string(".") : exe.substr(0, k)) + "\\shaders";
#else
        char buf[4096]; ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1); if (n > 0) { buf[n] = 0; exe = buf; }
        std::vector<char> tmp(exe.begin(), exe.end()); tmp.push_back(0); g_shader_dir = std::string(dirname(tmp.data())) + "/shaders";
#endif
    }
    VkPushConstantRange pr{VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PC)};
    VkPipelineLayoutCreateInfo li{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO}; li.pushConstantRangeCount = 1; li.pPushConstantRanges = &pr;
    if (vkCreatePipelineLayout(D.dev, &li, nullptr, &g_layout) != VK_SUCCESS) fatal("layout");
    VkPushConstantRange pr2{VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PCpack)}; li.pPushConstantRanges = &pr2;
    if (vkCreatePipelineLayout(D.dev, &li, nullptr, &g_layout_pack) != VK_SUCCESS) fatal("layout");
    for (int mr = 1; mr <= 8; mr++) for (int g = 1; g <= 8; g <<= 1)
        g_gemm[mr][g] = make_pipeline(g_shader_dir + "/field_gemm_mr" + std::to_string(mr) + "_g" + std::to_string(g) + ".spv", g_layout, true);
    g_pack = make_pipeline(g_shader_dir + "/pack24.spv", g_layout_pack, false);
}
const char *vk_device_name() { return D.name.c_str(); }
int vk_cu_count() { return D.cus; }

/* ---- the CUDA runtime subset ------------------------------------------------------------- */
cudaError_t cudaSetDevice(int) { return cudaSuccess; }
cudaError_t cudaSetDeviceFlags(unsigned) { return cudaSuccess; }
cudaError_t cudaGetDeviceCount(int *n) { *n = D.dev ? 1 : 0; return cudaSuccess; }
cudaError_t cudaGetDeviceProperties(cudaDeviceProp *p, int) {
    memset(p, 0, sizeof *p); snprintf(p->name, sizeof p->name, "%s", D.name.c_str()); p->totalGlobalMem = D.total_local; p->multiProcessorCount = D.cus; return cudaSuccess;
}
cudaError_t cudaDeviceSynchronize() { flush(g_immediate); vkDeviceWaitIdle(D.dev); return cudaSuccess; }
cudaError_t cudaGetLastError() { cudaError_t e = g_last; g_last = cudaSuccess; return e; }
const char *cudaGetErrorString(cudaError_t e) {
    switch (e) { case cudaSuccess: return "no error"; case cudaErrorMemoryAllocation: return "out of memory"; case cudaErrorInvalidValue: return "invalid value"; default: return "vulkan error"; }
}
cudaError_t cudaMemGetInfo(size_t *free_bytes, size_t *total_bytes) {
    *total_bytes = D.total_local; *free_bytes = D.total_local;
    if (D.budget_ext) {
        VkPhysicalDeviceMemoryBudgetPropertiesEXT b{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT};
        VkPhysicalDeviceMemoryProperties2 m2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_PROPERTIES_2}; m2.pNext = &b; vkGetPhysicalDeviceMemoryProperties2(D.phys, &m2);
        size_t fr = 0;
        for (uint32_t i = 0; i < m2.memoryProperties.memoryHeapCount; i++) if (m2.memoryProperties.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) fr += b.heapBudget[i] > b.heapUsage[i] ? b.heapBudget[i] - b.heapUsage[i] : 0;
        *free_bytes = fr;
    }
    return cudaSuccess;
}

cudaError_t cudaStreamCreateWithFlags(cudaStream_t *s, unsigned) { *s = new_stream(); return cudaSuccess; }
cudaError_t cudaStreamDestroy(cudaStream_t s) {
    if (!s) return cudaSuccess; flush(s); if (s->open) { vkEndCommandBuffer(s->open); vkFreeCommandBuffers(D.dev, s->pool, 1, &s->open); }
    vkDestroyFence(D.dev, s->fence, nullptr); vkDestroyCommandPool(D.dev, s->pool, nullptr); delete s; return cudaSuccess;
}
cudaError_t cudaStreamSynchronize(cudaStream_t s) { flush(stream_of(s)); return cudaSuccess; }
cudaError_t cudaStreamBeginCapture(cudaStream_t s, cudaStreamCaptureMode) {
    VkStreamImpl *st = stream_of(s); flush(st); st->capturing = true; (void)cb_of(st); return cudaSuccess;
}
cudaError_t cudaStreamEndCapture(cudaStream_t s, cudaGraph_t *g) {
    VkStreamImpl *st = stream_of(s); *g = nullptr;
    if (!st->capturing) return fail(cudaErrorStreamCaptureInvalidated);
    st->capturing = false; VkCommandBuffer cb = st->open; st->open = VK_NULL_HANDLE;
    if (vkEndCommandBuffer(cb) != VK_SUCCESS) { vkFreeCommandBuffers(D.dev, st->pool, 1, &cb); return fail(cudaErrorStreamCaptureInvalidated); }
    VkGraphImpl *gr = new VkGraphImpl; gr->cb = cb; gr->pool = st->pool; *g = gr; return cudaSuccess;
}
cudaError_t cudaGraphInstantiate(cudaGraphExec_t *ge, cudaGraph_t g, unsigned long long) { *ge = g; return cudaSuccess; }   /* the graph IS its executable */
cudaError_t cudaGraphDestroy(cudaGraph_t) { return cudaSuccess; }                                                            /* ownership moved to the exec */
cudaError_t cudaGraphExecDestroy(cudaGraphExec_t g) { if (g) { vkFreeCommandBuffers(D.dev, g->pool, 1, &g->cb); delete g; } return cudaSuccess; }
cudaError_t cudaGraphLaunch(cudaGraphExec_t g, cudaStream_t s) { VkStreamImpl *st = stream_of(s); flush(st); submit(st, g->cb, true); return cudaSuccess; }

cudaError_t cudaMallocAsync(void **p, size_t n, cudaStream_t) { std::lock_guard<std::mutex> lk(g_mem_mu); *p = arena_alloc(n); return *p ? cudaSuccess : fail(cudaErrorMemoryAllocation); }
cudaError_t cudaFreeAsync(void *p, cudaStream_t s) { flush(stream_of(s)); std::lock_guard<std::mutex> lk(g_mem_mu); arena_free(p); return cudaSuccess; }
cudaError_t cudaDeviceGetDefaultMemPool(cudaMemPool_t *pool, int) { *pool = (cudaMemPool_t)1; return cudaSuccess; }
cudaError_t cudaMemPoolGetAttribute(cudaMemPool_t, cudaMemPoolAttr a, void *v) {
    std::lock_guard<std::mutex> lk(g_mem_mu);
    if (a == cudaMemPoolAttrReservedMemCurrent) *(cuuint64_t *)v = reserved_now(); else if (a == cudaMemPoolAttrReleaseThreshold) *(cuuint64_t *)v = g_threshold; return cudaSuccess;
}
cudaError_t cudaMemPoolSetAttribute(cudaMemPool_t, cudaMemPoolAttr a, void *v) { std::lock_guard<std::mutex> lk(g_mem_mu); if (a == cudaMemPoolAttrReleaseThreshold) g_threshold = *(cuuint64_t *)v; return cudaSuccess; }
cudaError_t cudaMemPoolTrimTo(cudaMemPool_t, size_t keep) { std::lock_guard<std::mutex> lk(g_mem_mu); trim_to(keep); return cudaSuccess; }

cudaError_t cudaMemcpyAsync(void *dst, const void *src, size_t n, cudaMemcpyKind k, cudaStream_t s) {
    VkStreamImpl *st = stream_of(s); std::vector<HostBuf> staging;
    if (!cmd_copy(st, dst, src, n, k, &staging)) return fail(cudaErrorInvalidValue);
    if (!staging.empty()) { if (st->capturing) fatal("pageable copy inside a captured graph"); flush(st); for (auto &h : staging) host_free(h); }
    return cudaSuccess;
}
cudaError_t cudaMemcpy(void *dst, const void *src, size_t n, cudaMemcpyKind k) {
    VkStreamImpl *st = g_immediate; std::vector<HostBuf> staging;
    if (k == cudaMemcpyDeviceToHost) {
        size_t hoff; if (find_host(dst, &hoff)) { if (!cmd_copy(st, dst, src, n, k, &staging)) return fail(cudaErrorInvalidValue); flush(st); return cudaSuccess; }
        HostBuf tmp; if (!host_alloc(n, false, &tmp)) return fail(cudaErrorMemoryAllocation);
        size_t so; Block *b = find_block((uint64_t)(uintptr_t)src, &so); if (!b) { host_free(tmp); return fail(cudaErrorInvalidValue); }
        VkCommandBuffer cb = cb_of(st); VkBufferCopy c{so, 0, n}; vkCmdCopyBuffer(cb, b->buf, tmp.buf, 1, &c); cmd_barrier(cb); flush(st);
        memcpy(dst, tmp.map, n); host_free(tmp); return cudaSuccess;
    }
    if (!cmd_copy(st, dst, src, n, k, &staging)) return fail(cudaErrorInvalidValue);
    flush(st); for (auto &h : staging) host_free(h); return cudaSuccess;
}
cudaError_t cudaMemset(void *dst, int byte, size_t n) {
    size_t off; Block *b = find_block((uint64_t)(uintptr_t)dst, &off); if (!b) return fail(cudaErrorInvalidValue);
    const uint32_t word = (uint32_t)(byte & 0xff) * 0x01010101u; VkCommandBuffer cb = cb_of(g_immediate);
    const size_t head = (4 - (off & 3)) & 3, mid = (n - std::min(n, head)) & ~(size_t)3, tail = n - std::min(n, head) - mid;
    if (mid) vkCmdFillBuffer(cb, b->buf, off + head, mid, word);
    if (head || tail) { std::vector<uint8_t> bytes(4, (uint8_t)byte); HostBuf st; if (!host_alloc(4, false, &st)) return fail(cudaErrorMemoryAllocation); memcpy(st.map, bytes.data(), 4);
        if (head) { VkBufferCopy c{0, off, std::min(head, n)}; vkCmdCopyBuffer(cb, st.buf, b->buf, 1, &c); }
        if (tail) { VkBufferCopy c{0, off + head + mid, tail}; vkCmdCopyBuffer(cb, st.buf, b->buf, 1, &c); }
        cmd_barrier(cb); flush(g_immediate); host_free(st); return cudaSuccess; }
    cmd_barrier(cb); flush(g_immediate); return cudaSuccess;
}
cudaError_t cudaHostAlloc(void **p, size_t n, unsigned flags) {
    HostBuf h; if (!host_alloc(n, flags & cudaHostAllocMapped, &h)) return fail(cudaErrorMemoryAllocation);
    g_host[(uintptr_t)h.map] = h; *p = h.map; return cudaSuccess;
}
cudaError_t cudaFreeHost(void *p) { auto it = g_host.find((uintptr_t)p); if (it == g_host.end()) return fail(cudaErrorInvalidValue); flush(g_immediate); host_free(it->second); g_host.erase(it); return cudaSuccess; }
cudaError_t cudaHostGetDevicePointer(void **dev, void *host, unsigned) { size_t off; HostBuf *h = find_host(host, &off); if (!h) return fail(cudaErrorInvalidValue); *dev = (void *)(uintptr_t)(h->addr + off); return cudaSuccess; }

struct VkEventImpl { std::chrono::steady_clock::time_point t; };
cudaError_t cudaEventCreate(cudaEvent_t *e) { *e = new VkEventImpl; return cudaSuccess; }
cudaError_t cudaEventDestroy(cudaEvent_t e) { delete e; return cudaSuccess; }
cudaError_t cudaEventRecord(cudaEvent_t e, cudaStream_t s) { flush(stream_of(s)); e->t = std::chrono::steady_clock::now(); return cudaSuccess; }
cudaError_t cudaEventRecordWithFlags(cudaEvent_t e, cudaStream_t s, unsigned) { if (!stream_of(s)->capturing) return cudaEventRecord(e, s); return cudaSuccess; }
cudaError_t cudaEventSynchronize(cudaEvent_t) { return cudaSuccess; }
cudaError_t cudaEventElapsedTime(float *ms, cudaEvent_t a, cudaEvent_t b) { *ms = (float)std::chrono::duration<double, std::milli>(b->t - a->t).count(); return cudaSuccess; }

/* ---- the kernels ------------------------------------------------------------------------- */
void vk_launch_gemm(int mr, int g, const GemmTab &tab, int nblocks, int K, const int8_t *X, long long xstride, long long pstride, cudaStream_t s) {
    PC pc; memset(&pc, 0, sizeof pc);
    for (int i = 0; i < 8; i++) { pc.W[i] = (uint64_t)(uintptr_t)tab.W[i]; pc.Y[i] = (uint64_t)(uintptr_t)tab.Y[i]; pc.N[i] = tab.N[i]; pc.blk0[i] = tab.blk0[i]; }
    pc.X = (uint64_t)(uintptr_t)X; pc.K = K; pc.xs16 = (int)(xstride >> 4); pc.ps16 = (int)(pstride >> 4); pc.n = tab.n; pc.pack = tab.pack;
    VkCommandBuffer cb = cb_of(stream_of(s));
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, g_gemm[mr][g]);
    vkCmdPushConstants(cb, g_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof pc, &pc);
    vkCmdDispatch(cb, (uint32_t)nblocks, 1, 1); cmd_barrier(cb);
}
void vk_launch_pack24(const int32_t *y, uint8_t *o, long long E, cudaStream_t s) {
    PCpack pc{(uint64_t)(uintptr_t)y, (uint64_t)(uintptr_t)o, (int32_t)E}; VkCommandBuffer cb = cb_of(stream_of(s));
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, g_pack);
    vkCmdPushConstants(cb, g_layout_pack, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof pc, &pc);
    vkCmdDispatch(cb, (uint32_t)(((3 * E + 3) / 4 + 255) / 256), 1, 1); cmd_barrier(cb);
}
