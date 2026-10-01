import { rankEnclavesFor, minPctsOf, cpuFloorFor, cardServesApp, nameOf, enclavePriceOf, computeEligibleOf, volGbOf, volsWanted } from './pricing.js';
import { hostMeetsTeeRequirements, isolationOptions } from './isolation-options.js';

// A planner must never invent hardware from the aggregate or fallback specs.
export function resourceHosts(spec, rows, configCid = '') {
  const isolation = isolationOptions(configCid);
  const effective = { ...spec, ...(isolation.envelope.config ? { volumes: isolation.envelope.config.volumes || [] } : {}) };
  const eligible = rankEnclavesFor(effective, rows);
  return (rows || []).filter(row => row?.availability && computeEligibleOf(row)).map(row => {
    const a = row.availability;
    const hardware = { nodeRamGb: Number(a.nodeRamGb), nodeGflops: Number(a.nodeGflops),
      cardVramGb: a.gpu ? Number(a.cardVramGb) : 0, cardTflops: a.gpu ? Number(a.cardTflops) : 0 };
    const known = [hardware.nodeRamGb, hardware.nodeGflops, ...(a.gpu ? [hardware.cardVramGb, hardware.cardTflops] : [])]
      .every(n => Number.isFinite(n) && n > 0);
    const match = eligible.find(t => t.row.id === row.id);
    const mins = known ? minPctsOf(spec, hardware, { volGb: volGbOf(a, volsWanted(effective)) }) : null;
    const reason = !known ? 'Capacity report unavailable' : (isolation.cpuTee || isolation.gpuTee) && !hostMeetsTeeRequirements(row, isolation)
      ? 'Does not meet the app’s isolation requirements' : !match ? 'Cannot currently host this app or its models'
      : match.cpuFloor > 100 ? 'Too small for the app’s CPU fallback' : '';
    return { row, id: String(row.id).toLowerCase(), name: nameOf(row), spec: hardware, mins,
      price: enclavePriceOf(row), gpu: a.gpu === true, reason };
  });
}

export function cpuMinimumOn(host, gpuMilli) {
  return cpuFloorFor(host.mins, gpuMilli > 0 && cardServesApp(host.row.availability, host.mins) ? 1 : 0);
}
