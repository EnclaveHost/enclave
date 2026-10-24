// Actual systemd monotonic timestamps, not a user-supplied stopped flag.
export function requireStoppedForTTL(row,nowMicros){
 if(row.ActiveState!=='inactive'||row.MainPID!=='0'||!/^\d+$/.test(row.InactiveEnterTimestampMonotonic??'')||BigInt(row.InactiveEnterTimestampMonotonic)===0n||nowMicros-BigInt(row.InactiveEnterTimestampMonotonic)<360000000n)throw Error('signer is not quiescent for the full lease TTL and margin');
}
