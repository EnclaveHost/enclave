package host.enclave.anchor.avf;

/* The phone's CPU and memory as the pVM CPU tier sizes itself from them (PVM-CPU.md, Devices). No device name is read:
 * a Pixel 10 and a Pixel 11 get their thread count and VM memory from what the kernel reports, and admission is decided by
 * the relay from evidence, never here.
 *   threads  the cores whose cpu_capacity is at least half the largest (on a Tensor G5: the five A725s at 824 and the X4 at
 *            1024, not the two A520s at 207 -> 6, the measured default). The little cores drag every parallel section.
 *   VM mem   7,168 MiB (the measured instance) or RAM minus 8 GiB for Android, whichever is smaller; a phone whose RAM
 *            leaves the VM less than the model plus 1.5 GiB of working memory is refused with that reason. */
final class DeviceProfile {
    static final int MEM_CAP_MIB = 7168, ANDROID_RESERVE_MIB = 8192, WORKING_MIB = 1536;
    private DeviceProfile() {}

    static int[] capacities() {
        java.util.List<Integer> caps = new java.util.ArrayList<>();
        for (int c = 0; c < 64; c++) {
            java.io.File f = new java.io.File("/sys/devices/system/cpu/cpu" + c + "/cpu_capacity");
            if (!f.exists()) { if (c > 0) break; else continue; }
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader(f))) { caps.add(Integer.parseInt(r.readLine().trim())); }
            catch (Exception e) { caps.add(-1); }
        }
        int[] out = new int[caps.size()]; for (int i = 0; i < out.length; i++) out[i] = caps.get(i); return out;
    }
    /** Cores at >= half the largest capacity; 0 when the kernel does not report capacities (the caller keeps its default). */
    static int bigCores(int[] caps) {
        int max = 0; for (int c : caps) max = Math.max(max, c);
        if (max <= 0) return 0;
        int n = 0; for (int c : caps) if (c * 2 >= max) n++;
        return n;
    }
    static long totalMib() {
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.FileReader("/proc/meminfo"))) {
            for (String l; (l = r.readLine()) != null; ) if (l.startsWith("MemTotal:")) return Long.parseLong(l.replaceAll("[^0-9]", "")) / 1024;
        } catch (Exception ignored) { }
        return 0;
    }
    static int vmMemMib(long totalMib) { return (int) Math.max(0, Math.min(MEM_CAP_MIB, totalMib - ANDROID_RESERVE_MIB)); }
    /** Why this phone cannot hold the model in a VM, or null. */
    static String memRefusal(long vmMib, long modelBytes) {
        final long need = (modelBytes >> 20) + WORKING_MIB;
        return vmMib >= need ? null : "this phone's RAM leaves the VM " + vmMib + " MiB; the model needs " + need + " MiB (" + (modelBytes >> 20) + " + " + WORKING_MIB + " working)";
    }
}
