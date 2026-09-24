package host.enclave.anchor.avf;
/* host test for DeviceProfile's pure sizing rules (PVM-CPU.md, Devices): threads from cpu_capacity, VM memory from RAM, the refusal */
public final class DeviceProfileTest {
    static int checks = 0, failed = 0;
    static void expect(boolean ok, String what) { checks++; if (!ok) { failed++; System.err.println("FAIL " + what); } }
    public static void main(String[] a) {
        expect(DeviceProfile.bigCores(new int[] { 207, 207, 824, 824, 824, 825, 825, 1024 }) == 6, "Tensor G5 (Pixel 10): 5 A725 + X4 = 6, the measured default");
        expect(DeviceProfile.bigCores(new int[] { 260, 260, 870, 870, 870, 870, 870, 1024 }) == 6, "another 2+5+1 layout: 6");
        expect(DeviceProfile.bigCores(new int[] { 400, 400, 400, 400, 1024, 1024, 1024, 1024 }) == 4, "a 4+4 layout: the 4 big cores");
        expect(DeviceProfile.bigCores(new int[] { 1024, 1024, 1024, 1024 }) == 4, "all equal: all of them");
        expect(DeviceProfile.bigCores(new int[] {}) == 0, "no capacities reported: 0 (the caller keeps its default)");
        expect(DeviceProfile.bigCores(new int[] { -1, -1 }) == 0, "unreadable capacities: 0");
        expect(DeviceProfile.vmMemMib(15575) == 7168, "16 GB phone (Pixel 10 Pro XL): the measured 7,168 MiB");
        expect(DeviceProfile.vmMemMib(11800) == 3608, "12 GB phone: RAM minus 8 GiB");
        expect(DeviceProfile.vmMemMib(7000) == 0, "8 GB phone: nothing left for a VM");
        expect(DeviceProfile.memRefusal(7168, 3360161216L) == null, "E2B Q4_0 fits in 7,168 MiB");
        final String r = DeviceProfile.memRefusal(3608, 3360161216L);
        expect(r != null && r.contains("3608") && r.contains("4740"), "E2B Q4_0 refused in 3,608 MiB, naming both numbers");
        System.out.println("{\"status\":\"" + (failed == 0 ? "PASS" : "FAIL") + "\",\"executed_checks\":" + checks + "}");
        System.exit(failed == 0 ? 0 : 1);
    }
}
