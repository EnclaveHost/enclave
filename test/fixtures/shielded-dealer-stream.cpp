#include "../../wasm/ggml-shielded/shielded-dealer-stream.h"
#include <cassert>
#include <vector>
#include <unistd.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <signal.h>

static const std::string seed(64, 'a'), sid(32, 'b'), pk(64, 'c');
static std::string request(unsigned seq, const char *i = "0", const char *n = "64") {
    return std::to_string(seq) + "\t" + seed + "\t" + sid + "\t" + pk + "\t" + i + "\t" + n;
}
static std::string contents(FILE *f) {
    assert(!fflush(f)); rewind(f); std::string result; int c;
    while ((c = fgetc(f)) != EOF) result += (char)c;
    return result;
}
static void parser() {
    sh_dealer_stream_job job;
    auto valid = request(1);
    assert(sh_dealer_stream_parse(valid.data(), valid.size(), 0, &job));
    assert(job.sequence == 1 && job.index0 == 0 && job.count == 64 && job.seed == seed);
    const auto saved = job;
    std::vector<std::string> bad = {"", valid + "\t", valid + "\t0", valid + "\n", "0" + valid,
        "+" + valid, " " + valid, request(0), request(2), request(1, "00"), request(1, "+0"),
        request(1, "-1"), request(1, "16777216", "1"), request(1, "16777215", "2"), request(1, "0", "0"),
        request(1, "0", "4097"), request(1, "18446744073709551616", "1"), request(1, "0", "1 ")};
    for (char c : {'\0', '\r', '\n', '\x7f', '\x01', (char)0xff}) {
        auto corrupt = valid; corrupt[3] = c; bad.push_back(corrupt);
    }
    for (size_t at : {size_t(2), size_t(67), size_t(100)}) {
        auto corrupt = valid; corrupt[at] = 'A'; bad.push_back(corrupt);
        corrupt = valid; corrupt.erase(at, 1); bad.push_back(corrupt);
    }
    for (const auto &s : bad) {
        assert(!sh_dealer_stream_parse(s.data(), s.size(), 0, &job));
        assert(job.sequence == saved.sequence && job.count == saved.count && !strcmp(job.seed, saved.seed));
    }
    for (const auto &s : {request(1, "16777215", "1"), request(1, "16773120", "4096")})
        assert(sh_dealer_stream_parse(s.data(), s.size(), 0, &job));
    const std::string max = "18446744073709551615" + valid.substr(1);
    assert(sh_dealer_stream_parse(max.data(), max.size(), UINT64_MAX - 1, &job));
    assert(!sh_dealer_stream_parse(max.data(), max.size(), UINT64_MAX, &job));
    // Every truncation of an otherwise valid record is refused except complete
    // decimal prefixes of the last field, which are valid smaller requests.
    for (size_t n = 0; n < valid.find_last_of('\t') + 1; n++)
        assert(!sh_dealer_stream_parse(valid.data(), n, 0, &job));
}
struct calls { unsigned count = 0; uint64_t fail_at = 0; sh_dealer_stream_result failure = SH_DEALER_STREAM_MINT_FAILED; };
static sh_dealer_stream_result mint(const sh_dealer_stream_job &job, void *opaque) {
    auto &c = *static_cast<calls *>(opaque); ++c.count;
    assert(job.seed == seed && job.seed_id == sid && job.pad_pk == pk);
    return job.sequence == c.fail_at ? c.failure : SH_DEALER_STREAM_OK;
}
static void run_case(const std::string &input, int expected_rc, unsigned expected_calls,
        const std::string &expected_output, uint64_t fail_at = 0,
        sh_dealer_stream_result failure = SH_DEALER_STREAM_MINT_FAILED) {
    FILE *in = tmpfile(), *out = tmpfile(); assert(in && out);
    assert(fwrite(input.data(), 1, input.size(), in) == input.size()); rewind(in);
    calls c; c.fail_at = fail_at; c.failure = failure;
    assert(sh_dealer_stream_run(in, out, mint, &c) == expected_rc);
    assert(c.count == expected_calls);
    auto output = contents(out); assert(output == expected_output);
    assert(output.find(seed) == std::string::npos && output.find(pk) == std::string::npos);
    fclose(in); fclose(out);
}
static void loop() {
    const auto one = request(1) + "\n", two = request(2, "64") + "\n";
    const auto ack1 = "PADS-DONE 1 " + sid + " 0 64\n", ack2 = "PADS-DONE 2 " + sid + " 64 64\n";
    run_case("", 0, 0, ""); run_case(one + two, 0, 2, ack1 + ack2);
    run_case(one + one + two, 2, 1, ack1 + "PADS-ERROR 0 protocol\n");
    run_case(one + two + request(3) + "\n", 1, 2, ack1 + "PADS-ERROR 2 mint-failed\n", 2);
    run_case(one + two, 1, 1, "PADS-ERROR 1 asset-changed\n", 1, SH_DEALER_STREAM_ASSET_CHANGED);
    for (const auto &bad : {request(1), std::string("\n"), std::string(4096, 'a') + "\n", one + "bad\n"})
        run_case(bad, 2, bad == one + "bad\n" ? 1 : 0,
            (bad == one + "bad\n" ? ack1 : "") + "PADS-ERROR 0 protocol\n");
    auto nul = request(1); nul[3] = '\0'; run_case(nul + "\n", 2, 0, "PADS-ERROR 0 protocol\n");
    // Kernel pipe fragments exercise the production reader; the parent requires
    // each acknowledgment BEFORE it supplies the next request (no batch EOF).
    int to_child[2], from_child[2]; assert(!pipe(to_child) && !pipe(from_child));
    const pid_t child = fork(); assert(child >= 0);
    if (!child) {
        close(to_child[1]); close(from_child[0]);
        FILE *in = fdopen(to_child[0], "r"), *out = fdopen(from_child[1], "w");
        calls c; const int rc = sh_dealer_stream_run(in, out, mint, &c);
        fclose(in); fclose(out); _exit(rc || c.count != 2 ? 1 : 0);
    }
    close(to_child[0]); close(from_child[1]);
    FILE *out = fdopen(from_child[0], "r"); assert(out);
    for (const auto &pair : {std::make_pair(one, ack1), std::make_pair(two, ack2)}) {
        for (char c : pair.first) assert(write(to_child[1], &c, 1) == 1);
        char line[256]; assert(fgets(line, sizeof line, out)); assert(line == pair.second);
    }
    close(to_child[1]); assert(fgetc(out) == EOF); fclose(out);
    int status; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && !WEXITSTATUS(status));
    // A published job whose acknowledgment pipe broke is uncertain to its
    // parent: nonzero exit, no processing of the next input request.
    int broken[2]; assert(!pipe(broken)); close(broken[0]);
    FILE *in = tmpfile(), *sink = fdopen(broken[1], "w"); assert(in && sink);
    const auto both = one + two; assert(fwrite(both.data(), 1, both.size(), in) == both.size()); rewind(in);
    calls c; assert(sh_dealer_stream_run(in, sink, mint, &c) == 1 && c.count == 1); fclose(in); fclose(sink);
    FILE *bad_read = fopen("/dev/null", "w"), *out_error = tmpfile(); assert(bad_read && out_error);
    calls none; assert(sh_dealer_stream_run(bad_read, out_error, mint, &none) == 2 && !none.count);
    assert(contents(out_error) == "PADS-ERROR 0 protocol\n"); fclose(bad_read); fclose(out_error);
}
static void assets() {
    char dir[] = "/tmp/shielded-stream-assets-XXXXXX"; assert(mkdtemp(dir));
    const std::string path = std::string(dir) + "/asset", replacement = std::string(dir) + "/new";
    auto put = [](const std::string &p, const char *bytes) {
        FILE *f = fopen(p.c_str(), "wb"); assert(f); assert(fwrite(bytes, 1, strlen(bytes), f) == strlen(bytes)); assert(!fclose(f));
    };
    sh_dealer_stream_asset a;
    assert(!a.capture(path.c_str()) && !a.capture(dir) && !a.unchanged());
    put(path, ""); assert(!a.capture(path.c_str()));
    put(path, "one"); assert(a.capture(path.c_str()) && a.unchanged());
    put(replacement, "two");
    const struct timespec times[] = {a.stamp.st_atim, a.stamp.st_mtim};
    assert(!utimensat(AT_FDCWD, replacement.c_str(), times, 0));
    assert(!rename(replacement.c_str(), path.c_str()) && !a.unchanged()); // same length + mtime, different inode
    assert(a.capture(path.c_str()));
    put(path, "longer"); assert(!a.unchanged());
    assert(a.capture(path.c_str())); assert(!unlink(path.c_str()) && !a.unchanged()); assert(!rmdir(dir));
}
int main() { signal(SIGPIPE, SIG_IGN); parser(); loop(); assets(); }
