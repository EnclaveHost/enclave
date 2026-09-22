<!-- DRAFT -- not posted. Review before sending from SteveDeFacto on google-ai-edge/LiteRT#10081.
     Deliberately contains NO numbers derived from the Tensor SDK (terms 4.8 / 4.17 / 4.18): no compile
     sizes, no dispatch or bandwidth timings. Only AOSP source and what any adb shell can see. -->

Following up with what we have established since filing, in case it helps route this.

**The gap is not the kernel.** We had assumed the blocker for an app-launched pVM owning an accelerator
was the 6.6 host kernel, and that the android16-6.12 VFIO/pvIOMMU work would open it. Reading
`packages/modules/Virtualization`, on both `android17-release` and `main`,
`libs/framework-virtualization/.../VirtualMachineConfig.java` writes

    config.devices = AssignedDevices.devices(EMPTY_STRING_ARRAY);
    customConfig.devices = EMPTY_STRING_ARRAY;

unconditionally, with no setter on the Builder. So an app-launched pVM cannot request a device at any
version in the tree, whatever kernel is underneath. `docs/device_assignment.md` agrees ("We don't support
client API yet"). A newer kernel does not change this for a third-party app.

**The capability exists first-party.** On a Pixel 10 Pro XL (mustang, CP2A.260805.005),
`/system/etc/init/aisealhostservice.rc` describes AiSeal as hosting "performance sensitive services like
AppSearch or AI inference", behind `service.aiseal.enable` (its own `aiseal_prop` SELinux type) and a
system `aiseal_host` AIDL. So inference inside a Google pVM is a designed path; the question is only
whether any part of it will be reachable by third parties.

**Why it matters for this use case.** Our design keeps every secret (prompt, KV cache, keys, sampling)
inside an app-launched pVM and offloads the linear layers to the NPU with one-time additive masks,
since the NPU sits outside the trust boundary. Task quality under masking matches the unmasked in-pVM
baseline on our evaluation set. Throughput is where it fails, and structurally so: a serial transformer
needs the accelerator several times per layer because the nonlinearities cannot run on masked data, so
every token pays many boundary crossings. No masking scheme we know of avoids that. The only design that
reaches interactive rates is running the whole graph on an accelerator that is itself inside the
boundary -- which is exactly what an assignable TPU context, or AiSeal-hosted inference, would provide.

**The concrete asks, narrowed:**

1. Is there a planned third-party path to assign an accelerator context to an app-launched pVM
   (a client API over `AssignedDevices`, gated however you see fit)?
2. Or, alternatively: will AiSeal-hosted inference be reachable from a third-party pVM over an attested
   channel, so that data never leaves a protected VM?
3. Is Tensor G5 in scope for either, or is this Pixel 11 onward?

Even a "not planned" answer would let us stop designing around it.
