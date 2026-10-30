//! The network a socket-server app sees inside the pVM (httpd.rs `SocketApp`; PVM-CPU.md "Serving buyers").
//!
//! Microdroid gives the payload no inet sockets (a bind there is refused: measured on the Pixel 10 Pro XL), and a socket app
//! needs none of the network anyway: its only job is to accept the connections the front makes. So `wasi:sockets/tcp` and
//! `tcp-create-socket` are this module's, in process, shadowing wasmtime's:
//!   - a socket may be bound only to its app's own port (any IPv4/IPv6 address: there is only the one listener) and put in
//!     listen mode; every other bind is refused (`access-denied`);
//!   - a connect to an outside address is the host's to open (egress.rs: the app's own TUNA route, the host's destination
//!     policy) when the payload gave an `Egress`, and refused (`access-denied`) when it did not; a connect to a loopback
//!     address is always refused (there is nothing else in the VM to reach);
//!   - `ip-name-lookup` asks the host too (through the same route), or answers `permanent-resolver-failure` without one;
//!   - `accept` yields the connections the front opened with `LoopNet::connect` -- an in-memory duplex per connection,
//!     handed to the app as its input and output streams;
//!   - the rest of the socket surface (options, addresses, subscribe, shutdown) answers as a quiet loopback would.
//! UDP stays wasmtime's, disabled for these apps. Nothing here touches the host's network itself.
use crate::egress::Egress;
use std::net::{IpAddr, SocketAddr};
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::io::DuplexStream;
use tokio::sync::mpsc;
use wasmtime::component::{HasData, Resource, ResourceTable};
use wasmtime_wasi::p2::bindings::sockets::network::{ErrorCode, IpAddressFamily, IpSocketAddress, Network};
use wasmtime_wasi::p2::bindings::sockets::tcp::{self, ShutdownType};
use wasmtime_wasi::p2::bindings::sockets::tcp_create_socket;
use wasmtime_wasi::p2::pipe::{AsyncReadStream, AsyncWriteStream};
use wasmtime_wasi::p2::{DynInputStream, DynOutputStream, DynPollable, Pollable, SocketResult, TcpSocket};

/// One app's listener, as the front sees it.
pub struct LoopNet {
    pub port: u16,
    listener: Mutex<Option<mpsc::UnboundedSender<DuplexStream>>>,
    /// the app's way out, when the payload gave one
    egress: Option<Egress>,
}

impl LoopNet {
    pub fn new(port: u16) -> Arc<LoopNet> {
        Self::with_egress(port, None)
    }
    pub fn with_egress(port: u16, egress: Option<Egress>) -> Arc<LoopNet> {
        Arc::new(LoopNet { port, listener: Mutex::new(None), egress })
    }
    /// Is the app listening yet?
    pub fn listening(&self) -> bool {
        self.listener.lock().unwrap_or_else(|p| p.into_inner()).as_ref().is_some_and(|tx| !tx.is_closed())
    }
    /// A new connection to the app: the front's end of an in-memory duplex whose other end the app accepts.
    pub fn connect(&self) -> std::io::Result<DuplexStream> {
        let (app_end, front_end) = tokio::io::duplex(64 << 10);
        let guard = self.listener.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
            Some(tx) if tx.send(app_end).is_ok() => Ok(front_end),
            _ => Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "the app is not listening")),
        }
    }
}

enum State {
    Unbound,
    BindStarted(SocketAddr),
    Bound(SocketAddr),
    ListenStarted(SocketAddr),
    Listening(SocketAddr, mpsc::UnboundedReceiver<DuplexStream>),
    /// an outbound connect the host is opening (its result, once the pollable has seen it)
    Connecting(SocketAddr, Option<tokio::task::JoinHandle<std::io::Result<crate::egress::Stream>>>, Option<std::io::Result<crate::egress::Stream>>),
    Connected(SocketAddr),
}

/// A socket in the app's table (stored in place of wasmtime's TcpSocket, which the bindings name).
pub struct LoopSock {
    state: State,
    family: IpAddressFamily,
    net: Arc<LoopNet>,
    pending: Option<DuplexStream>,
}

