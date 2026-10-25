// Use an existing session's api.upload grant. A refused/expired session must
// never turn an upload into an unexpected wallet signature request.
export async function requestUploadToken({ url, hash, expiry, owner, sessionPresent,
  authorize, signMessage, fetchImpl = fetch }) {
  let body = JSON.stringify({ hash, expiry });
  const headers = { "content-type": "application/json" };
  if (sessionPresent) {
    const auth = await authorize("POST", url, body, "api.upload");
    if (!auth) throw new Error("This session cannot authorize uploads. No wallet signature was requested.");
    headers.authorization = auth;
  } else {
    const signature = await signMessage(`enclave-upload:${hash}:${expiry}`);
    body = JSON.stringify({ hash, expiry, signature });
  }
  const response = await fetchImpl(url, { method: "POST", headers, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.token)
    throw new Error("upload authorization failed: " + (result.message || result.error || ("HTTP " + response.status)));
  if (String(result.address).toLowerCase() !== String(owner).toLowerCase())
    throw new Error("Upload authorization returned a different owner.");
  return { token: result.token, address: result.address, expiry };
}
