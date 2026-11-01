// Disposable subprocess fixture: only the supplied private test journal is used.
import { ownLifecycleJournal, recoverLifecycleJournal } from '../../network/deployment-journal-owner.mjs';
const [mode, file] = process.argv.slice(2);
const id = '0x' + '12'.repeat(32), digest = '0x' + '34'.repeat(32);
try {
  if (mode === 'recover') {
    console.log(JSON.stringify(await recoverLifecycleJournal(file)));
  } else {
    const owner = await ownLifecycleJournal(file);
    if (mode === 'hold') {
      owner.journal.observeAssignment(id, 2, 1);
      owner.journal.fence(id, 2);
      owner.journal.failure(id, { identity: 'crashed-child', now: 1000, random: () => 0 });
      owner.journal.prepareTransition(id, { digest, payload: '{"intent":"never-repeat"}' });
      process.send('ready');
      setInterval(() => {}, 1000);
    } else {
      console.log(JSON.stringify(owner.journal.read(id)));
      await owner.close();
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 73; }