#[wasmtime_wasi::async_trait]
impl Pollable for LoopSock {
    async fn ready(&mut self) {
        if self.pending.is_some() {
            return;
        }
        if let State::Listening(_, rx) = &mut self.state {
            match rx.recv().await {
                Some(c) => self.pending = Some(c),
                None => std::future::pending::<()>().await, // the listener is gone: never ready again
            }
        }
        if let State::Connecting(_, task, done) = &mut self.state {
            if let Some(t) = task.take() {
                *done = Some(t.await.unwrap_or_else(|e| Err(std::io::Error::other(e.to_string()))));
            }
        }
    }
}

/// The view the bindings get: the app's table and its LoopNet.
pub struct LoopNetView<'a> {
    pub table: &'a mut ResourceTable,
    pub net: &'a Arc<LoopNet>,
}
pub struct LoopNetData;
impl HasData for LoopNetData {
    type Data<'a> = LoopNetView<'a>;
}

fn mine(r: &Resource<TcpSocket>) -> Resource<LoopSock> {
    Resource::new_borrow(r.rep())
}
fn theirs(r: Resource<LoopSock>) -> Resource<TcpSocket> {
    Resource::new_own(r.rep())
}

impl LoopNetView<'_> {
    fn sock(&mut self, r: &Resource<TcpSocket>) -> SocketResult<&mut LoopSock> {
        Ok(self.table.get_mut(&mine(r))?)
    }
    fn own_port(&self, a: &SocketAddr) -> bool {
        a.port() == self.net.port
    }
}

impl tcp_create_socket::Host for LoopNetView<'_> {
    fn create_tcp_socket(&mut self, address_family: IpAddressFamily) -> SocketResult<Resource<TcpSocket>> {
        let s = self.table.push(LoopSock { state: State::Unbound, family: address_family, net: self.net.clone(), pending: None })?;
        Ok(theirs(s))
    }
}

// the network interface's own two functions, as wasmtime answers them (the bindings for tcp take the error conversion here)
impl wasmtime_wasi::p2::bindings::sockets::network::Host for LoopNetView<'_> {
    fn convert_error_code(&mut self, error: wasmtime_wasi::p2::SocketError) -> wasmtime::Result<ErrorCode> {
        error.downcast()
    }
    fn network_error_code(&mut self, err: Resource<wasmtime::Error>) -> wasmtime::Result<Option<ErrorCode>> {
        let err = self.table.get(&err)?;
        Ok(err.downcast_ref::<std::io::Error>().map(ErrorCode::from))
    }
}
impl wasmtime_wasi::p2::bindings::sockets::network::HostNetwork for LoopNetView<'_> {
    fn drop(&mut self, this: Resource<Network>) -> Result<(), wasmtime::Error> {
        self.table.delete(this)?;
        Ok(())
    }
}

impl tcp::Host for LoopNetView<'_> {}

