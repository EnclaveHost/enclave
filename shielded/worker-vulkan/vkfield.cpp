/* vkfield.cpp -- the shielded field GEMM on Vulkan: self-test and throughput, standalone.
 *
 * Runs the worker's startup self-test shapes (../worker-cuda/worker.cu selftest()) against the
 * same int64 host reference, both reply forms, then the HELLO throughput probe (K = N = 4096,
 * m = 8, 20 launches) and a per-dispatch latency probe on the 0.5B gate|up shape. No vendor SDK:
 * the Vulkan loader is opened at run time (libvulkan.so.1 / vulkan-1.dll), SPIR-V is loaded from
 * shaders/, buffers are addressed by device address so there are no descriptor sets at all.
 *
 *   vkfield [--device N] [--cus N] [--shaders DIR] [--no-selftest] [--iters N]
 *           [--priority low|medium|high|realtime] [--gpu-class idle|below|normal|above|high|realtime]
 *           [--gfx-queue] [--flood SEC] [--frames SEC [--frame-us US] [--fps N] [--frame-launches L] [--no-warmup]]
 *
 * --priority creates the queue with VK_KHR/EXT_global_priority (the worker runs LOW so the
 * owner's own applications win the card when they contend). --flood saturates the card and
 * prints its rate each second; --frames is the stand-in for the owner's game: a fixed amount of
 * GPU work per frame at --fps, frame times reported. Run one of each on the same card, in two
 * processes, to see what a priority does. --gpu-class (Windows only) sets the process's WDDM
 * scheduling priority class (D3DKMTSetProcessSchedulingPriorityClass), which covers every context
 * the process creates, before the device exists.
 */
#define VK_NO_PROTOTYPES
#include <vulkan/vulkan.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <chrono>
#include <string>
#include <vector>
#include <algorithm>
#include <thread>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#else
#include <dlfcn.h>
#endif
extern "C" {
#include "shielded-field.h"
}

/* ---- loader ------------------------------------------------------------------------------ */
static PFN_vkGetInstanceProcAddr gipa;
#define VKFN(name) static PFN_##name name;
#define VK_INSTANCE_FNS(X) X(vkEnumeratePhysicalDevices) X(vkGetPhysicalDeviceProperties2) \
  X(vkGetPhysicalDeviceFeatures2) X(vkGetPhysicalDeviceQueueFamilyProperties) X(vkGetPhysicalDeviceQueueFamilyProperties2) \
  X(vkGetPhysicalDeviceMemoryProperties) X(vkEnumerateDeviceExtensionProperties) X(vkCreateDevice) X(vkGetDeviceProcAddr)
#define VK_DEVICE_FNS(X) X(vkGetFenceStatus) X(vkGetDeviceQueue) X(vkCreateBuffer) X(vkDestroyBuffer) X(vkGetBufferMemoryRequirements) \
  X(vkAllocateMemory) X(vkFreeMemory) X(vkBindBufferMemory) X(vkMapMemory) X(vkUnmapMemory) X(vkGetBufferDeviceAddress) \
  X(vkCreateShaderModule) X(vkDestroyShaderModule) X(vkCreatePipelineLayout) X(vkCreateComputePipelines) X(vkDestroyPipeline) \
  X(vkCreateCommandPool) X(vkAllocateCommandBuffers) X(vkBeginCommandBuffer) X(vkEndCommandBuffer) X(vkResetCommandBuffer) \
  X(vkCmdBindPipeline) X(vkCmdPushConstants) X(vkCmdDispatch) X(vkCmdPipelineBarrier) X(vkCmdCopyBuffer) X(vkCmdFillBuffer) \
  X(vkQueueSubmit) X(vkCreateFence) X(vkWaitForFences) X(vkResetFences) X(vkQueueWaitIdle) X(vkDeviceWaitIdle)
VKFN(vkCreateInstance) VK_INSTANCE_FNS(VKFN) VK_DEVICE_FNS(VKFN)

static void die(const char *m, int code = 1) { fprintf(stderr, "vkfield: %s\n", m); exit(code); }
static void ck(VkResult r, const char *what) { if (r != VK_SUCCESS) { fprintf(stderr, "vkfield: %s failed: %d\n", what, (int)r); exit(1); } }

static void load_loader() {
#ifdef _WIN32
    HMODULE h = LoadLibraryA("vulkan-1.dll"); if (!h) die("vulkan-1.dll not found");
    gipa = (PFN_vkGetInstanceProcAddr)GetProcAddress(h, "vkGetInstanceProcAddr");
#else
    void *h = dlopen("libvulkan.so.1", RTLD_NOW); if (!h) h = dlopen("libvulkan.so", RTLD_NOW); if (!h) die("libvulkan.so.1 not found");
    gipa = (PFN_vkGetInstanceProcAddr)dlsym(h, "vkGetInstanceProcAddr");
#endif
    if (!gipa) die("vkGetInstanceProcAddr missing");
    vkCreateInstance = (PFN_vkCreateInstance)gipa(nullptr, "vkCreateInstance");
}

/* ---- Windows: the process's GPU scheduling priority class (WDDM scheduler) ---------------- */
static std::string g_gpu_class;
static void set_gpu_class(const char *s) {
    const int cls = !strcmp(s, "idle") ? 0 : !strcmp(s, "below") ? 1 : !strcmp(s, "normal") ? 2 : !strcmp(s, "above") ? 3 : !strcmp(s, "high") ? 4 : !strcmp(s, "realtime") ? 5 : -1;
    if (cls < 0) die("--gpu-class idle|below|normal|above|high|realtime", 2);
#ifdef _WIN32
    HMODULE g = LoadLibraryA("gdi32.dll"); if (!g) die("gdi32.dll");
    typedef LONG (WINAPI *SetFn)(HANDLE, int); typedef LONG (WINAPI *GetFn)(HANDLE, int *);
    SetFn setf = (SetFn)GetProcAddress(g, "D3DKMTSetProcessSchedulingPriorityClass"); GetFn getf = (GetFn)GetProcAddress(g, "D3DKMTGetProcessSchedulingPriorityClass");
    if (!setf) die("gdi32 does not export D3DKMTSetProcessSchedulingPriorityClass", 75);
    int before = -1, after = -1; if (getf) getf(GetCurrentProcess(), &before);
    const LONG st = setf(GetCurrentProcess(), cls); if (getf) getf(GetCurrentProcess(), &after);
    printf("[vkfield] GPU scheduling priority class %s (%d): status 0x%lx, class %d -> %d\n", s, cls, (unsigned long)st, before, after);
    if (st != 0) die("the scheduling class was refused", 75);
    g_gpu_class = s;
#else
    fprintf(stderr, "vkfield: --gpu-class is a Windows (WDDM) setting; ignored here\n");
#endif
}

