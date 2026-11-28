import { SyntheticAuthority } from './runner-single-authority-prototype.mjs';
const [file, mode, point] = process.argv.slice(2);
const authority = new SyntheticAuthority(file);
const request = { jobId: 'one', policyRevision: 'rev1', snapshotDigest: 'snapshot1' };
const events = [];
const wait = () => new Promise(resolve => process.once('message', resolve));
if (mode === 'delay') { process.send('ready'); await wait(); }
const result = await authority.dispatch(request, events, async stage => {
  if (stage === point) { process.send({ stage, events: [...events] }); await wait(); }
});
process.send({ result, events });
authority.dispose();
process.disconnect();
