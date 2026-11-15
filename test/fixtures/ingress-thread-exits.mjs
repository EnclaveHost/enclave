// an ingress thread that ends when the main thread answers its first question (test/ingress-thread.test.mjs)
import {parentPort} from 'node:worker_threads';
import '../../network/ingress-thread.mjs';
parentPort.on('message',m=>{if(m?.t==='answer')process.exit(3);});