/* ---- device ------------------------------------------------------------------------------ */
struct Dev {
    VkInstance inst; VkPhysicalDevice phys; VkDevice dev; VkQueue queue; uint32_t qf;
    VkPhysicalDeviceMemoryProperties mem; VkCommandPool pool; VkFence fence; VkCommandBuffer cb;
    std::string name; uint32_t subgroup_min, subgroup_max; bool dot_accel;
    std::string prio_name = "default"; std::string prio_offered;
} D;
/* ---- queue global priority (VK_KHR_global_priority, else VK_EXT_global_priority [+ _query]) ---- */
static const char *prio_str(VkQueueGlobalPriority p) { return p == VK_QUEUE_GLOBAL_PRIORITY_LOW ? "low" : p == VK_QUEUE_GLOBAL_PRIORITY_MEDIUM ? "medium" : p == VK_QUEUE_GLOBAL_PRIORITY_HIGH ? "high" : p == VK_QUEUE_GLOBAL_PRIORITY_REALTIME ? "realtime" : "?"; }
static VkQueueGlobalPriority prio_parse(const char *s) {
    if (!strcmp(s, "low")) return VK_QUEUE_GLOBAL_PRIORITY_LOW; if (!strcmp(s, "medium")) return VK_QUEUE_GLOBAL_PRIORITY_MEDIUM;
    if (!strcmp(s, "high")) return VK_QUEUE_GLOBAL_PRIORITY_HIGH; if (!strcmp(s, "realtime")) return VK_QUEUE_GLOBAL_PRIORITY_REALTIME;
    return (VkQueueGlobalPriority)0;
}


