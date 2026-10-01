// Display catalog requirements, not hardware capacity multiplied by a share.
// Shares are allocation metadata and only accompany a running deployment.
const amount = (value) => Math.max(0, Number(value) || 0);
const number = (value) => String(Number(value.toFixed(3)));
const memory = (mb) => mb >= 1024 ? number(mb / 1024) + " GB" : number(mb) + " MB";
const cpuText = (mb, gf) => memory(mb) + " RAM / " + number(gf / 1000) + " TFLOPs CPU";

export function appResources(spec, deployment){
  if (!spec) return "Requirements unavailable";
  const r = deployment?.resources || {};
  const suffix = (share) => deployment?.status === "running" && share != null && Number.isFinite(Number(share))
    ? " (" + number(amount(share) * 100) + "%)" : "";
  const gpu = amount(spec.vramMb) > 0 || amount(spec.gpuGflops) > 0;
  const withoutGpu = !!deployment && gpu && spec.gpuOptional && !(amount(r.gpuShare) > 0);
  const mem = amount(spec.memMb), cpu = amount(spec.cpuGflops);
  const fallbackMem = Math.max(mem, amount(spec.cpuFallback?.memMb));
  const fallbackCpu = Math.max(cpu, amount(spec.cpuFallback?.cpuGflops));
  const parts = [];
  if (gpu && !withoutGpu) {
    parts.push(memory(amount(spec.vramMb)) + " VRAM / " + number(amount(spec.gpuGflops) / 1000) + " TFLOPs GPU"
      + (spec.gpuOptional && !deployment ? " (optional)" : "") + suffix(r.gpuShare));
  }
  parts.push(cpuText(withoutGpu ? fallbackMem : mem, withoutGpu ? fallbackCpu : cpu) + suffix(r.cpuShare ?? r.share));
  if (!deployment && gpu && spec.gpuOptional && (fallbackMem > mem || fallbackCpu > cpu)) {
    parts.push("without GPU: " + cpuText(fallbackMem, fallbackCpu));
  }
  return parts.join(" · ");
}
