package host.enclave.anchor.avf;

/* ArtifactProfile (host/app): what the app sends before RUN for a preparation, pinned byte for byte. Prints {"status","executed_checks",
 * "preamble_profile","preamble_plain"}; the Node wrapper feeds those preamble lines to the VM parser fixture (anchor-prepare.c --wire). */
public final class ArtifactProfileTest {
    static int checks = 0, failed = 0;
    static void check(boolean c, String what) { checks++; if (!c) { failed++; System.err.println("FAIL " + what); } }
    static String json(String s) { return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n"); }
    public static void main(String[] a) {
        check(ArtifactProfile.requested(null) == 0 && ArtifactProfile.requested("") == 0, "absent = 0");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=1") == 1, "=1");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=0") == 0, "=0");
        check(ArtifactProfile.requested("SHIELDED_LOCAL_SITES=token_embd.weight,ANCHOR_ARTIFACT_PROFILE=1,ANCHOR_ARTIFACT_WAIT_S=30") == 1, "=1 among other knobs");
        check(ArtifactProfile.requested("SHIELDED_LOCAL_SITES=token_embd.weight") == 0, "other knobs only = 0");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=2") < 0, "=2 malformed");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=") < 0, "empty value malformed");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=1,ANCHOR_ARTIFACT_PROFILE=1") < 0, "repeated malformed");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=1,ANCHOR_ARTIFACT_PROFILE=0") < 0, "repeated (conflicting) malformed");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=01") < 0 && ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE= 1") < 0 && ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE=1 ") < 0, "non-canonical values malformed");
        check(ArtifactProfile.requested("ANCHOR_ARTIFACT_PROFILE") < 0 && ArtifactProfile.requested("=1") < 0 && ArtifactProfile.requested(",") < 0 && ArtifactProfile.requested("A=1,") < 0, "entries without K=V malformed");
        check(ArtifactProfile.requested("anchor_artifact_profile=1") == 0 && ArtifactProfile.requested("XANCHOR_ARTIFACT_PROFILE=1") == 0, "other keys are not this key");
        String on = ArtifactProfile.preparePreamble("ANCHOR_ARTIFACT_PROFILE=1", 300), off = ArtifactProfile.preparePreamble("", 300), off0 = ArtifactProfile.preparePreamble("ANCHOR_ARTIFACT_PROFILE=0", 45);
        check("ARTIFACT_PROFILE 1\nPREPARE 300\n".equals(on), "profile preamble bytes");
        check("PREPARE 300\n".equals(off) && "PREPARE 45\n".equals(off0), "plain preamble bytes (no ARTIFACT_PROFILE line at all)");
        check(!on.contains("ENGINE") && !on.contains("WORKER") && !on.contains("env="), "preparation preamble carries no ENGINE, WORKER or env");
        check(ArtifactProfile.preparePreamble("ANCHOR_ARTIFACT_PROFILE=2", 300) == null, "malformed request = null");
        check(ArtifactProfile.preparePreamble("ANCHOR_ARTIFACT_PROFILE=1", 0) == null && ArtifactProfile.preparePreamble("", 601) == null, "deadline out of range = null");
        check(ArtifactProfile.preparePreamble("", 1) != null && ArtifactProfile.preparePreamble("", 600) != null, "deadline bounds inclusive");
        System.out.println("{\"status\":\"" + (failed == 0 ? "PASS" : "FAIL") + "\",\"executed_checks\":" + checks + ",\"preamble_profile\":\"" + json(on) + "\",\"preamble_plain\":\"" + json(off) + "\"}");
        System.exit(failed == 0 ? 0 : 1);
    }
}
