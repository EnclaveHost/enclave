//! Custody canary proof app: wasi:http 0.2 incoming-handler for the per-app SNP tier (release-16c2999d,
//! `wasmtime serve`). See src/proof.rs for the contract. Environment: only CANARY_-named variables are kept, every other
//! entry is dropped by name (wasi:cli/environment hands the list over in one call). No ENCLAVE_CONFIG, no logging, no
//! outbound network, no request body read, no request data echoed.
pub mod proof;

#[cfg(target_arch = "wasm32")]
mod component {
    use crate::proof::{answer, is_name, Answer};
    use wasi::exports::http::incoming_handler::Guest;
    use wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};

    struct Component;

    impl Guest for Component {
        fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
            let get = matches!(request.method(), Method::Get);
            let path = request.path_with_query().unwrap_or_default();
            drop(request);
            let mut env = wasi::cli::environment::get_environment();
            env.retain(|(name, _)| is_name(name));
            let (status, body): (u16, Option<String>) = match answer(get, &path, &env) {
                Answer::Proofs(json) => (200, Some(json)),
                Answer::BadChallenge => (400, None),
                Answer::NotFound => (404, None),
                Answer::NoMarkers => (409, None),
            };
            drop(env);
            let headers = Fields::new();
            let _ = headers.append("cache-control", b"no-store");
            if body.is_some() { let _ = headers.append("content-type", b"application/json"); }
            let response = OutgoingResponse::new(headers);
            let _ = response.set_status_code(status);
            let out_body = match response.body() { Ok(b) => b, Err(()) => return };
            ResponseOutparam::set(response_out, Ok(response));
            if let Some(json) = body {
                if let Ok(out) = out_body.write() {
                    let _ = out.blocking_write_and_flush(json.as_bytes());
                    drop(out);
                }
            }
            let _ = OutgoingBody::finish(out_body, None);
        }
    }

    wasi::http::proxy::export!(Component);
}
