//! AF_HYPERV on the host side of the domain's only channel. A Linux guest speaks AF_VSOCK; the
//! hv_sock transport maps vsock port N to the service GUID N-facb-11e6-bd58-64006a7986d3 and the host
//! to CID 2. On the host the peer of every connection is a PARTITION, named by the VmId in the
//! accepted address, which the hypervisor fills in and the guest cannot choose. That VmId is the
//! credential the monitor keys its table by: the analogue of the kernel peer credentials the m3
//! monitor uses on Linux.
//!
//! Sockets are wrapped in std::net::TcpStream (a SOCKET is a SOCKET to Winsock's send/recv), which
//! gives us Read/Write, timeouts and shutdown without a second socket layer.
use std::io;
use std::mem::size_of;
use std::net::TcpStream;
use std::os::windows::io::FromRawSocket;
use windows_sys::core::GUID;
use windows_sys::Win32::Networking::WinSock::*;

pub const AF_HYPERV_: i32 = 34;
pub const HV_PROTOCOL_RAW_: i32 = 1;
/// hvsocket.h: socket option (level HV_PROTOCOL_RAW) bounding a connect, in milliseconds.
pub const HVSOCKET_CONNECT_TIMEOUT_: i32 = 0x01;

/// hvsocket.h SOCKADDR_HV, which windows-sys 0.61 does not carry.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct SockaddrHv {
    pub family: u16,
    pub reserved: u16,
    pub vm_id: GUID,
    pub service_id: GUID,
}

pub fn wsa_init() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let mut d: WSADATA = std::mem::zeroed();
        WSAStartup(0x0202, &mut d);
    });
}

/// vsock port -> hv_sock service id (Linux net/vmw_vsock/hyperv_transport.c srv_id_template).
pub fn service_id(port: u32) -> GUID {
    GUID { data1: port, data2: 0xfacb, data3: 0x11e6, data4: [0xbd, 0x58, 0x64, 0x00, 0x6a, 0x79, 0x86, 0xd3] }
}

pub fn parse_guid(s: &str) -> Option<GUID> {
    let s = s.trim().trim_start_matches('{').trim_end_matches('}');
    let p: Vec<&str> = s.split('-').collect();
    if p.len() != 5 {
        return None;
    }
    let d1 = u32::from_str_radix(p[0], 16).ok()?;
    let d2 = u16::from_str_radix(p[1], 16).ok()?;
    let d3 = u16::from_str_radix(p[2], 16).ok()?;
    let t = hex::decode(format!("{}{}", p[3], p[4])).ok()?;
    if t.len() != 8 {
        return None;
    }
    let mut d4 = [0u8; 8];
    d4.copy_from_slice(&t);
    Some(GUID { data1: d1, data2: d2, data3: d3, data4: d4 })
}

pub fn guid_string(g: &GUID) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        g.data1, g.data2, g.data3, g.data4[0], g.data4[1], g.data4[2], g.data4[3], g.data4[4], g.data4[5], g.data4[6], g.data4[7]
    )
}

fn addr(vm: &GUID, port: u32) -> SockaddrHv {
    SockaddrHv { family: AF_HYPERV_ as u16, reserved: 0, vm_id: *vm, service_id: service_id(port) }
}

fn last() -> io::Error {
    io::Error::from_raw_os_error(unsafe { WSAGetLastError() })
}

pub struct Listener {
    s: SOCKET,
    pub vm: GUID,
    pub port: u32,
}
unsafe impl Send for Listener {}

impl Listener {
    /// Listen for connections from ONE partition on one vsock port. Binding to a specific VmId is what
    /// the partition document's DefaultBindSecurityDescriptor covers; a wildcard bind would need a
    /// registry-listed service, which this control plane deliberately does not add to the host.
    pub fn bind(vm: &GUID, port: u32) -> io::Result<Listener> {
        wsa_init();
        unsafe {
            let s = socket(AF_HYPERV_, SOCK_STREAM as i32, HV_PROTOCOL_RAW_);
            if s == INVALID_SOCKET {
                return Err(last());
            }
            let a = addr(vm, port);
            if bind(s, &a as *const _ as *const SOCKADDR, size_of::<SockaddrHv>() as i32) != 0 {
                let e = last();
                closesocket(s);
                return Err(e);
            }
            if listen(s, 16) != 0 {
                let e = last();
                closesocket(s);
                return Err(e);
            }
            Ok(Listener { s, vm: *vm, port })
        }
    }

    /// Accept one connection and return it with the PEER PARTITION's id: the identity the hypervisor
    /// attached to the connection.
    pub fn accept(&self) -> io::Result<(TcpStream, GUID)> {
        unsafe {
            let mut a: SockaddrHv = std::mem::zeroed();
            let mut n = size_of::<SockaddrHv>() as i32;
            let c = accept(self.s, &mut a as *mut _ as *mut SOCKADDR, &mut n);
            if c == INVALID_SOCKET {
                return Err(last());
            }
            Ok((TcpStream::from_raw_socket(c as _), a.vm_id))
        }
    }

    /// Accept with a deadline. Winsock's SO_RCVTIMEO does not apply to accept(), so this waits with
    /// select() first and only then accepts; Ok(None) is the deadline passing.
    pub fn accept_timeout(&self, ms: u32) -> io::Result<Option<(TcpStream, GUID)>> {
        unsafe {
            let mut set: FD_SET = std::mem::zeroed();
            set.fd_count = 1;
            set.fd_array[0] = self.s;
            let tv = TIMEVAL { tv_sec: (ms / 1000) as i32, tv_usec: ((ms % 1000) * 1000) as i32 };
            let r = select(0, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), &tv);
            if r == SOCKET_ERROR {
                return Err(last());
            }
            if r == 0 {
                return Ok(None);
            }
        }
        self.accept().map(Some)
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        unsafe {
            closesocket(self.s);
        }
    }
}

/// Connect INTO a partition's vsock port (the domain's serving port). The host is the only side
/// that can do this: hv_sock has no guest-to-guest path, so one domain cannot dial another.
pub fn dial(vm: &GUID, port: u32, timeout: std::time::Duration) -> io::Result<TcpStream> {
    wsa_init();
    unsafe {
        let s = socket(AF_HYPERV_, SOCK_STREAM as i32, HV_PROTOCOL_RAW_);
        if s == INVALID_SOCKET {
            return Err(last());
        }
        // HVSOCKET_CONNECT_TIMEOUT (ms), SOL = HV_PROTOCOL_RAW: bounds the connect
        let ms = timeout.as_millis() as u32;
        setsockopt(s, HV_PROTOCOL_RAW_, HVSOCKET_CONNECT_TIMEOUT_, &ms as *const _ as *const u8, size_of::<u32>() as i32);
        let a = addr(vm, port);
        if connect(s, &a as *const _ as *const SOCKADDR, size_of::<SockaddrHv>() as i32) != 0 {
            let e = last();
            closesocket(s);
            return Err(e);
        }
        Ok(TcpStream::from_raw_socket(s as _))
    }
}
