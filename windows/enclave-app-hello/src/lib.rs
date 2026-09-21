// A tenant app for the enclave world. It imports nothing but the enclave's own host functions, so
// the whole of it runs inside VTL1: no sockets, no files, no clock of its own.
wit_bindgen::generate!({ path: "../enclave-rt/wit", world: "app" });
use crate::enclave::app::host;
use crate::enclave::app::types::Header;

struct App;

impl Guest for App {
    fn handle(req: Request) -> Response {
        host::log(&format!("{} {}", req.method, req.path));
        let name = req.path.split("name=").nth(1).unwrap_or("world").to_string();
        let body: Vec<u8> = match req.path.split('?').next().unwrap_or("/") {
            // proves the app can reach the model WITHOUT leaving the enclave
            "/ask" => host::generate(&name, 16).into_bytes(),
            "/rand" => {
                let r = host::random(8);
                format!("{:?} at {}", r, host::now_ms()).into_bytes()
            }
            _ => format!("hello {} from inside the enclave", name).into_bytes(),
        };
        Response {
            status: 200,
            headers: vec![Header { name: "content-type".to_string(), value: "text/plain".to_string() },
                          Header { name: "x-runs-in".to_string(), value: "vtl1".to_string() }],
            body,
        }
    }
}
export!(App);