impl tcp::HostTcpSocket for LoopNetView<'_> {
    async fn start_bind(&mut self, this: Resource<TcpSocket>, network: Resource<Network>, local_address: IpSocketAddress) -> SocketResult<()> {
        _ = self.table.get(&network)?;
        let a: SocketAddr = local_address.into();
        let own = self.own_port(&a);
        let s = self.sock(&this)?;
        if !matches!(s.state, State::Unbound) {
            return Err(ErrorCode::InvalidState.into());
        }
        if !own {
            return Err(ErrorCode::AccessDenied.into()); // only the app's own port, which the front connects to
        }
        s.state = State::BindStarted(a);
        Ok(())
    }
    fn finish_bind(&mut self, this: Resource<TcpSocket>) -> SocketResult<()> {
        let s = self.sock(&this)?;
        match s.state {
            State::BindStarted(a) => {
                s.state = State::Bound(a);
                Ok(())
            }
            _ => Err(ErrorCode::NotInProgress.into()),
        }
    }
    fn start_connect(&mut self, this: Resource<TcpSocket>, network: Resource<Network>, remote: IpSocketAddress) -> SocketResult<()> {
        _ = self.table.get(&network)?;
        let a: SocketAddr = remote.into();
        let eg = self.net.egress.clone();
        let s = self.sock(&this)?;
        if !matches!(s.state, State::Unbound | State::Bound(_)) {
            return Err(ErrorCode::InvalidState.into());
        }
        // the host opens it, through the app's own route; nothing in the VM is reachable, and without egress nothing is
        let Some(eg) = eg else { return Err(ErrorCode::AccessDenied.into()) };
        if a.ip().is_loopback() || a.ip().is_unspecified() || a.port() == 0 {
            return Err(ErrorCode::AccessDenied.into());
        }
        let task = tokio::task::spawn(async move { eg.connect(&a.ip().to_string(), a.port()).await });
        s.state = State::Connecting(a, Some(task), None);
        Ok(())
    }
    fn finish_connect(&mut self, this: Resource<TcpSocket>) -> SocketResult<(Resource<DynInputStream>, Resource<DynOutputStream>)> {
        let s = self.sock(&this)?;
        let State::Connecting(a, task, done) = &mut s.state else { return Err(ErrorCode::NotInProgress.into()) };
        let a = *a;
        if done.is_none() {
            // not polled yet: take a finished task's result now, else the app waits on its pollable
            match task.as_mut().and_then(poll_now) {
                Some(r) => {
                    *task = None;
                    *done = Some(r.unwrap_or_else(|e| Err(std::io::Error::other(e.to_string()))));
                }
                None => return Err(ErrorCode::WouldBlock.into()),
            }
        }
        let r = done.take().expect("set above");
        let stream = match r {
            Ok(st) => st,
            Err(e) => {
                s.state = State::Unbound;
                return Err(match e.kind() {
                    std::io::ErrorKind::TimedOut => ErrorCode::Timeout,
                    std::io::ErrorKind::InvalidInput => ErrorCode::InvalidArgument,
                    _ => ErrorCode::ConnectionRefused,
                }
                .into());
            }
        };
        s.state = State::Connected(a);
        let (r, w) = tokio::io::split(stream);
        let input: DynInputStream = Box::new(AsyncReadStream::new(r));
        let output: DynOutputStream = Box::new(AsyncWriteStream::new(1 << 16, w));
        let input = self.table.push_child(input, &mine(&this))?;
        let output = self.table.push_child(output, &mine(&this))?;
        Ok((input, output))
    }
    async fn start_listen(&mut self, this: Resource<TcpSocket>) -> SocketResult<()> {
        let s = self.sock(&this)?;
        match s.state {
            State::Bound(a) => {
                s.state = State::ListenStarted(a);
                Ok(())
            }
            _ => Err(ErrorCode::InvalidState.into()),
        }
    }
    fn finish_listen(&mut self, this: Resource<TcpSocket>) -> SocketResult<()> {
        let net = self.net.clone();
        let s = self.sock(&this)?;
        let State::ListenStarted(a) = s.state else { return Err(ErrorCode::NotInProgress.into()) };
        let mut l = net.listener.lock().unwrap_or_else(|p| p.into_inner());
        if l.as_ref().is_some_and(|tx| !tx.is_closed()) {
            return Err(ErrorCode::AddressInUse.into()); // one listener on the app's port
        }
        let (tx, rx) = mpsc::unbounded_channel();
        *l = Some(tx);
        s.state = State::Listening(a, rx);
        Ok(())
    }
    fn accept(&mut self, this: Resource<TcpSocket>) -> SocketResult<(Resource<TcpSocket>, Resource<DynInputStream>, Resource<DynOutputStream>)> {
        let net = self.net.clone();
        let s = self.sock(&this)?;
        let State::Listening(local, rx) = &mut s.state else { return Err(ErrorCode::InvalidState.into()) };
        let local = *local;
        let conn = match s.pending.take() {
            Some(c) => c,
            None => rx.try_recv().map_err(|_| ErrorCode::WouldBlock)?,
        };
        let fam = s.family;
        let peer = SocketAddr::from(([127, 0, 0, 1], 1)); // the front, in this process
        let sock = self.table.push(LoopSock { state: State::Connected(peer), family: fam, net, pending: None })?;
        let (r, w) = tokio::io::split(conn);
        let input: DynInputStream = Box::new(AsyncReadStream::new(r));
        let output: DynOutputStream = Box::new(AsyncWriteStream::new(1 << 16, w));
        let input = self.table.push_child(input, &sock)?;
        let output = self.table.push_child(output, &sock)?;
        let _ = local;
        Ok((theirs(sock), input, output))
    }
    fn local_address(&mut self, this: Resource<TcpSocket>) -> SocketResult<IpSocketAddress> {
        let port = self.net.port;
        match &self.sock(&this)?.state {
            State::Bound(a) | State::ListenStarted(a) | State::Listening(a, _) => Ok((*a).into()),
            State::Connecting(..) => Ok(SocketAddr::from(([127, 0, 0, 1], 0)).into()),
            State::Connected(_) => Ok(SocketAddr::from(([127, 0, 0, 1], port)).into()),
            _ => Err(ErrorCode::InvalidState.into()),
        }
    }
    fn remote_address(&mut self, this: Resource<TcpSocket>) -> SocketResult<IpSocketAddress> {
        match &self.sock(&this)?.state {
            State::Connected(a) => Ok((*a).into()),
            _ => Err(ErrorCode::InvalidState.into()),
        }
    }
    fn is_listening(&mut self, this: Resource<TcpSocket>) -> Result<bool, wasmtime::Error> {
        Ok(matches!(self.table.get(&mine(&this))?.state, State::Listening(..)))
    }
    fn address_family(&mut self, this: Resource<TcpSocket>) -> Result<IpAddressFamily, wasmtime::Error> {
        Ok(self.table.get(&mine(&this))?.family)
    }
    fn set_listen_backlog_size(&mut self, this: Resource<TcpSocket>, _value: u64) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn keep_alive_enabled(&mut self, this: Resource<TcpSocket>) -> SocketResult<bool> {
        _ = self.sock(&this)?;
        Ok(false)
    }
    fn set_keep_alive_enabled(&mut self, this: Resource<TcpSocket>, _value: bool) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn keep_alive_idle_time(&mut self, this: Resource<TcpSocket>) -> SocketResult<u64> {
        _ = self.sock(&this)?;
        Ok(7_200_000_000_000)
    }
    fn set_keep_alive_idle_time(&mut self, this: Resource<TcpSocket>, _value: u64) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn keep_alive_interval(&mut self, this: Resource<TcpSocket>) -> SocketResult<u64> {
        _ = self.sock(&this)?;
        Ok(75_000_000_000)
    }
    fn set_keep_alive_interval(&mut self, this: Resource<TcpSocket>, _value: u64) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn keep_alive_count(&mut self, this: Resource<TcpSocket>) -> SocketResult<u32> {
        _ = self.sock(&this)?;
        Ok(9)
    }
    fn set_keep_alive_count(&mut self, this: Resource<TcpSocket>, _value: u32) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn hop_limit(&mut self, this: Resource<TcpSocket>) -> SocketResult<u8> {
        _ = self.sock(&this)?;
        Ok(64)
    }
    fn set_hop_limit(&mut self, this: Resource<TcpSocket>, _value: u8) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn receive_buffer_size(&mut self, this: Resource<TcpSocket>) -> SocketResult<u64> {
        _ = self.sock(&this)?;
        Ok(64 << 10)
    }
    fn set_receive_buffer_size(&mut self, this: Resource<TcpSocket>, _value: u64) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn send_buffer_size(&mut self, this: Resource<TcpSocket>) -> SocketResult<u64> {
        _ = self.sock(&this)?;
        Ok(64 << 10)
    }
    fn set_send_buffer_size(&mut self, this: Resource<TcpSocket>, _value: u64) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(())
    }
    fn subscribe(&mut self, this: Resource<TcpSocket>) -> wasmtime::Result<Resource<DynPollable>> {
        wasmtime_wasi::p2::subscribe(self.table, mine(&this))
    }
    fn shutdown(&mut self, this: Resource<TcpSocket>, _how: ShutdownType) -> SocketResult<()> {
        _ = self.sock(&this)?;
        Ok(()) // the streams end the connection when the app drops them
    }
    fn drop(&mut self, this: Resource<TcpSocket>) -> Result<(), wasmtime::Error> {
        let s = self.table.delete(Resource::<LoopSock>::new_own(this.rep()))?;
        if let State::Listening(..) = s.state {
            *s.net.listener.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        Ok(())
    }
}

