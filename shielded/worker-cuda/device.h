/* device.h -- the worker's device layer: ONE source, three vendors.
 *
 *   CUDA  (NVIDIA)   : this header is a pass-through; nothing changes.
 *   HIP   (AMD ROCm) : compiled with -x hip; every cuda* symbol the worker uses is
 *                      mapped to its hip* twin below (the ggml-cuda/vendors/hip.h
 *                      pattern), and the three device intrinsics that differ get
 *                      shims: dp4a, shfl_xor, WARP_SIZE.
 *   SYCL  (Intel)    : a different programming model; see ../worker-sycl/ which shares
 *                      the host protocol code through backend.h, not this header.
 *
 * The kernels are written for 32-lane logical warps in 256-thread blocks. On RDNA
 * (gfx10/gfx11) HIP runs wave32 and this is literal. On CDNA (gfx9) a wave is 64 lanes;
 * shuffles carry width = 32 so every reduction stays inside a 32-lane half and the
 * kernel's lane/warp arithmetic (threadIdx.x & 31, >> 5) keeps meaning "logical warp".
 * Occupancy and the launch bound then describe waves, not warps, which is a tuning
 * matter, not a correctness one.
 *
 * Numerics: dp4a is a signed int8x4 dot product accumulated into int32. The AMD
 * builtins take (a, b, c, clamp) with clamp = false for wrapping arithmetic, which is
 * what the field kernel relies on (accumulators stay below 2^31 by construction, see
 * the range note above crt3). A saturating fallback would change results. */
#pragma once

#if defined(__HIP_PLATFORM_AMD__) || defined(__HIP__)
#define SH_HIP 1
#include <hip/hip_runtime.h>
/* The worker guards host-only code with __CUDA_ARCH__; give the HIP device pass the same
 * signal (the ggml convention, an arch no NVIDIA part has). */
#if defined(__HIP_DEVICE_COMPILE__) && !defined(__CUDA_ARCH__)
#define __CUDA_ARCH__ 1300
#endif

#define cudaDeviceGetDefaultMemPool      hipDeviceGetDefaultMemPool
#define cudaDeviceMapHost                hipDeviceMapHost
#define cudaDeviceProp                   hipDeviceProp_t
#define cudaDeviceScheduleSpin           hipDeviceScheduleSpin
#define cudaDeviceSynchronize            hipDeviceSynchronize
#define cudaError_t                      hipError_t
#define cudaEventCreate                  hipEventCreate
#define cudaEventDestroy                 hipEventDestroy
#define cudaEventElapsedTime             hipEventElapsedTime
#define cudaEventRecord                  hipEventRecord
#define cudaEventSynchronize             hipEventSynchronize
#define cudaEvent_t                      hipEvent_t
#define cudaFreeAsync                    hipFreeAsync
#define cudaFreeHost                     hipHostFree
#define cudaGetDeviceCount               hipGetDeviceCount
#define cudaGetDeviceProperties          hipGetDeviceProperties
#define cudaGetErrorString               hipGetErrorString
#define cudaGetLastError                 hipGetLastError
#define cudaGraphDestroy                 hipGraphDestroy
#define cudaGraphExecDestroy             hipGraphExecDestroy
#define cudaGraphExec_t                  hipGraphExec_t
#define cudaGraphLaunch                  hipGraphLaunch
#define cudaGraph_t                      hipGraph_t
#define cudaHostAlloc                    hipHostMalloc
#define cudaHostAllocDefault             hipHostMallocDefault
#define cudaHostAllocMapped              hipHostMallocMapped
#define cudaHostGetDevicePointer         hipHostGetDevicePointer
#define cudaMallocAsync                  hipMallocAsync
#define cudaMemcpy                       hipMemcpy
#define cudaMemcpyAsync                  hipMemcpyAsync
#define cudaMemcpyDeviceToHost           hipMemcpyDeviceToHost
#define cudaMemcpyHostToDevice           hipMemcpyHostToDevice
#define cudaMemGetInfo                   hipMemGetInfo
#define cudaMemPoolAttrReleaseThreshold  hipMemPoolAttrReleaseThreshold
#define cudaMemPoolAttrReservedMemCurrent hipMemPoolAttrReservedMemCurrent
#define cudaMemPoolGetAttribute          hipMemPoolGetAttribute
#define cudaMemPoolSetAttribute          hipMemPoolSetAttribute
#define cudaMemPool_t                    hipMemPool_t
#define cudaMemPoolTrimTo                hipMemPoolTrimTo
#define cudaMemset                       hipMemset
#define cudaSetDevice                    hipSetDevice
#define cudaSetDeviceFlags               hipSetDeviceFlags
#define cudaStreamBeginCapture           hipStreamBeginCapture
#define cudaStreamCaptureModeThreadLocal hipStreamCaptureModeThreadLocal
#define cudaStreamCreateWithFlags        hipStreamCreateWithFlags
#define cudaStreamDestroy                hipStreamDestroy
#define cudaStreamEndCapture             hipStreamEndCapture
#define cudaStreamNonBlocking            hipStreamNonBlocking
#define cudaStreamSynchronize            hipStreamSynchronize
#define cudaStream_t                     hipStream_t
#define cudaSuccess                      hipSuccess
typedef unsigned long long cuuint64_t;

