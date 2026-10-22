import { loadStage } from './guard.mjs';
const s = loadStage(process.argv[2]);
console.log(JSON.stringify({verified: true, commit: s.commit, port: s.port, managerCommandSha256: s.managerCommandSha256}));
