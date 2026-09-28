use wasmtime_wasi_nn::{backend::{ggml::GgmlBackend,BackendFromDir,NamedTensor},wit::types::{Tensor,TensorType,ExecutionTarget},ExecutionContext};
use std::{path::Path,time::Instant};
fn ints(n:&str,v:&[i32])->NamedTensor{NamedTensor{name:n.into(),tensor:Tensor::new(vec![v.len() as u32],TensorType::I32,v.iter().flat_map(|n|n.to_le_bytes()).collect())}}
fn call(c:&mut ExecutionContext,v:Vec<NamedTensor>)->Vec<NamedTensor>{c.compute_with_io(v).unwrap()}
fn feed(c:&mut ExecutionContext,ids:&[i32],cache:bool)->Vec<f32>{
 let mut out=vec![];
 for (i,chunk) in ids.chunks(16).enumerate(){let mut v=vec![ints("tokens",chunk)];if i==0 {v.push(ints("prompt",ids));v.push(ints("marks",&[64]));if !cache {v.push(ints("prefix_cache",&[0]));}}out=call(c,v);}
 let b=&out.iter().find(|x|x.name=="logits").unwrap().tensor.data;b.chunks_exact(4).map(|x|f32::from_le_bytes(x.try_into().unwrap())).collect()
}
fn argmax(a:&[f32])->usize{a.iter().enumerate().max_by(|a,b|a.1.total_cmp(b.1)).unwrap().0}
fn main(){
 let model=std::env::args().nth(1).unwrap();let mut b=GgmlBackend::default();let g=b.load_from_dir(Path::new(&model),ExecutionTarget::Cpu).unwrap();
 let p:Vec<i32>=(0..128).map(|i|100+i%23).collect();let mut c=g.init_execution_context().unwrap();
 let caps=call(&mut c,vec![ints("caps",&[1])]);let caps:Vec<i32>=caps[0].tensor.data.chunks_exact(4).map(|b|i32::from_le_bytes(b.try_into().unwrap())).collect();assert!(caps.len()>=19 && caps[13]>0 && caps[15]>0);println!("CACHE_CAPS turn={} boundary={} shared={}",caps[13],caps[15],caps[16]);
 let t=Instant::now();let row=feed(&mut c,&p,true);let cold=t.elapsed();call(&mut c,vec![ints("tokens",&[argmax(&row) as i32])]);drop(c);
 let extended:Vec<i32>=p.iter().copied().chain((0..16).map(|i|200+i)).collect();
 let mut c=g.init_execution_context().unwrap();let t=Instant::now();let reused=feed(&mut c,&extended,true);let warm=t.elapsed();drop(c);
 let mut c=g.init_execution_context().unwrap();let t=Instant::now();let fresh=feed(&mut c,&extended,false);let baseline=t.elapsed();drop(c);
 let delta=reused.iter().zip(&fresh).map(|(a,b)|(a-b).abs()).fold(0f32,f32::max);assert_eq!(argmax(&reused),argmax(&fresh));assert!(delta<0.02,"logit delta {delta}");assert!(warm.as_secs_f64()<baseline.as_secs_f64()*0.65,"cache did not accelerate append");
 // A different prefix must be computed independently, not reuse another prompt's state.
 let mut divergent=extended.clone();divergent[0]+=1;
 let mut c=g.init_execution_context().unwrap();let actual=feed(&mut c,&divergent,true);drop(c);
 let mut c=g.init_execution_context().unwrap();let expected=feed(&mut c,&divergent,false);drop(c);
 let nd=actual.iter().zip(&expected).map(|(a,b)|(a-b).abs()).fold(0f32,f32::max);assert_eq!(argmax(&actual),argmax(&expected));assert!(nd<0.02);
 println!("CACHE_APPEND_PASS prefix=128 append=16 cold_ms={} reused_ms={} uncached_ms={} max_logit_delta={} divergent_delta={}",cold.as_millis(),warm.as_millis(),baseline.as_millis(),delta,nd);
}
