/* anchor-prepare: the preparation run's control grammar (shielded/anchor/avf/payload/anchor_prepare.[ch]). PREPARE carries no ENGINE
 * environment, so the artifact receive profiler is switched by one explicit line, "ARTIFACT_PROFILE 0|1", which this fixture pins
 * together with "PREPARE [1..600]" and the receive-time decision rule (explicit line first, else the ENGINE environment).
 * Self-check mode (no arguments) prints {"status","executed_checks"}. Wire mode (`--wire <line>...`) parses each argument as the VM
 * would parse one control line and prints one verdict per line, so the Node wrapper can feed it the exact bytes the app emits. */
#include "anchor_prepare.h"
#include <stdio.h>
#include <string.h>
static int checks = 0, failed = 0;
#define CHECK(c, what) do { const int _r = (c); checks++; if (!_r) { failed++; fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, what); } } while (0)
int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "--wire")) {
        for (int i = 2; i < argc; i++) { int v = 0;
            if (anchor_artifact_profile_parse(argv[i], &v)) printf("ARTIFACT_PROFILE %s\n", v ? "on" : "off");
            else if (anchor_prepare_parse(argv[i], &v)) printf("PREPARE %d\n", v);
            else printf("REFUSED\n"); }
        return 0;
    }
    int v;
    /* ARTIFACT_PROFILE: exactly the two accepted lines */
    v = 7; CHECK(anchor_artifact_profile_parse("ARTIFACT_PROFILE 1", &v) == 1 && v == 1, "profile 1");
    v = 7; CHECK(anchor_artifact_profile_parse("ARTIFACT_PROFILE 0", &v) == 1 && v == 0, "profile 0");
    static const char *const bad[] = { "ARTIFACT_PROFILE", "ARTIFACT_PROFILE ", "ARTIFACT_PROFILE 2", "ARTIFACT_PROFILE 01", "ARTIFACT_PROFILE 1 ", "ARTIFACT_PROFILE  1",
        "ARTIFACT_PROFILE 1\n", "ARTIFACT_PROFILE 10", "ARTIFACT_PROFILE -1", "ARTIFACT_PROFILE on", "ARTIFACT_PROFILE=1", "artifact_profile 1", " ARTIFACT_PROFILE 1",
        "ANCHOR_ARTIFACT_PROFILE=1", "ARTIFACT_PROFILE 1 PREPARE 300", "", "PREPARE 300", NULL };
    for (int i = 0; bad[i]; i++) { v = 7; CHECK(anchor_artifact_profile_parse(bad[i], &v) == 0 && v == 7, bad[i]); }
    CHECK(anchor_artifact_profile_parse(NULL, &v) == 0, "profile NULL line"); CHECK(anchor_artifact_profile_parse("ARTIFACT_PROFILE 1", NULL) == 0, "profile NULL out");
    /* PREPARE: canonical 1..600, default 300 */
    v = 0; CHECK(anchor_prepare_parse("PREPARE", &v) == 1 && v == 300, "PREPARE default 300");
    v = 0; CHECK(anchor_prepare_parse("PREPARE 1", &v) == 1 && v == 1, "PREPARE 1");
    v = 0; CHECK(anchor_prepare_parse("PREPARE 300", &v) == 1 && v == 300, "PREPARE 300");
    v = 0; CHECK(anchor_prepare_parse("PREPARE 600", &v) == 1 && v == 600, "PREPARE 600");
    static const char *const pbad[] = { "PREPARE 0", "PREPARE 601", "PREPARE 1000", "PREPARE 01", "PREPARE +1", "PREPARE -1", "PREPARE ", "PREPARE  5", "PREPARE 5 ", "PREPARE 5\n", "PREPARE x",
        "PREPARED", "prepare 5", "ARTIFACT_PROFILE 1", "", NULL };
    for (int i = 0; pbad[i]; i++) { v = 0; CHECK(anchor_prepare_parse(pbad[i], &v) == 0 && v == 0, pbad[i]); }
    CHECK(anchor_prepare_parse(NULL, &v) == 0 && anchor_prepare_parse("PREPARE", NULL) == 0, "PREPARE NULL args");
    /* the receive-time decision: an explicit line wins over the ENGINE environment; without one the environment decides; default off */
    CHECK(anchor_artifact_profile_effective(1, NULL) == 1 && anchor_artifact_profile_effective(1, "0") == 1, "explicit on wins");
    CHECK(anchor_artifact_profile_effective(0, "1") == 0 && anchor_artifact_profile_effective(0, NULL) == 0, "explicit off wins");
    CHECK(anchor_artifact_profile_effective(-1, "1") == 1, "no line: env 1 = on");
    CHECK(anchor_artifact_profile_effective(-1, NULL) == 0 && anchor_artifact_profile_effective(-1, "0") == 0 && anchor_artifact_profile_effective(-1, "true") == 0 && anchor_artifact_profile_effective(-1, "1 ") == 0, "no line: env absent/other = off");
    CHECK(anchor_artifact_profile_effective(2, "1") == 1 && anchor_artifact_profile_effective(-5, NULL) == 0, "out-of-range setting = no line");
    /* the exact lines the app's ArtifactProfile.preparePreamble emits (pinned again by ArtifactProfileTest.java and the Node wrapper's cross-feed) */
    v = 0; CHECK(anchor_artifact_profile_parse("ARTIFACT_PROFILE 1", &v) == 1 && v == 1 && anchor_prepare_parse("PREPARE 300", &v) == 1 && v == 300, "app preamble lines parse");
    printf("{\"status\":\"%s\",\"executed_checks\":%d}\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