/* A broken context kills the process (the worker restarts clean); everything else is a refused
 * request. HIP has fewer distinct sticky codes than CUDA, and no MPS. */
static inline bool sh_fatal_error(hipError_t e) {
    switch (e) {
        case hipErrorIllegalAddress: case hipErrorLaunchFailure: case hipErrorAssert:
        case hipErrorECCNotCorrectable: case hipErrorUnknown: case hipErrorDeinitialized:
            return true;
        default: return false;
    }
}

/* External events inside a captured graph mark the profile's timestamps; HIP grew
 * hipEventRecordWithFlags + hipEventRecordExternal in ROCm 6.x. Older runtimes get a
 * plain record, which the capture then owns -- the profile is then absent, nothing else. */
#include <hip/hip_version.h>
#if HIP_VERSION_MAJOR > 6 || (HIP_VERSION_MAJOR == 6 && HIP_VERSION_MINOR >= 4)
#define cudaEventRecordExternal          hipEventRecordExternal
#define cudaEventRecordWithFlags         hipEventRecordWithFlags
#else
#define cudaEventRecordExternal          0
#define cudaEventRecordWithFlags(ev, st, fl) hipEventRecord((ev), (st))
#endif
/* HIP kept CUDA 11's five-argument instantiate; the worker uses CUDA 12's three. */
#define cudaGraphInstantiate(exec, graph, flags) hipGraphInstantiate((exec), (graph), nullptr, nullptr, 0)

#define WARP_SIZE 32
/* Declared for both compilation passes (clang parses device code in the host pass too);
 * the arch macros below are only defined in the device pass, so the host pass sees the
 * plain fallback bodies and never a target builtin. */
__device__ __forceinline__ int shfl_xor(int v, int mask) { return __shfl_xor(v, mask, WARP_SIZE); }
/* Signed int8x4 dot product with int32 accumulate, wrapping (no clamp).
 * gfx908/90a/94x (CDNA)  : v_dot4_i32_i8    -> __builtin_amdgcn_sdot4
 * gfx11xx (RDNA3)        : v_dot4_i32_iu8   -> __builtin_amdgcn_sudot4 (signedness flags per operand)
 * gfx103x (RDNA2)        : v_dot4_i32_i8    -> __builtin_amdgcn_sdot4
 * anything else          : four multiplies, exact and slow. */
__device__ __forceinline__ int dp4a(int a, int b, int c) {
#if defined(__gfx11__) || defined(__gfx1100__) || defined(__gfx1101__) || defined(__gfx1102__) || defined(__gfx1103__) || defined(__gfx1150__) || defined(__gfx1151__) || defined(__gfx12__)
    return __builtin_amdgcn_sudot4(true, a, true, b, c, false);
#elif defined(__gfx908__) || defined(__gfx90a__) || defined(__gfx940__) || defined(__gfx941__) || defined(__gfx942__) || defined(__gfx950__) || defined(__gfx1030__) || defined(__gfx1031__) || defined(__gfx1032__) || defined(__gfx1033__) || defined(__gfx1034__) || defined(__gfx1035__) || defined(__gfx1036__)
    return __builtin_amdgcn_sdot4(a, b, c, false);
#else
    const int8_t *pa = (const int8_t *)&a, *pb = (const int8_t *)&b;
    return c + pa[0] * pb[0] + pa[1] * pb[1] + pa[2] * pb[2] + pa[3] * pb[3];
#endif
}

#else  /* ---- CUDA ---- */
#include <cuda_runtime.h>
static inline bool sh_fatal_error(cudaError_t e) {
    switch (e) {
        case cudaErrorIllegalAddress: case cudaErrorLaunchFailure: case cudaErrorAssert:
        case cudaErrorHardwareStackError: case cudaErrorIllegalInstruction:
        case cudaErrorMisalignedAddress: case cudaErrorInvalidAddressSpace:
        case cudaErrorInvalidPc: case cudaErrorECCUncorrectable: case cudaErrorMpsRpcFailure:
        case cudaErrorMpsServerNotReady: case cudaErrorMpsConnectionFailed:
        case cudaErrorUnknown: case cudaErrorDeviceUninitialized:
            return true;
        default: return false;
    }
}
#define WARP_SIZE 32
__device__ __forceinline__ int shfl_xor(int v, int mask) { return __shfl_xor_sync(0xffffffffu, v, mask); }
__device__ __forceinline__ int dp4a(int a, int b, int c) { return __dp4a(a, b, c); }
#endif