// ---- wasi:sockets/ip-name-lookup: the host's, through the app's own route (egress.rs), or a resolver failure ----
use wasmtime_wasi::p2::bindings::sockets::ip_name_lookup;
use wasmtime_wasi::p2::bindings::sockets::network::IpAddress;
use wasmtime_wasi::p2::bindings::sockets::ip_name_lookup::ResolveAddressStream;

/// A lookup in the app's table (stored in place of wasmtime's ResolveAddressStream).
pub struct LoopResolve {
    task: Option<tokio::task::JoinHandle<std::io::Result<Vec<IpAddr>>>>,
    done: Option<Result<std::vec::IntoIter<IpAddr>, ErrorCode>>,
}
#[wasmtime_wasi::async_trait]
impl Pollable for LoopResolve {
    async fn ready(&mut self) {
        if let Some(t) = self.task.take() {
            self.done = Some(match t.await {
                Ok(Ok(v)) => Ok(v.into_iter()),
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidInput => Err(ErrorCode::InvalidArgument),
                _ => Err(ErrorCode::NameUnresolvable),
            });
        }
    }
}
fn mine_r(r: &Resource<ResolveAddressStream>) -> Resource<LoopResolve> {
    Resource::new_borrow(r.rep())
}

impl ip_name_lookup::Host for LoopNetView<'_> {
    fn resolve_addresses(&mut self, network: Resource<Network>, name: String) -> SocketResult<Resource<ResolveAddressStream>> {
        _ = self.table.get(&network)?;
        let entry = match self.net.egress.clone() {
            Some(eg) => LoopResolve { task: Some(tokio::task::spawn(async move { eg.resolve(&name).await })), done: None },
            None => LoopResolve { task: None, done: Some(Err(ErrorCode::PermanentResolverFailure)) },
        };
        let r = self.table.push(entry)?;
        Ok(Resource::new_own(r.rep()))
    }
}
impl ip_name_lookup::HostResolveAddressStream for LoopNetView<'_> {
    fn resolve_next_address(&mut self, this: Resource<ResolveAddressStream>) -> SocketResult<Option<IpAddress>> {
        let r = self.table.get_mut(&mine_r(&this))?;
        if r.done.is_none() {
            match r.task.as_mut().and_then(poll_now) {
                Some(res) => {
                    r.task = None;
                    r.done = Some(match res {
                        Ok(Ok(v)) => Ok(v.into_iter()),
                        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidInput => Err(ErrorCode::InvalidArgument),
                        _ => Err(ErrorCode::NameUnresolvable),
                    });
                }
                None => return Err(ErrorCode::WouldBlock.into()),
            }
        }
        match r.done.as_mut().expect("set above") {
            Ok(it) => Ok(it.next().map(Into::into)),
            Err(e) => Err((*e).into()),
        }
    }
    fn subscribe(&mut self, this: Resource<ResolveAddressStream>) -> wasmtime::Result<Resource<DynPollable>> {
        wasmtime_wasi::p2::subscribe(self.table, mine_r(&this))
    }
    async fn drop(&mut self, this: Resource<ResolveAddressStream>) -> Result<(), wasmtime::Error> {
        let r = self.table.delete(Resource::<LoopResolve>::new_own(this.rep()))?;
        if let Some(t) = r.task {
            t.abort();
        }
        Ok(())
    }
}

/// A task's result if it is ready now, without blocking (None: not yet, the caller's pollable waits for it).
fn poll_now<T>(t: &mut tokio::task::JoinHandle<T>) -> Option<Result<T, tokio::task::JoinError>> {
    let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
    match std::pin::Pin::new(t).poll(&mut cx) {
        std::task::Poll::Ready(r) => Some(r),
        std::task::Poll::Pending => None,
    }
}