static void init_device(int want, VkQueueGlobalPriority prio, bool gfx_queue) {
    VkApplicationInfo ai{VK_STRUCTURE_TYPE_APPLICATION_INFO}; ai.pApplicationName = "vkfield"; ai.apiVersion = VK_API_VERSION_1_3;
    VkInstanceCreateInfo ici{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO}; ici.pApplicationInfo = &ai;
    ck(vkCreateInstance(&ici, nullptr, &D.inst), "vkCreateInstance");
#define LOADI(n) n = (PFN_##n)gipa(D.inst, #n); if (!n) die("missing " #n);
    VK_INSTANCE_FNS(LOADI)
    uint32_t np = 0; vkEnumeratePhysicalDevices(D.inst, &np, nullptr);
    std::vector<VkPhysicalDevice> pd(np); vkEnumeratePhysicalDevices(D.inst, &np, pd.data());
    if (np == 0) die("no Vulkan device", 75);
    if (want < 0 || want >= (int)np) want = 0;
    D.phys = pd[want];
    VkPhysicalDeviceSubgroupSizeControlProperties ssp{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_SIZE_CONTROL_PROPERTIES};
    VkPhysicalDeviceShaderIntegerDotProductProperties dpp{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_INTEGER_DOT_PRODUCT_PROPERTIES}; dpp.pNext = &ssp;
    VkPhysicalDeviceProperties2 p2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2}; p2.pNext = &dpp;
    vkGetPhysicalDeviceProperties2(D.phys, &p2);
    D.name = p2.properties.deviceName; D.subgroup_min = ssp.minSubgroupSize; D.subgroup_max = ssp.maxSubgroupSize;
    D.dot_accel = dpp.integerDotProduct4x8BitPackedSignedAccelerated;
    if (p2.properties.apiVersion < VK_API_VERSION_1_3) die("Vulkan 1.3 required", 75);
    VkPhysicalDeviceVulkan13Features f13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
    VkPhysicalDeviceVulkan12Features f12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES}; f12.pNext = &f13;
    VkPhysicalDeviceFeatures2 f2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2}; f2.pNext = &f12;
    vkGetPhysicalDeviceFeatures2(D.phys, &f2);
    if (!f12.bufferDeviceAddress || !f12.storageBuffer8BitAccess || !f2.features.shaderInt64 || !f12.shaderInt8 ||
        !f13.shaderIntegerDotProduct || !f13.subgroupSizeControl || !f13.computeFullSubgroups)
        die("device lacks a required feature (bufferDeviceAddress, 8-bit storage, int64/int8, integer dot product, subgroup size control)", 75);
    if (D.subgroup_min > 32 || D.subgroup_max < 32) die("device cannot run subgroup size 32", 75);
    uint32_t nq = 0; vkGetPhysicalDeviceQueueFamilyProperties(D.phys, &nq, nullptr);
    std::vector<VkQueueFamilyProperties> qp(nq); vkGetPhysicalDeviceQueueFamilyProperties(D.phys, &nq, qp.data());
    D.qf = UINT32_MAX;
    if (gfx_queue) { for (uint32_t i = 0; i < nq; i++) if ((qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && (qp[i].queueFlags & VK_QUEUE_GRAPHICS_BIT)) { D.qf = i; break; } }
    else for (uint32_t i = 0; i < nq; i++) if ((qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) && !(qp[i].queueFlags & VK_QUEUE_GRAPHICS_BIT)) { D.qf = i; break; }
    if (D.qf == UINT32_MAX) for (uint32_t i = 0; i < nq; i++) if (qp[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { D.qf = i; break; }
    /* global priority: which extension, and what the family offers */
    uint32_t next = 0; vkEnumerateDeviceExtensionProperties(D.phys, nullptr, &next, nullptr); std::vector<VkExtensionProperties> ext(next); vkEnumerateDeviceExtensionProperties(D.phys, nullptr, &next, ext.data());
    bool khr = false, ext_prio = false, ext_query = false;
    for (auto &e : ext) { if (!strcmp(e.extensionName, "VK_KHR_global_priority")) khr = true; if (!strcmp(e.extensionName, "VK_EXT_global_priority")) ext_prio = true; if (!strcmp(e.extensionName, "VK_EXT_global_priority_query")) ext_query = true; }
    if (khr || ext_query) {
        std::vector<VkQueueFamilyGlobalPriorityProperties> gp(nq); std::vector<VkQueueFamilyProperties2> qp2(nq);
        for (uint32_t i = 0; i < nq; i++) { gp[i] = VkQueueFamilyGlobalPriorityProperties{VK_STRUCTURE_TYPE_QUEUE_FAMILY_GLOBAL_PRIORITY_PROPERTIES}; qp2[i] = VkQueueFamilyProperties2{VK_STRUCTURE_TYPE_QUEUE_FAMILY_PROPERTIES_2}; qp2[i].pNext = &gp[i]; }
        vkGetPhysicalDeviceQueueFamilyProperties2(D.phys, &nq, qp2.data());
        for (uint32_t k = 0; k < gp[D.qf].priorityCount; k++) { if (k) D.prio_offered += ","; D.prio_offered += prio_str(gp[D.qf].priorities[k]); }
    } else D.prio_offered = khr || ext_prio ? "(no query extension)" : "(no global-priority extension)";
    float prio1 = 1.0f; VkDeviceQueueCreateInfo qci{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO}; qci.queueFamilyIndex = D.qf; qci.queueCount = 1; qci.pQueuePriorities = &prio1;
    VkDeviceQueueGlobalPriorityCreateInfo gpi{VK_STRUCTURE_TYPE_DEVICE_QUEUE_GLOBAL_PRIORITY_CREATE_INFO}; gpi.globalPriority = prio;
    const char *exts[2]; uint32_t ne = 0;
    if (prio) {
        if (khr) exts[ne++] = "VK_KHR_global_priority"; else if (ext_prio) exts[ne++] = "VK_EXT_global_priority"; else die("--priority: the device has no global-priority extension", 75);
        qci.pNext = &gpi; D.prio_name = prio_str(prio);
    }
    VkPhysicalDeviceVulkan13Features e13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES}; e13.shaderIntegerDotProduct = 1; e13.subgroupSizeControl = 1; e13.computeFullSubgroups = 1; e13.synchronization2 = f13.synchronization2;
    VkPhysicalDeviceVulkan12Features e12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES}; e12.pNext = &e13; e12.bufferDeviceAddress = 1; e12.storageBuffer8BitAccess = 1; e12.shaderInt8 = 1;
    VkPhysicalDeviceFeatures2 e2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2}; e2.pNext = &e12; e2.features.shaderInt64 = 1;
    VkDeviceCreateInfo dci{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO}; dci.pNext = &e2; dci.queueCreateInfoCount = 1; dci.pQueueCreateInfos = &qci; dci.enabledExtensionCount = ne; dci.ppEnabledExtensionNames = exts;
    { VkResult r = vkCreateDevice(D.phys, &dci, nullptr, &D.dev);
      if (r != VK_SUCCESS) { fprintf(stderr, "vkfield: vkCreateDevice failed: %d%s\n", (int)r, r == VK_ERROR_NOT_PERMITTED ? " (VK_ERROR_NOT_PERMITTED: this priority needs privilege)" : r == VK_ERROR_INITIALIZATION_FAILED ? " (VK_ERROR_INITIALIZATION_FAILED: priority not offered by this family)" : ""); exit(75); } }
#define LOADD(n) n = (PFN_##n)vkGetDeviceProcAddr(D.dev, #n); if (!n) die("missing " #n);
    VK_DEVICE_FNS(LOADD)
    vkGetDeviceQueue(D.dev, D.qf, 0, &D.queue);
    vkGetPhysicalDeviceMemoryProperties(D.phys, &D.mem);
    VkCommandPoolCreateInfo cpi{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO}; cpi.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT; cpi.queueFamilyIndex = D.qf;
    ck(vkCreateCommandPool(D.dev, &cpi, nullptr, &D.pool), "command pool");
    VkCommandBufferAllocateInfo cai{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO}; cai.commandPool = D.pool; cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; cai.commandBufferCount = 1;
    ck(vkAllocateCommandBuffers(D.dev, &cai, &D.cb), "command buffer");
    VkFenceCreateInfo fci{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO}; ck(vkCreateFence(D.dev, &fci, nullptr, &D.fence), "fence");
}

