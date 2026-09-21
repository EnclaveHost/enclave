/* vkdev.h -- the CUDA runtime subset the shielded worker calls, on Vulkan.
 *
 * worker.cu compiles as plain C++ against this header (-DSH_VULKAN): every cuda* symbol it uses
 * exists here with the same signature and the same meaning, so the protocol, admission rules,
 * ledger and graph cache do not change. What differs underneath:
 *
 *   device pointers   are VkDeviceAddress values carried in pointer-typed variables (the worker
 *                     does arithmetic on them, which is exactly what buffer device addresses allow);
 *                     each allocation is a sub-range of an arena block (one VkBuffer per block).
 *   the pool          cudaMallocAsync/Free, the reserved figure, the release threshold and TrimTo
 *                     are the arena's blocks: a block stays after its last free while the threshold
 *                     says so, TrimTo releases empty blocks above the ledger. claim_reservation()
 *                     therefore works unchanged: its holds grow the arena by whole blocks.
 *   streams           lazy-submit command buffers: work is recorded as it is issued and submitted
 *                     at cudaStreamSynchronize (or before a synchronous copy needs it). Inside
 *                     cudaStreamBeginCapture/EndCapture the same recording becomes the graph:
 *                     a command buffer kept for replay, one vkQueueSubmit per cudaGraphLaunch.
 *   pinned memory     cudaHostAlloc = a host-visible, host-coherent buffer with a device address;
 *                     cudaHostAllocMapped hands the kernel that address to write the reply into.
 *   cudaMemGetInfo    VK_EXT_memory_budget.
 *   kernels           vk_launch_gemm / vk_launch_pack24 record dispatches of the SPIR-V modules in
 *                     shaders/ (32 field_gemm variants + pack24), push constants = the GemmTab.
 */
#pragma once
#include <cstdint>
#include <cstddef>

typedef enum {
    cudaSuccess = 0, cudaErrorMemoryAllocation = 2, cudaErrorInvalidValue = 1, cudaErrorIllegalAddress = 700,
    cudaErrorLaunchFailure = 719, cudaErrorAssert = 710, cudaErrorHardwareStackError = 714, cudaErrorIllegalInstruction = 715,
    cudaErrorMisalignedAddress = 716, cudaErrorInvalidAddressSpace = 717, cudaErrorInvalidPc = 718, cudaErrorECCUncorrectable = 214,
    cudaErrorMpsRpcFailure = 806, cudaErrorMpsServerNotReady = 807, cudaErrorMpsConnectionFailed = 805, cudaErrorUnknown = 999,
    cudaErrorDeviceUninitialized = 4, cudaErrorNoDevice = 100, cudaErrorStreamCaptureInvalidated = 901
} cudaError_t;
typedef enum { cudaMemcpyHostToDevice = 1, cudaMemcpyDeviceToHost = 2, cudaMemcpyDeviceToDevice = 3 } cudaMemcpyKind;
typedef enum { cudaStreamCaptureModeGlobal = 0, cudaStreamCaptureModeThreadLocal = 1, cudaStreamCaptureModeRelaxed = 2 } cudaStreamCaptureMode;
typedef enum { cudaMemPoolAttrReleaseThreshold = 4, cudaMemPoolAttrReservedMemCurrent = 5 } cudaMemPoolAttr;
enum { cudaStreamNonBlocking = 1, cudaHostAllocDefault = 0, cudaHostAllocMapped = 2, cudaDeviceScheduleSpin = 1, cudaDeviceMapHost = 8,
       cudaEventRecordExternal = 1 };
typedef unsigned long long cuuint64_t;

struct VkStreamImpl;  typedef VkStreamImpl *cudaStream_t;
struct VkGraphImpl;   typedef VkGraphImpl *cudaGraph_t;   typedef VkGraphImpl *cudaGraphExec_t;
struct VkEventImpl;   typedef VkEventImpl *cudaEvent_t;
struct VkPoolImpl;    typedef VkPoolImpl *cudaMemPool_t;
struct cudaDeviceProp { char name[256]; size_t totalGlobalMem; int multiProcessorCount; int clockRate; int major, minor; };

