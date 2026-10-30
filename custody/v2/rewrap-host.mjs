#!/usr/bin/env node
// The HOST side of one rewrap run (custody/v2/rewrap.mjs), OUTSIDE the TEE and untrusted for secrecy - the same position as
// the lease host for any app guest. It
//   - launches the measured rewrap image (scripts/build-custody-rewrap.mjs) as an SEV-SNP guest with HOST_DATA = the
//     deployment id (QEMU sev-snp-guest host-data), kernel/initrd/cmdline measured (kernel-hashes=on);
//   - hands the guest its UNMEASURED input via fw_cfg opt/org.enclave.rewrap: { hostUrl, authorization, signature };
//   - signs, with the lease host's REGISTRY OPERATOR key, exactly the v2 release message for THIS deployment and endpoint
//     (the operator's ordinary authorization of a release to a guest on its host) - nothing else;
//   - receives the guest's result (ciphertext + public facts) or refusal code, writes it, and stops the guest.
// The host never sees a plaintext: the partials are sealed to the guest's own key and combined inside it.
//   node custody/v2/rewrap-host.mjs <config.json>
// config: { dist, ovmf, qemu?, cpus?, memMiB?, sevDevice?, hostPort, chainId, vault, deploymentId, endpoint,
//           operatorKeyFile (JSON { registryKey }), authorizationFile (JSON { authorization, signature }), resultFile }
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import * as v2 from "./protocol.mjs";
import { assertResultShape } from "./rewrap.mjs";

const lc = (s) => String(s).toLowerCase();
export const MAX_OPERATOR_EXPIRY_SEC = 600;

/** the host's two-call API, as a node http handler. operator: a viem account (the lease host's registry operator) */
export function rewrapHostApi({ chainId, vault, id, endpoint, operator, onResult, now = () => Date.now() }) {
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  return async (req, res) => {
    try {
      if (req.method !== "POST") return json(res, 405, { error: "method" });
      const chunks = []; let n = 0;
      for await (const c of req) { n += c.length; if (n > 512 << 10) return json(res, 413, { error: "too_large" }); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (req.url === "/operator-sign") {
        // sign ONLY the release message for this deployment and endpoint, over a well-formed binding, with a short expiry
        const expiry = Number(body.expiry), nowSec = Math.floor(now() / 1000);
        if (!Number.isSafeInteger(expiry) || expiry <= nowSec || expiry > nowSec + MAX_OPERATOR_EXPIRY_SEC) return json(res, 422, { error: "bad_expiry" });
        if (!/^[0-9a-f]{64}$/.test(String(body.binding))) return json(res, 422, { error: "bad_binding" });
        const message = v2.operatorMessage({ chainId, vault: lc(vault), id: lc(id), endpoint, binding: Buffer.from(body.binding, "hex"), expiry });
        if (body.message !== message) return json(res, 422, { error: "not_this_release" });
        return json(res, 200, { sig: await operator.signMessage({ message }) });
      }
      if (req.url === "/result") {
        if (body.result) assertResultShape(body.result);
        else if (!body.error || typeof body.error.code !== "string") return json(res, 422, { error: "bad_result" });
        await onResult(body);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not_found" });
    } catch (e) { return json(res, 422, { error: "refused", message: String(e.message).slice(0, 200) }); }
  };
}

/** QEMU arguments for the measured rewrap guest; host-data binds the launch to the deployment (report HOST_DATA) */
export function qemuArgs({ dist, ovmf, cpus = 2, memMiB = 3072, sevDevice = "/dev/sev", fwCfgFile, deploymentId }) {
  const cmdline = fs.readFileSync(path.join(dist, "cmdline"), "utf8").trim();
  const hostData = Buffer.from(lc(deploymentId).slice(2), "hex").toString("base64");
  return ["-machine", "q35,accel=kvm,confidential-guest-support=cx0,memory-backend=ram0", "-cpu", "host", "-smp", String(cpus), "-m", String(memMiB),
    "-nographic", "-no-reboot", "-kernel", path.join(dist, "vmlinuz"), "-initrd", path.join(dist, "initramfs.cpio.gz"), "-append", cmdline,
    "-fw_cfg", `name=opt/org.enclave.rewrap,file=${fwCfgFile}`, "-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0",
    "-serial", "mon:stdio", "-object", `memory-backend-memfd,id=ram0,size=${memMiB}M,share=true,prealloc=false`, "-bios", ovmf,
    "-object", `sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,host-data=${hostData},sev-device=${sevDevice}`];
}

if (process.argv[1] && process.argv[1].endsWith("rewrap-host.mjs") && process.argv[2]) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const log = (...a) => console.log(new Date().toISOString(), "[rewrap-host]", ...a);
  const reg = JSON.parse(fs.readFileSync(cfg.operatorKeyFile, "utf8"));
  const operator = privateKeyToAccount(reg.registryKey.startsWith("0x") ? reg.registryKey : "0x" + reg.registryKey);
  const input = JSON.parse(fs.readFileSync(cfg.authorizationFile, "utf8"));
  const fwCfgFile = path.join(path.dirname(path.resolve(cfg.resultFile)), "rewrap-fwcfg.json");
  fs.writeFileSync(fwCfgFile, JSON.stringify({ hostUrl: `http://10.0.2.2:${cfg.hostPort}`, authorization: input.authorization, signature: input.signature }), { mode: 0o600 });
  let child = null;
  const srv = http.createServer(rewrapHostApi({ chainId: cfg.chainId, vault: cfg.vault, id: cfg.deploymentId, endpoint: cfg.endpoint, operator,
    onResult: async (body) => {
      fs.writeFileSync(cfg.resultFile, JSON.stringify(body, null, 1) + "\n", { flag: "wx" });
      log(body.result ? `result ${body.result.bundleHash} written to ${cfg.resultFile}` : `guest refused: ${body.error.code}: ${body.error.message}`);
      setTimeout(() => { if (child) child.kill("SIGTERM"); srv.close(); }, 500);
    } }));
  srv.listen(cfg.hostPort, "127.0.0.1", () => {
    child = spawn(cfg.qemu || "qemu-system-x86_64", qemuArgs({ ...cfg, fwCfgFile }), { stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (code, sig) => log(`guest exited ${code}/${sig}`));
  });
}