/* ---- buffers ----------------------------------------------------------------------------- */
struct Buf { VkBuffer b = VK_NULL_HANDLE; VkDeviceMemory m = VK_NULL_HANDLE; VkDeviceAddress addr = 0; void *map = nullptr; size_t size = 0; };
static uint32_t mem_type(uint32_t bits, VkMemoryPropertyFlags want, VkMemoryPropertyFlags avoid = 0) {
    for (uint32_t i = 0; i < D.mem.memoryTypeCount; i++)
        if ((bits & (1u << i)) && (D.mem.memoryTypes[i].propertyFlags & want) == want && !(D.mem.memoryTypes[i].propertyFlags & avoid)) return i;
    return UINT32_MAX;
}
static Buf make_buf(size_t size, bool host_visible) {
    Buf x; x.size = size ? size : 16;
    VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO}; bi.size = x.size;
    bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    ck(vkCreateBuffer(D.dev, &bi, nullptr, &x.b), "buffer");
    VkMemoryRequirements mr; vkGetBufferMemoryRequirements(D.dev, x.b, &mr);
    uint32_t t = host_visible ? mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)
                              : mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT);
    if (t == UINT32_MAX) t = mem_type(mr.memoryTypeBits, host_visible ? VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT : VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (t == UINT32_MAX) die("no suitable memory type");
    VkMemoryAllocateFlagsInfo fl{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO}; fl.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
    VkMemoryAllocateInfo mai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; mai.pNext = &fl; mai.allocationSize = mr.size; mai.memoryTypeIndex = t;
    ck(vkAllocateMemory(D.dev, &mai, nullptr, &x.m), "allocate");
    ck(vkBindBufferMemory(D.dev, x.b, x.m, 0), "bind");
    VkBufferDeviceAddressInfo dai{VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO}; dai.buffer = x.b; x.addr = vkGetBufferDeviceAddress(D.dev, &dai);
    if (host_visible) ck(vkMapMemory(D.dev, x.m, 0, VK_WHOLE_SIZE, 0, &x.map), "map");
    return x;
}
static void free_buf(Buf &x) { if (x.map) vkUnmapMemory(D.dev, x.m); if (x.b) vkDestroyBuffer(D.dev, x.b, nullptr); if (x.m) vkFreeMemory(D.dev, x.m, nullptr); x = Buf(); }

/* ---- one-shot command helpers ------------------------------------------------------------ */
static void cb_begin() { vkResetCommandBuffer(D.cb, 0); VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT; ck(vkBeginCommandBuffer(D.cb, &bi), "begin"); }
static void cb_submit_wait() {
    ck(vkEndCommandBuffer(D.cb), "end");
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO}; si.commandBufferCount = 1; si.pCommandBuffers = &D.cb;
    ck(vkResetFences(D.dev, 1, &D.fence), "reset fence"); ck(vkQueueSubmit(D.queue, 1, &si, D.fence), "submit");
    ck(vkWaitForFences(D.dev, 1, &D.fence, VK_TRUE, ~0ull), "wait");
}
static void cmd_barrier() {
    VkMemoryBarrier mb{VK_STRUCTURE_TYPE_MEMORY_BARRIER}; mb.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_WRITE_BIT; mb.dstAccessMask = VK_ACCESS_SHADER_READ_BIT | VK_ACCESS_SHADER_WRITE_BIT | VK_ACCESS_TRANSFER_READ_BIT | VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(D.cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT | VK_PIPELINE_STAGE_TRANSFER_BIT | VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, nullptr, 0, nullptr);
}
static void upload(Buf &dst, const void *src, size_t n) {
    Buf st = make_buf(n, true); memcpy(st.map, src, n);
    cb_begin(); VkBufferCopy c{0, 0, n}; vkCmdCopyBuffer(D.cb, st.b, dst.b, 1, &c); cmd_barrier(); cb_submit_wait(); free_buf(st);
}
static void download(void *dst, Buf &src, size_t n) {
    Buf st = make_buf(n, true);
    cb_begin(); VkBufferCopy c{0, 0, n}; vkCmdCopyBuffer(D.cb, src.b, st.b, 1, &c); cmd_barrier(); cb_submit_wait();
    memcpy(dst, st.map, n); free_buf(st);
}
static void fill(Buf &b, uint32_t word) { cb_begin(); vkCmdFillBuffer(D.cb, b.b, 0, VK_WHOLE_SIZE, word); cmd_barrier(); cb_submit_wait(); }

/* ---- pipelines --------------------------------------------------------------------------- */
struct PC { uint64_t W[8], Y[8]; int32_t N[8], blk0[8]; uint64_t X; int32_t K, xs16, ps16, n, pack; };
struct PCpack { uint64_t y, o; int32_t E; };
static VkPipelineLayout g_layout, g_layout_pack;
static VkPipeline g_gemm[9][9];          /* [MR][G] */
static VkPipeline g_pack;
static std::string g_shader_dir = "shaders";
static std::vector<char> read_file(const std::string &p) {
    FILE *f = fopen(p.c_str(), "rb"); if (!f) { fprintf(stderr, "vkfield: cannot open %s\n", p.c_str()); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET); std::vector<char> v(n); if (fread(v.data(), 1, n, f) != (size_t)n) exit(1); fclose(f); return v;
}
static VkPipeline make_pipeline(const std::string &spv, VkPipelineLayout layout, bool subgroup32) {
    std::vector<char> code = read_file(spv);
    VkShaderModuleCreateInfo smi{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO}; smi.codeSize = code.size(); smi.pCode = (const uint32_t *)code.data();
    VkShaderModule mod; ck(vkCreateShaderModule(D.dev, &smi, nullptr, &mod), spv.c_str());
    VkPipelineShaderStageRequiredSubgroupSizeCreateInfo rs{VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_REQUIRED_SUBGROUP_SIZE_CREATE_INFO}; rs.requiredSubgroupSize = 32;
    VkComputePipelineCreateInfo ci{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};
    ci.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO; ci.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; ci.stage.module = mod; ci.stage.pName = "main";
    if (subgroup32) { ci.stage.pNext = &rs; ci.stage.flags = VK_PIPELINE_SHADER_STAGE_CREATE_REQUIRE_FULL_SUBGROUPS_BIT; }
    ci.layout = layout;
    VkPipeline p; ck(vkCreateComputePipelines(D.dev, VK_NULL_HANDLE, 1, &ci, nullptr, &p), spv.c_str());
    vkDestroyShaderModule(D.dev, mod, nullptr);
    return p;
}
static void init_pipelines() {
    VkPushConstantRange pr{VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PC)};
    VkPipelineLayoutCreateInfo li{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO}; li.pushConstantRangeCount = 1; li.pPushConstantRanges = &pr;
    ck(vkCreatePipelineLayout(D.dev, &li, nullptr, &g_layout), "layout");
    VkPushConstantRange pr2{VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PCpack)}; li.pPushConstantRanges = &pr2;
    ck(vkCreatePipelineLayout(D.dev, &li, nullptr, &g_layout_pack), "layout");
    const auto t0 = std::chrono::steady_clock::now();
    for (int mr = 1; mr <= 8; mr++) for (int g = 1; g <= 8; g <<= 1)
        g_gemm[mr][g] = make_pipeline(g_shader_dir + "/field_gemm_mr" + std::to_string(mr) + "_g" + std::to_string(g) + ".spv", g_layout, true);
    g_pack = make_pipeline(g_shader_dir + "/pack24.spv", g_layout_pack, false);
    printf("[vkfield] 33 pipelines built in %.2f s\n", std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
}

