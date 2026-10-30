// Only race read-only preparation. Never time out and retry a signing or
// submission request: the original wallet request could still complete.
export async function walletRead(read, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Wallet preparation timed out; no signing request was sent.")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
