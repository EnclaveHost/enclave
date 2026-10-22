use crate::store::Store;
use sia_storage::Sdk;
use sha2::{Digest,Sha256};
use tokio::io::AsyncWrite;
use std::{pin::Pin,task::{Context,Poll}};
struct HashWriter { hash:Sha256, bytes:u64 }
impl AsyncWrite for HashWriter {
 fn poll_write(mut self:Pin<&mut Self>,_:&mut Context<'_>,b:&[u8])->Poll<std::io::Result<usize>>{self.hash.update(b);self.bytes+=b.len() as u64;Poll::Ready(Ok(b.len()))}
 fn poll_flush(self:Pin<&mut Self>,_:&mut Context<'_>)->Poll<std::io::Result<()>>{Poll::Ready(Ok(()))}
 fn poll_shutdown(self:Pin<&mut Self>,_:&mut Context<'_>)->Poll<std::io::Result<()>>{Poll::Ready(Ok(()))}
}
pub async fn run(sdk:Sdk,manifest:&str)->Result<(),String>{
 let items:Vec<serde_json::Value>=serde_json::from_slice(&std::fs::read(manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
 let store=Store::load(sdk,0).await?;
 // Read-only: never call sweep, compact, upload, pin, delete or commit.
 for item in &items {
  let cid=item["cid"].as_str().ok_or("cid missing")?;let key=format!("nan-retirement/20261019/{cid}.car");
  let idx=store.idx.lock().await;let k=idx.keys.get(&("ipfs".into(),key)).ok_or(format!("missing archive {cid}"))?;
  if k.entry.s!=item["carBytes"].as_u64().ok_or("size missing")?{return Err(format!("wrong size {cid}"));}
 }
 println!("{{\"metadataVerified\":{}}}",items.len());
 for item in &items {
  let cid=item["cid"].as_str().unwrap();let size=item["carBytes"].as_u64().unwrap();
  let segments={let idx=store.idx.lock().await;let k=idx.keys.get(&("ipfs".into(),format!("nan-retirement/20261019/{cid}.car"))).unwrap();idx.segments(k,0,size)?};
  let mut out=HashWriter{hash:Sha256::new(),bytes:0};
  for (obj,off,len) in segments {let n=store.read_into(&obj,off,len,&mut out).await?;if n!=len{return Err(format!("short segment {cid}"));}}
  let sha=hex::encode(out.hash.finalize());if out.bytes!=size||Some(sha.as_str())!=item["carSHA256"].as_str(){return Err(format!("hash mismatch {cid}"));}
  println!("{}",serde_json::json!({"cid":cid,"bytes":size,"sha256":sha,"verified":true}));
 }
 Ok(())
}