/* ---- the plan, as the CUDA worker plans it ----------------------------------------------- */
static int g_cus = 46;
struct Plan { int mr, g, blocks; PC pc; };
static Plan plan(const uint64_t *W, const uint64_t *Y, const int *N, int nn, int mr, int pack) {
    Plan pl; pl.mr = mr; pl.g = 1; pl.blocks = 0; memset(&pl.pc, 0, sizeof pl.pc);
    for (int g = 8; g >= 1; g >>= 1) {
        const int rpb = 4 * g; int blocks = 0;
        for (int i = 0; i < nn; i++) blocks += (N[i] + rpb - 1) / rpb;
        pl.g = g; pl.blocks = blocks;
        if (blocks >= g_cus || g == 1) break;
    }
    const int rpb = 4 * pl.g; int blocks = 0;
    for (int i = 0; i < 8; i++) {
        if (i < nn) { pl.pc.W[i] = W[i]; pl.pc.Y[i] = Y[i]; pl.pc.N[i] = N[i]; pl.pc.blk0[i] = blocks; blocks += (N[i] + rpb - 1) / rpb; }
        else { pl.pc.blk0[i] = 0x7fffffff; }
    }
    pl.pc.n = nn; pl.pc.pack = pack;
    return pl;
}
static void cmd_gemm(const Plan &pl, int K, uint64_t X, long long xstride, long long pstride) {
    PC pc = pl.pc; pc.X = X; pc.K = K; pc.xs16 = (int)(xstride >> 4); pc.ps16 = (int)(pstride >> 4);
    vkCmdBindPipeline(D.cb, VK_PIPELINE_BIND_POINT_COMPUTE, g_gemm[pl.mr][pl.g]);
    vkCmdPushConstants(D.cb, g_layout, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof pc, &pc);
    vkCmdDispatch(D.cb, (uint32_t)pl.blocks, 1, 1);
}
static void cmd_pack24(uint64_t y, uint64_t o, long long E) {
    PCpack pc{y, o, (int32_t)E};
    vkCmdBindPipeline(D.cb, VK_PIPELINE_BIND_POINT_COMPUTE, g_pack);
    vkCmdPushConstants(D.cb, g_layout_pack, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof pc, &pc);
    vkCmdDispatch(D.cb, (uint32_t)(((3 * E + 3) / 4 + 255) / 256), 1, 1);
}

