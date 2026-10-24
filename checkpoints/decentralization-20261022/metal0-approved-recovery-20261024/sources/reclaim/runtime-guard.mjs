// Actual systemd monotonic timestamps, not a user-supplied stopped flag.
export function requireStoppedForTTL(row,nowMicros,{unit,exhaustedKeeperExpiry,nowSec}={}){
 // A completed transient keeper can be garbage-collected by systemd. Its last verified renewal
 // necessarily mined no later than its resulting lease expiry. With the pinned client's 300s TTL,
 // waiting until that expiry + 360s also outlives every earlier signed renewal. Only the complete,
 // exhausted eight-result inventory may supply this bound; this exception never applies to control.
 if(unit==='enclave-custody-protected-leases-20261023.service'&&row.LoadState==='not-found'&&row.ActiveState==='inactive'&&row.MainPID==='0'
  &&Number.isSafeInteger(exhaustedKeeperExpiry)&&exhaustedKeeperExpiry>0&&Number.isSafeInteger(nowSec)&&nowSec>exhaustedKeeperExpiry+360)return;
 if(row.LoadState!=='loaded'||row.ActiveState!=='inactive'||row.MainPID!=='0'||!/^\d+$/.test(row.InactiveEnterTimestampMonotonic??'')||BigInt(row.InactiveEnterTimestampMonotonic)===0n||nowMicros-BigInt(row.InactiveEnterTimestampMonotonic)<360000000n)throw Error('signer is not quiescent for the full lease TTL and margin');
}
