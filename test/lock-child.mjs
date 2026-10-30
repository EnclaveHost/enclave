import { takeRuntimeLock } from '../network/runtime-lock.mjs';
try {
  const release = await takeRuntimeLock(process.argv[2]);
  process.send({ acquired: true });
  process.on('message', m => {
    if (m === 'release') { release(); process.exit(0); }
    if (m === 'try-again') process.send({ acquired: true });
  });
} catch (error) { process.send({ acquired: false, error: error.message }, () => process.exit(1)); }