/* ---- self-test: the worker's shapes, the worker's reference ------------------------------- */
static int32_t unpack24(const uint8_t *p) { const uint32_t v = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16); return (int32_t)(v << 8) >> 8; }
static void pack24_host(const int32_t *y, uint8_t *o, long long E) { for (long long i = 0; i < E; i++) { const int32_t v = y[i]; o[3*i] = (uint8_t)v; o[3*i+1] = (uint8_t)(v >> 8); o[3*i+2] = (uint8_t)(v >> 16); } }
static bool selftest_one(int K, int N, int m, int nn, uint64_t &seed, int pack = 0) {
    std::vector<int8_t> W((size_t)nn * N * K), X((size_t)3 * m * K);
    std::vector<int64_t> xr((size_t)m * K);
    auto rnd = [&]() { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; return seed; };
    for (auto &w : W) w = (int8_t)((int)(rnd() % 239) - 119);
    for (int i = 0; i < m * K; i++) { xr[i] = (int64_t)(rnd() % (uint64_t)SH_M_MOD); for (int p = 0; p < 3; p++) X[(size_t)p * m * K + i] = sh_residue(xr[i], sh_primes[p]); }
    std::vector<int32_t> ref((size_t)nn * m * N);
    for (int q = 0; q < nn; q++) for (int r = 0; r < m; r++) for (int j = 0; j < N; j++) {
        int64_t acc = 0; for (int k = 0; k < K; k++) acc += xr[(size_t)r * K + k] * W[((size_t)q * N + j) * K + k];
        ref[((size_t)q * m + r) * N + j] = (int32_t)sh_balanced(acc);
    }
    const size_t E = ref.size(), pbytes = ((3 * E + 3) / 4) * 4;
    Buf dW = make_buf(W.size(), false), dX = make_buf(X.size(), false), dY = make_buf(E * 4, false), dP = make_buf(pbytes, false);
    upload(dW, W.data(), W.size()); upload(dX, X.data(), X.size()); fill(dY, 0x7f7f7f7f); fill(dP, 0x7f7f7f7f);
    cb_begin();
    for (int row0 = 0; row0 < m; row0 += 8) {
        const int mr = std::min(m - row0, 8);
        uint64_t Ws[8], Ys[8]; int Ns[8];
        for (int q = 0; q < nn; q++) {
            Ws[q] = dW.addr + (uint64_t)q * N * K; Ns[q] = N;
            Ys[q] = pack == 1 ? dP.addr + 3 * (((uint64_t)q * m + row0) * N) : dY.addr + 4 * (((uint64_t)q * m + row0) * N);
        }
        const Plan pl = plan(Ws, Ys, Ns, nn, mr, pack == 1);
        cmd_gemm(pl, K, dX.addr + (uint64_t)row0 * K, K, (long long)m * K);
        cmd_barrier();
    }
    if (pack == 2) { cmd_pack24(dY.addr, dP.addr, (long long)E); cmd_barrier(); }
    cb_submit_wait();
    std::vector<int32_t> got(E); bool ok = true;
    if (pack) {
        std::vector<uint8_t> pk(pbytes); download(pk.data(), dP, pbytes);
        for (size_t i = 0; i < E; i++) got[i] = unpack24(pk.data() + 3 * i);
        std::vector<uint8_t> hp(3 * E); pack24_host(ref.data(), hp.data(), (long long)E);
        if (memcmp(hp.data(), pk.data(), 3 * E)) { fprintf(stderr, "[vkfield] SELFTEST FAILED K=%d N=%d m=%d nodes=%d pack=%d: host pack differs from the card's\n", K, N, m, nn, pack); ok = false; }
    } else download(got.data(), dY, E * 4);
    free_buf(dW); free_buf(dX); free_buf(dY); free_buf(dP);
    if (!ok) return false;
    for (size_t i = 0; i < E; i++) if (got[i] != ref[i]) { fprintf(stderr, "[vkfield] SELFTEST FAILED K=%d N=%d m=%d nodes=%d pack=%d at %zu: gpu %d ref %d\n", K, N, m, nn, pack, i, got[i], ref[i]); return false; }
    return true;
}
static bool selftest() {
    uint64_t seed = 0x9e3779b97f4a7c15ull; bool ok = true; int cases = 0;
    const int Ks[] = { 32, 96, 896, 2560, 4864 }, ms[] = { 1, 2, 3, 4, 5, 6, 7, 8 };
    for (int K : Ks) for (int m : ms) if (ok) { ok = selftest_one(K, 37, m, 1, seed); cases++; }
    if (ok) { ok = selftest_one(96, 1234, 1, 2, seed); cases++; }
    if (ok) { ok = selftest_one(96, 1234, 8, 3, seed); cases++; }
    if (ok) { ok = selftest_one(96, 4103, 3, 2, seed); cases++; }
    if (ok) { ok = selftest_one(96, 301, 2, 8, seed); cases++; }
    if (ok) { ok = selftest_one(96, 37, 11, 2, seed); cases++; }
    if (ok) { ok = selftest_one(32, 1, 7, 1, seed); cases++; }
    if (ok) { ok = selftest_one(96, 3, 6, 3, seed); cases++; }
    for (int pack = 1; pack <= 2 && ok; pack++) {
        ok = ok && selftest_one(896, 37, 1, 1, seed, pack); ok = ok && selftest_one(96, 1234, 3, 2, seed, pack);
        ok = ok && selftest_one(96, 4103, 8, 3, seed, pack); ok = ok && selftest_one(96, 301, 2, 8, seed, pack);
        ok = ok && selftest_one(96, 37, 11, 2, seed, pack); ok = ok && selftest_one(32, 1, 1, 1, seed, pack);
        ok = ok && selftest_one(32, 5, 1, 1, seed, pack); cases += 7;
    }
    printf("[vkfield] self-test: %s (%d shape cases, both reply forms)\n", ok ? "PASS, bit-exact against the int64 reference" : "FAIL", cases);
    return ok;
}

/* ---- throughput and latency, as the worker measures them ---------------------------------- */
static double measure_gmacs(int iters) {
    const int K = 4096, N = 4096, m = 8;
    Buf dW = make_buf((size_t)N * K, false), dX = make_buf((size_t)3 * m * K, false), dY = make_buf((size_t)m * N * 4, false);
    fill(dW, 0x01010101); fill(dX, 0x01010101);
    uint64_t W = dW.addr, Y = dY.addr; int Nn = N;
    const Plan pl = plan(&W, &Y, &Nn, 1, m, 0);
    auto run = [&](int n) { cb_begin(); for (int i = 0; i < n; i++) { cmd_gemm(pl, K, dX.addr, K, (long long)m * K); cmd_barrier(); } cb_submit_wait(); };
    run(3);
    const auto t0 = std::chrono::steady_clock::now(); run(iters);
    const double dt = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    free_buf(dW); free_buf(dX); free_buf(dY);
    return (double)m * K * N * iters / dt / 1e9;
}
static void measure_latency() {
    /* the 0.5B gate|up x2 decode exchange: two nodes, K = 896, N = 4864, m = 1 */
    const int K = 896, N = 4864, m = 1;
    Buf dW = make_buf((size_t)2 * N * K, false), dX = make_buf((size_t)3 * m * K, false), dY = make_buf((size_t)2 * m * N * 4, true);
    fill(dW, 0x01010101); fill(dX, 0x01010101);
    uint64_t W[2] = { dW.addr, dW.addr + (uint64_t)N * K }, Y[2] = { dY.addr, dY.addr + (uint64_t)m * N * 4 }; int Nn[2] = { N, N };
    const Plan pl = plan(W, Y, Nn, 2, m, 0);
    const int reps = 200; double best = 1e9, sum = 0;
    for (int i = 0; i < reps + 20; i++) {
        const auto t0 = std::chrono::steady_clock::now();
        cb_begin(); cmd_gemm(pl, K, dX.addr, K, (long long)m * K); cmd_barrier(); cb_submit_wait();
        const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
        if (i >= 20) { sum += us; best = std::min(best, us); }
    }
    printf("[vkfield] dispatch latency, 0.5B gate|up x2 m=1 (record+submit+fence, mapped reply): mean %.1f us, best %.1f us over %d\n", sum / reps, best, reps);
    /* The exchange path's form: the command buffer recorded once (the installed graph), one
     * submit per step. This is the per-step floor the worker will see. */
    vkResetCommandBuffer(D.cb, 0);
    { VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; ck(vkBeginCommandBuffer(D.cb, &bi), "begin"); }
    cmd_gemm(pl, K, dX.addr, K, (long long)m * K); cmd_barrier(); ck(vkEndCommandBuffer(D.cb), "end");
    best = 1e9; sum = 0;
    for (int i = 0; i < reps + 20; i++) {
        const auto t0 = std::chrono::steady_clock::now();
        VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO}; si.commandBufferCount = 1; si.pCommandBuffers = &D.cb;
        ck(vkResetFences(D.dev, 1, &D.fence), "reset fence"); ck(vkQueueSubmit(D.queue, 1, &si, D.fence), "submit");
        if (getenv("VKFIELD_SPIN")) { while (vkGetFenceStatus(D.dev, D.fence) == VK_NOT_READY) {} }
        else ck(vkWaitForFences(D.dev, 1, &D.fence, VK_TRUE, ~0ull), "wait");
        const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
        if (i >= 20) { sum += us; best = std::min(best, us); }
    }
    printf("[vkfield] same, pre-recorded command buffer (submit+%s only):                     mean %.1f us, best %.1f us over %d\n", getenv("VKFIELD_SPIN") ? "spin" : "fence", sum / reps, best, reps);
    free_buf(dW); free_buf(dX); free_buf(dY);
}