cudaError_t cudaSetDevice(int);
cudaError_t cudaSetDeviceFlags(unsigned);
cudaError_t cudaGetDeviceCount(int *);
cudaError_t cudaGetDeviceProperties(cudaDeviceProp *, int);
cudaError_t cudaDeviceSynchronize();
cudaError_t cudaGetLastError();
const char *cudaGetErrorString(cudaError_t);
cudaError_t cudaMemGetInfo(size_t *free_bytes, size_t *total_bytes);

cudaError_t cudaStreamCreateWithFlags(cudaStream_t *, unsigned);
cudaError_t cudaStreamDestroy(cudaStream_t);
cudaError_t cudaStreamSynchronize(cudaStream_t);          /* 0 = the immediate stream */
cudaError_t cudaStreamBeginCapture(cudaStream_t, cudaStreamCaptureMode);
cudaError_t cudaStreamEndCapture(cudaStream_t, cudaGraph_t *);
cudaError_t cudaGraphInstantiate(cudaGraphExec_t *, cudaGraph_t, unsigned long long flags);
cudaError_t cudaGraphDestroy(cudaGraph_t);
cudaError_t cudaGraphExecDestroy(cudaGraphExec_t);
cudaError_t cudaGraphLaunch(cudaGraphExec_t, cudaStream_t);

cudaError_t cudaMallocAsync(void **, size_t, cudaStream_t);
cudaError_t cudaFreeAsync(void *, cudaStream_t);
cudaError_t cudaDeviceGetDefaultMemPool(cudaMemPool_t *, int);
cudaError_t cudaMemPoolGetAttribute(cudaMemPool_t, cudaMemPoolAttr, void *);
cudaError_t cudaMemPoolSetAttribute(cudaMemPool_t, cudaMemPoolAttr, void *);
cudaError_t cudaMemPoolTrimTo(cudaMemPool_t, size_t);
cudaError_t cudaMemcpy(void *dst, const void *src, size_t n, cudaMemcpyKind);
cudaError_t cudaMemcpyAsync(void *dst, const void *src, size_t n, cudaMemcpyKind, cudaStream_t);
cudaError_t cudaMemset(void *dst, int byte, size_t n);
cudaError_t cudaHostAlloc(void **, size_t, unsigned flags);
cudaError_t cudaFreeHost(void *);
cudaError_t cudaHostGetDevicePointer(void **dev, void *host, unsigned);

cudaError_t cudaEventCreate(cudaEvent_t *);
cudaError_t cudaEventDestroy(cudaEvent_t);
cudaError_t cudaEventRecord(cudaEvent_t, cudaStream_t);
cudaError_t cudaEventRecordWithFlags(cudaEvent_t, cudaStream_t, unsigned);
cudaError_t cudaEventSynchronize(cudaEvent_t);
cudaError_t cudaEventElapsedTime(float *, cudaEvent_t, cudaEvent_t);

/* The worker's kernels. GemmTab is the launch table worker.cu builds: 8 weight pointers, 8
 * output pointers, N, first block, n, pack -- it goes to the shader as push constants. */
static const int GEMM_TAB_NODES = 8;
struct GemmTab {
    const int8_t *W[GEMM_TAB_NODES];
    uint8_t *Y[GEMM_TAB_NODES];
    int N[GEMM_TAB_NODES];
    int blk0[GEMM_TAB_NODES];
    int n;
    int pack;
};
void vk_launch_gemm(int mr, int g, const GemmTab &tab, int nblocks, int K, const int8_t *X, long long xstride, long long pstride, cudaStream_t s);
void vk_launch_pack24(const int32_t *y, uint8_t *o, long long E, cudaStream_t s);
/* Which device (index among Vulkan physical devices, env SHIELDED_VK_DEVICE) and where the SPIR-V
 * lives (env SHIELDED_VK_SHADERS, default: shaders/ beside the binary). Called once from main. */
void vk_init(const char *argv0);
const char *vk_device_name();
const char *vk_queue_priority();  /* low|medium|high|realtime|default: what the rented queue got (SHIELDED_VK_PRIORITY) */
int vk_cu_count();            /* the planner's block threshold: SMs / CUs when the driver says, else a default */
