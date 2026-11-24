import test from 'node:test';
import assert from 'node:assert/strict';
import {imageIdentityPins,validImageIdentities} from './vbs-image-identity.mjs';
const identity={signer:'ab'.repeat(32),productId:1,moduleId:2};
const image={measurement:'cd'.repeat(32),identity,nativeDesktop:true,minimumGuestSvn:13};
test('image selection carries its SVN floor into the common verifier pins',()=>{
 const pins=imageIdentityPins([image]);
 assert.deepEqual(pins,[{measurement:image.measurement,identity,minimumGuestSvn:13}]);
 assert.equal(validImageIdentities(pins),true);
 assert.equal(imageIdentityPins([{measurement:image.measurement}]),undefined);
 assert.deepEqual(imageIdentityPins([{measurement:image.measurement,identity}]),[{measurement:image.measurement,identity}]);
 for(const minimumGuestSvn of [null,undefined,'13',-1,0x100000000,1.5])
  assert.throws(()=>imageIdentityPins([{...image,minimumGuestSvn}]));
 const getter={measurement:image.measurement,identity};
 Object.defineProperty(getter,'minimumGuestSvn',{enumerable:true,get(){throw Error('must not read');}});
 assert.equal(validImageIdentities([getter]),false);
});