/* ---- contention stand-ins: the worker's flood and the owner's game ------------------------ */
static void flood(double seconds) {
    const int K = 4096, N = 4096, m = 8, L = 16;
    Buf dW = make_buf((size_t)N * K, false), dX = make_buf((size_t)3 * m * K, false), dY = make_buf((size_t)m * N * 4, false);
    fill(dW, 0x01010101); fill(dX, 0x01010101);
    uint64_t W = dW.addr, Y = dY.addr; int Nn = N; const Plan pl = plan(&W, &Y, &Nn, 1, m, 0);
    vkResetCommandBuffer(D.cb, 0);
    { VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; ck(vkBeginCommandBuffer(D.cb, &bi), "begin"); }
    for (int i = 0; i < L; i++) { cmd_gemm(pl, K, dX.addr, K, (long long)m * K); cmd_barrier(); }
    ck(vkEndCommandBuffer(D.cb), "end");
    const double mac = (double)m * K * N * L;
    const auto t0 = std::chrono::steady_clock::now(); auto tick = t0; double acc = 0, total = 0; int sec = 0;
    for (;;) {
        VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO}; si.commandBufferCount = 1; si.pCommandBuffers = &D.cb;
        ck(vkResetFences(D.dev, 1, &D.fence), "reset fence"); ck(vkQueueSubmit(D.queue, 1, &si, D.fence), "submit"); ck(vkWaitForFences(D.dev, 1, &D.fence, VK_TRUE, ~0ull), "wait");
        acc += mac; total += mac;
        const auto now = std::chrono::steady_clock::now();
        if (std::chrono::duration<double>(now - tick).count() >= 1.0) { printf("[vkfield] flood %-8s t=%2ds %6.0f G-MAC/s\n", D.prio_name.c_str(), ++sec, acc / std::chrono::duration<double>(now - tick).count() / 1e9); fflush(stdout); acc = 0; tick = now; }
        if (std::chrono::duration<double>(now - t0).count() >= seconds) break;
    }
    printf("[vkfield] flood %s: %.0f G-MAC/s over %.1f s\n", D.prio_name.c_str(), total / std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() / 1e9, seconds);
    free_buf(dW); free_buf(dX); free_buf(dY);
}
static void frames(double seconds, double frame_us, double fps, int launches, bool warmup) {
    const int K = 4096, N = 4096, m = 8;
    Buf dW = make_buf((size_t)N * K, false), dX = make_buf((size_t)3 * m * K, false), dY = make_buf((size_t)m * N * 4, false);
    fill(dW, 0x01010101); fill(dX, 0x01010101);
    uint64_t W = dW.addr, Y = dY.addr; int Nn = N; const Plan pl = plan(&W, &Y, &Nn, 1, m, 0);
    auto record = [&](int L) {
        vkResetCommandBuffer(D.cb, 0);
        VkCommandBufferBeginInfo bi{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO}; ck(vkBeginCommandBuffer(D.cb, &bi), "begin");
        for (int i = 0; i < L; i++) { cmd_gemm(pl, K, dX.addr, K, (long long)m * K); cmd_barrier(); }
        ck(vkEndCommandBuffer(D.cb), "end");
    };
    auto submit_us = [&]() {
        const auto t0 = std::chrono::steady_clock::now();
        VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO}; si.commandBufferCount = 1; si.pCommandBuffers = &D.cb;
        ck(vkResetFences(D.dev, 1, &D.fence), "reset fence"); ck(vkQueueSubmit(D.queue, 1, &si, D.fence), "submit"); ck(vkWaitForFences(D.dev, 1, &D.fence, VK_TRUE, ~0ull), "wait");
        return std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - t0).count();
    };
    /* calibrate on whatever the card is doing now: the caller starts the game first, alone */
    double per = 1e9, idle = 0;
    if (warmup) { record(16); for (int i = 0; i < 3; i++) submit_us(); for (int i = 0; i < 10; i++) per = std::min(per, submit_us() / 16); }
    int L = launches > 0 ? launches : std::max(1, (int)(frame_us / per)); record(L);   /* --frame-launches: the count calibrated on the idle card, for a contended run */
    if (warmup) { idle = 1e9; for (int i = 0; i < 10; i++) idle = std::min(idle, submit_us()); }   /* --no-warmup: no back-to-back burst before the paced frames */
    printf("[vkfield] frames %s: %d launches per frame = %.0f us on the idle card, %.0f fps (%.0f us budget)\n", D.prio_name.c_str(), L, idle, fps, 1e6 / fps); fflush(stdout);
    const auto period = std::chrono::duration<double, std::micro>(1e6 / fps);
    std::vector<double> ft; auto next = std::chrono::steady_clock::now(); const auto t0 = next;
    while (std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count() < seconds) {
        ft.push_back(submit_us());
        next += std::chrono::duration_cast<std::chrono::steady_clock::duration>(period);
        const auto now = std::chrono::steady_clock::now(); if (next < now) next = now; else std::this_thread::sleep_until(next);
    }
    std::vector<double> s = ft; std::sort(s.begin(), s.end()); double sum = 0; int over = 0, over2 = 0; const double budget = 1e6 / fps;
    for (double v : ft) { sum += v; if (v > budget) over++; if (v > 2 * budget) over2++; }
    printf("[vkfield] frames %s: %zu frames, GPU time per frame mean %.0f us, p50 %.0f, p99 %.0f, max %.0f; %d over the %.0f us budget, %d over twice it\n",
           D.prio_name.c_str(), ft.size(), sum / ft.size(), s[s.size() / 2], s[(size_t)(s.size() * 0.99)], s.back(), over, budget, over2);
    free_buf(dW); free_buf(dX); free_buf(dY);
}

