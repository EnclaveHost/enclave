package host.enclave.anchor.avf;
/* host test for LocalChat's pure helpers: the request line the VM parser must accept, hex both ways, UTF-8 reassembly across split pieces */
public final class LocalChatTest {
    static int checks = 0, failed = 0;
    static void expect(boolean ok, String what) { checks++; if (!ok) { failed++; System.err.println("FAIL " + what); } }
    public static void main(String[] a) throws Exception {
        expect(LocalChat.request("hello", 256, 700).equals("GEN 256 700 68656c6c6f"), "plain request");
        expect(LocalChat.request("hi", 0, -5).equals("GEN 1 0 6869"), "clamped low");
        expect(LocalChat.request("hi", 99999, 99999).equals("GEN 8192 2000 6869"), "clamped high");
        expect(LocalChat.request("", 10, 0) == null, "empty message refused");
        String snow = "hé ☃ 😀";
        expect(new String(LocalChat.unhex(LocalChat.hex(snow.getBytes("UTF-8"))), "UTF-8").equals(snow), "hex round trip");
        expect(LocalChat.unhex("6z") == null && LocalChat.unhex("686") == null, "bad hex refused");
        LocalChat.Utf8Joiner j = new LocalChat.Utf8Joiner(); byte[] b = snow.getBytes("UTF-8"); StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(j.push(new byte[] { x }));          /* one byte at a time: never a replacement character */
        expect(sb.toString().equals(snow), "utf-8 reassembled across single-byte pieces"); expect(sb.indexOf("�") < 0, "no replacement characters");
        java.util.Map<String, String> st = LocalChat.stats("STATS status=eos prefill_tokens=12 prefill_tok_s=150.25 decode_tokens=40 decode_tok_s=16.30 ctx_used=52 ctx=4096");
        expect("eos".equals(st.get("status")) && "16.30".equals(st.get("decode_tok_s")) && "4096".equals(st.get("ctx")), "stats parsed");
        expect(LocalChat.plan(3360161216L, 6, 4096).equals("LOCAL model_bytes=3360161216 threads=6 ctx=4096"), "plan line");
        expect(LocalChat.plan(5, 99, 1).equals("LOCAL model_bytes=5 threads=16 ctx=512"), "plan clamps");
        expect(LocalChat.plan(3360161216L, 6, 4096, 1842000000L, 64).equals("LOCAL model_bytes=3360161216 threads=6 ctx=4096 tpu_bundle_bytes=1842000000 bank=64"), "tpu plan line");
        System.out.println("{\"status\":\"" + (failed == 0 ? "PASS" : "FAIL") + "\",\"executed_checks\":" + checks + ",\"request\":\"" + LocalChat.request("hello", 256, 700) + "\",\"request_utf8\":\"" + LocalChat.request(snow, 64, 0) + "\",\"plan\":\"" + LocalChat.plan(3360161216L, 6, 4096) + "\",\"plan_tpu\":\"" + LocalChat.plan(3360161216L, 6, 4096, 1842000000L, 64) + "\"}");
        if (failed != 0) System.exit(1);
    }
}
