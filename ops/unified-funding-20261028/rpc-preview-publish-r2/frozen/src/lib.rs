//! Public catalog placeholder. No chain clients, signing, storage, or upstream RPC.
use std::io::Write as _;
use wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};

struct Preview;
wasi::http::proxy::export!(Preview);

impl wasi::exports::http::incoming_handler::Guest for Preview {
    fn handle(request: IncomingRequest, response_out: ResponseOutparam) {
        let is_page = matches!(request.method(), Method::Get | Method::Head)
            && request.path_with_query().as_deref().unwrap_or("/").split('?').next() == Some("/");
        let (status, content_type, bytes): (u16, &str, &[u8]) = if is_page {
            (200, "text/html; charset=utf-8", include_bytes!("../index.html"))
        } else {
            (503, "application/json", br#"{"status":"preview","rpcReady":false,"message":"Ethereum and Base RPC are not operational in this preview."}"#)
        };
        let fields = Fields::from_list(&[
            ("content-type".into(), content_type.as_bytes().to_vec()),
            ("cache-control".into(), b"no-store".to_vec()),
            ("x-content-type-options".into(), b"nosniff".to_vec()),
            ("content-security-policy".into(), b"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'".to_vec()),
        ]).unwrap();
        let response = OutgoingResponse::new(fields);
        response.set_status_code(status).unwrap();
        let body = response.body().unwrap();
        ResponseOutparam::set(response_out, Ok(response));
        if !matches!(request.method(), Method::Head) {
            let mut stream = body.write().unwrap();
            stream.write_all(bytes).unwrap();
            stream.flush().unwrap();
        }
        OutgoingBody::finish(body, None).unwrap();
    }
}