int main(int argc, char **argv) {
    int want = 0, iters = 20; bool st = true; VkQueueGlobalPriority prio = (VkQueueGlobalPriority)0; bool gfx = false;
    double flood_s = 0, frames_s = 0, frame_us = 6000, fps = 60; int frame_launches = 0; bool warmup = true; const char *gpu_class = nullptr;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--device") && i + 1 < argc) want = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--cus") && i + 1 < argc) g_cus = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--shaders") && i + 1 < argc) g_shader_dir = argv[++i];
        else if (!strcmp(argv[i], "--iters") && i + 1 < argc) iters = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--no-selftest")) st = false;
        else if (!strcmp(argv[i], "--priority") && i + 1 < argc) { prio = prio_parse(argv[++i]); if (!prio) { fprintf(stderr, "vkfield: --priority low|medium|high|realtime\n"); return 2; } }
        else if (!strcmp(argv[i], "--gfx-queue")) gfx = true;
        else if (!strcmp(argv[i], "--gpu-class") && i + 1 < argc) gpu_class = argv[++i];
        else if (!strcmp(argv[i], "--flood") && i + 1 < argc) flood_s = atof(argv[++i]);
        else if (!strcmp(argv[i], "--frames") && i + 1 < argc) frames_s = atof(argv[++i]);
        else if (!strcmp(argv[i], "--frame-us") && i + 1 < argc) frame_us = atof(argv[++i]);
        else if (!strcmp(argv[i], "--fps") && i + 1 < argc) fps = atof(argv[++i]);
        else if (!strcmp(argv[i], "--frame-launches") && i + 1 < argc) frame_launches = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--no-warmup")) warmup = false;
        else { fprintf(stderr, "usage: vkfield [--device N] [--cus N] [--shaders DIR] [--iters N] [--no-selftest] [--priority low|medium|high|realtime] [--gpu-class idle|below|normal|above|high|realtime] [--gfx-queue] [--flood SEC] [--frames SEC [--frame-us US] [--fps N] [--frame-launches L] [--no-warmup]]\n"); return 2; }
    }
    if (gpu_class) set_gpu_class(gpu_class);
    load_loader(); init_device(want, prio, gfx);
    if (!g_gpu_class.empty()) D.prio_name += "+" + g_gpu_class;
    if (getenv("VKFIELD_ALLOC_PROBE")) {   /* how much device-local memory can ONE process take, and what does the budget say */
        for (uint32_t i = 0; i < D.mem.memoryHeapCount; i++) printf("[vkfield] heap %u: %.1f GiB%s\n", i, D.mem.memoryHeaps[i].size / 1073741824.0, (D.mem.memoryHeaps[i].flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) ? " device-local" : "");
        std::vector<Buf> held; size_t total = 0;
        for (;;) {
            VkBufferCreateInfo bi{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO}; bi.size = 256u << 20; bi.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT;
            Buf x; if (vkCreateBuffer(D.dev, &bi, nullptr, &x.b) != VK_SUCCESS) break;
            VkMemoryRequirements mr; vkGetBufferMemoryRequirements(D.dev, x.b, &mr);
            VkMemoryAllocateFlagsInfo fl{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO}; fl.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
            VkMemoryAllocateInfo mai{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO}; mai.pNext = &fl; mai.allocationSize = mr.size; mai.memoryTypeIndex = mem_type(mr.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT);
            VkResult r = vkAllocateMemory(D.dev, &mai, nullptr, &x.m);
            if (r != VK_SUCCESS) { printf("[vkfield] allocation %zu failed with %d after %.1f GiB\n", held.size() + 1, (int)r, total / 1073741824.0); vkDestroyBuffer(D.dev, x.b, nullptr); break; }
            vkBindBufferMemory(D.dev, x.b, x.m, 0); held.push_back(x); total += mr.size;
            if (total > (64ull << 30)) break;
        }
        printf("[vkfield] one process holds %.1f GiB of device-local memory in %zu blocks of 256 MiB\n", total / 1073741824.0, held.size());
        for (auto &x : held) { vkDestroyBuffer(D.dev, x.b, nullptr); vkFreeMemory(D.dev, x.m, nullptr); }
        return 0;
    }
    printf("[vkfield] %s: subgroup %u..%u (using 32), packed int8 dot accelerated: %s, plan threshold %d blocks; queue family %u%s at global priority %s (family offers %s)\n",
           D.name.c_str(), D.subgroup_min, D.subgroup_max, D.dot_accel ? "yes" : "NO", g_cus, D.qf, gfx ? " (graphics)" : "", D.prio_name.c_str(), D.prio_offered.c_str());
    init_pipelines();
    if (st && !selftest()) return 1;
    if (flood_s > 0) { flood(flood_s); vkDeviceWaitIdle(D.dev); return 0; }
    if (frames_s > 0) { if (!warmup && frame_launches <= 0) { fprintf(stderr, "vkfield: --no-warmup needs --frame-launches L\n"); return 2; } frames(frames_s, frame_us, fps, frame_launches, warmup); vkDeviceWaitIdle(D.dev); return 0; }
    printf("[vkfield] field GEMM throughput %.0f G-MAC/s (K = N = 4096, m = 8, %d launches, host-timed as the worker does)\n", measure_gmacs(iters), iters);
    measure_latency();
    vkDeviceWaitIdle(D.dev);
    return 0;
}
