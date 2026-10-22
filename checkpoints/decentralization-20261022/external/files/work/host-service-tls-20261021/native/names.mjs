import { hostServiceNames } from '../compose/network/host-service-names.mjs';
const n = hostServiceNames('0x' + '11'.repeat(32), 'native-test.invalid');
console.log(JSON.stringify([n['directory-replica'], n['bootstrap-replica']]));
