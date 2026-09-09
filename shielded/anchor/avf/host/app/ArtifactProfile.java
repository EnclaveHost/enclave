package host.enclave.anchor.avf;

/* The preparation run's control preamble, pure so a host fixture can pin the exact bytes the VM parses (anchor_prepare.c
 * anchor_artifact_profile_parse / anchor_prepare_parse): PREPARE carries no ENGINE environment, so when shenv asks for
 * ANCHOR_ARTIFACT_PROFILE=1 the app says so with the one explicit control line "ARTIFACT_PROFILE 1" before "PREPARE <s>".
 * Default (key absent, or =0): no ARTIFACT_PROFILE line at all, the VM's profiler stays off. Any other value, a repeated key,
 * or a malformed shenv entry is a configuration error (null): refused before anything is sent, never guessed. */
final class ArtifactProfile {
    static final String KEY = "ANCHOR_ARTIFACT_PROFILE";
    private ArtifactProfile() {}
    /** 1 = profile requested, 0 = not requested (absent or =0), -1 = malformed shenv request. */
    static int requested(String shenv) {
        if (shenv == null || shenv.isEmpty()) return 0;
        int seen = -1;
        for (String kv : shenv.split(",", -1)) {
            int eq = kv.indexOf('=');
            if (eq <= 0) return -1;                                  // every entry is K=V with a non-empty key
            if (!kv.substring(0, eq).equals(KEY)) continue;
            String v = kv.substring(eq + 1);
            if (seen >= 0 || !(v.equals("0") || v.equals("1"))) return -1;   // exactly once, exactly 0 or 1
            seen = v.charAt(0) - '0';
        }
        return seen < 0 ? 0 : seen;
    }
    /** The lines sent before RUN for a preparation: "[ARTIFACT_PROFILE 1\n]PREPARE <deadlineS>\n"; null = refuse (bad request or deadline). */
    static String preparePreamble(String shenv, int deadlineS) {
        int r = requested(shenv);
        if (r < 0 || deadlineS < 1 || deadlineS > 600) return null;
        return (r == 1 ? "ARTIFACT_PROFILE 1\n" : "") + "PREPARE " + deadlineS + "\n";
    }
}
