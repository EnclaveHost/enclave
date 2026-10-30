// TEST runner lifetime only: model the real service's listening handle while unref'ed retry timers run.
import {after} from 'node:test';
const keep=setInterval(()=>{},1000);
after(()=>clearInterval(keep));
