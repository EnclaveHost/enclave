use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};

use base64::engine::general_purpose::URL_SAFE;
use base64::prelude::*;
use chrono::{DateTime, Utc};
use reqwest::{Method, StatusCode};
use sia_core::rhp4::{AccountToken, SECTOR_SIZE};
use sia_core::signing::{PrivateKey, PublicKey};
use sia_core::types::Hash256;

use super::{
    AuthApproval, Error, KeyResponse, PinObjectError, RegisterAppResponse, SHARE_URL_SCHEME,
    SealedObjectEvent, SharedHost, SlabPinParams, Url, sign,
};
use crate::encryption::EncryptionKey;
use crate::hosts::Host;
use crate::sharing::{KeyRequest, Nonce, SharedObjectRequest};
use crate::slabs::{SealedObjectSummary, Slab};
use crate::time::Duration;
use crate::{Account, App, AppMetadata, HostQuery, KeyStats, Object, ObjectsCursor, SealedObject};
use crate::fence::{FenceCredential, FenceRaise, FenceReceipt, FenceSlot, FenceState, FenceToken};

const MOCK_AUTHORITY: &str = "mock.indexd";

#[derive(Debug)]
struct StoredObject {
    /// `None` once the object has been deleted. The tombstone is retained so
    /// [`Client::objects`] reports the deletion, matching the indexer.
    sealed: Option<SealedObject>,
    updated_at: DateTime<Utc>,
}

/// A sharing key and the objects attached to it.
#[derive(Debug)]
struct StoredSharingKey {
    account: PublicKey,
    public_key: PublicKey,
    nonce: Nonce,
    description: String,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    attached: HashMap<Hash256, SealedObject>,
}

/// What the mock keeps per pinned slab. Only the shard counts are read back,
/// for the account figures.
#[derive(Debug)]
struct StoredSlab {
    min_shards: u8,
    sectors: usize,
}

#[derive(Debug, Default)]
struct State {
    hosts: Vec<Host>,
    objects: HashMap<Hash256, StoredObject>,
    slabs: HashMap<Hash256, StoredSlab>,
    user_secret: Hash256,
    pin_slabs_calls: usize,
    #[cfg(test)]
    pin_slabs_requests: Vec<Vec<SlabPinParams>>,
    pin_slabs_errors: VecDeque<Error>,
    sharing_keys: HashMap<PublicKey, StoredSharingKey>,
    /// While set, every account-facing call fails as an unreachable indexer would.
    offline: bool,
    /// Faults the next calls of an operation suffer, in order (see [`crate::mock::Fault`]).
    faults: HashMap<&'static str, VecDeque<crate::mock::Fault>>,
    /// PATCH U1: while set, pins and deletes stay unpublished, as indexd's object events do until its publisher
    /// stamps them (1 s ticks, or a stall): the event feed (`objects`) leaves them out, `current_objects` does not.
    hold_publication: bool,
    unpublished: std::collections::HashSet<Hash256>,
    /// PATCH (writer fencing): the account's installed fence and the receipt issued for it (interface v3 section 2)
    fence: Option<FenceToken>,
    fence_receipt: Option<[u8; 16]>,
    /// raises the indexer applied (installed), for tests
    fence_raises: usize,
    /// PATCH C2 (G-C2 v4.0): sticky CAS enrolment, the account's event sequence head, and the last head-advancing
    /// operation (id and server-computed digest; cleared by every raise)
    cas_mode: bool,
    seq: u64,
    last_op: Option<([u8; 16], [u8; 32])>,
    /// PATCH C2, TEST ONLY: an old indexd without the "cas-v4" capability
    no_cas_capability: bool,
    /// PATCH C2, TEST ONLY: an indexd with cas-v4 but before G-C2 R2 (no "op-nonce" capability, no opNonce)
    no_op_nonce: bool,
    /// PATCH U1-B (blocked listing): object keys the indexer's operator blocked (indexd's blocklist is by object key,
    /// across accounts): hidden from the feed, refused by `object` and by a re-pin (451), listed flagged and without
    /// the object by `current_objects` (which models `?blocked=true`, the only way the SDK asks)
    blocked: std::collections::HashSet<Hash256>,
    /// PATCH U1-B: the most entries one `current_objects` page returns, whatever the limit asked (None: the limit)
    page_limit: Option<usize>,
}

/// PATCH (writer fencing): the exact check every fenced mutation runs, at the moment the indexer applies it.
fn fence_check(state: &State, cred: Option<FenceCredential>) -> Result<(), Option<FenceToken>> {
    match (state.fence, cred) {
        (None, None) => Ok(()),
        (None, Some(_)) => Err(None),
        (Some(f), Some(c)) if c.token == f && Some(c.receipt.0) == state.fence_receipt => Ok(()),
        (Some(f), _) => Err(Some(f)),
    }
}

fn fence_refusal_error(current: Option<FenceToken>) -> Error {
    Error::Fenced(current)
}

/// An in-memory stand-in for the indexer API.
///
/// Only the behaviour the SDK depends on is modelled: objects are stored as the
/// [`SealedObject`] they were pinned with, so `seal`/`open` still round-trips,
/// and [`Client::hosts`] honours `offset`/`limit` so the SDK's paged host
/// refresh terminates. Other [`HostQuery`] filters are ignored.
/// A call the mock indexer will apply only when the test says so.
type Deferred = Box<dyn FnOnce(&Client) + Send>;

#[derive(Clone, Default)]
pub(crate) struct Client {
    state: Arc<RwLock<State>>,
    deferred: Arc<std::sync::Mutex<Vec<Deferred>>>,
    /// PATCH (writer fencing): CLIENT-side state (the credential this SDK presents); not indexer state. Each SDK built
    /// on a mock network gets its own (`for_new_client`).
    fence: FenceSlot,
}

#[cfg(test)]
impl Client {
    /// Returns the slab pin parameters sent in each call to [`Client::pin_slabs`],
    /// including the calls made to fail.
    pub(crate) fn pin_slabs_requests(&self) -> Vec<Vec<SlabPinParams>> {
        self.state.read().unwrap().pin_slabs_requests.clone()
    }
}

impl Client {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// PATCH (writer fencing): the same mock indexer, seen by a new client (its own credential slot).
    pub(crate) fn for_new_client(&self) -> Self {
        Self { state: self.state.clone(), deferred: self.deferred.clone(), fence: FenceSlot::default() }
    }

    pub(crate) fn fence_slot(&self) -> &FenceSlot {
        &self.fence
    }

    fn cred(&self) -> Option<FenceCredential> {
        self.fence.lock().unwrap().cred
    }

    /// PATCH C2: does this client send v4 requests (it enrolled)? Non-advancing routes carry a fresh op then.
    fn v4(&self) -> bool {
        !matches!(self.fence.lock().unwrap().c2, crate::fence::C2State::Off)
    }

    /// PATCH C2, TEST ONLY: model an old indexd without the "cas-v4" capability.
    pub(crate) fn set_no_cas_capability(&self, old: bool) {
        self.state.write().unwrap().no_cas_capability = old;
    }

    /// PATCH C2, TEST ONLY: model a cas-v4 indexd before G-C2 R2 (no op-nonce).
    pub(crate) fn set_no_op_nonce(&self, old: bool) {
        self.state.write().unwrap().no_op_nonce = old;
    }

    /// PATCH C2, TEST ONLY: the account's head and CAS mode.
    pub(crate) fn c2_head(&self) -> (u64, bool) {
        let st = self.state.read().unwrap();
        (st.seq, st.cas_mode)
    }

    /// Records a fenced refusal on this client (the first one) and returns the error.
    fn refused(&self, current: Option<FenceToken>) -> Error {
        let mut st = self.fence.lock().unwrap();
        if st.conflict.is_none() {
            st.conflict = Some(current);
        }
        fence_refusal_error(current)
    }

    /// PATCH (writer fencing): the installed fence, for tests.
    pub(crate) fn installed_fence(&self) -> Option<FenceToken> {
        self.state.read().unwrap().fence
    }

    pub(crate) fn fence_raises(&self) -> usize {
        self.state.read().unwrap().fence_raises
    }

    /// PATCH (writer fencing): `GET /fence`.
    pub(crate) async fn fence_get(&self, _: &PrivateKey) -> Result<FenceState, Error> {
        self.reachable()?;
        // fault op "fence_get": Hang models a GET /fence that never answers (the reader times out)
        if let Some(crate::mock::Fault::Hang) = self.take_fault("fence_get") {
            return std::future::pending().await;
        }
        let state = self.state.read().unwrap();
        use sha2::Digest;
        Ok(FenceState {
            fence: state.fence,
            receipt_sha256: state.fence_receipt.map(|r| sha2::Sha256::digest(r).into()),
            seq: Some(state.seq),
            last_op: state.last_op.map(|(o, _)| o),
            last_op_digest: state.last_op.map(|(_, d)| d),
            cas_mode: state.cas_mode,
            capabilities: if state.no_cas_capability {
                vec!["fence-v3".into()]
            } else if state.no_op_nonce {
                vec!["fence-v3".into(), crate::fence::C2_CAPABILITY.into()]
            } else {
                vec!["fence-v3".into(), crate::fence::C2_CAPABILITY.into(), crate::fence::C2_NONCE_CAPABILITY.into()]
            },
            // G-C2 R2: fresh entropy in every answer, never stored
            op_nonce: (!state.no_cas_capability && !state.no_op_nonce).then(rand::random),
        })
    }

    /// PATCH (writer fencing): `POST /fence`: install only a strictly greater token; a new receipt every time. Faults
    /// apply under the op name "fence_raise" (e.g. ApplyThenFail: installed, response lost).
    /// PATCH C2: `cas` sends "mode": "cas" (sticky enrolment; an old indexd ignores it). On an enrolled account a raise
    /// without it is refused (412 mode). Every install clears the last operation. Returns the head with an install.
    pub(crate) async fn fence_raise(&self, _: &PrivateKey, token: FenceToken, cas: bool) -> Result<(FenceRaise, Option<u64>), Error> {
        self.reachable()?;
        self.with_fault("fence_raise", move |me| {
            let mut state = me.state.write().unwrap();
            if state.cas_mode && !cas {
                return Err(Error::ModeConflict);
            }
            if state.fence.is_none_or(|f| token > f) {
                let receipt: [u8; 16] = rand::random();
                state.fence = Some(token);
                state.fence_receipt = Some(receipt);
                state.fence_raises += 1;
                state.last_op = None;
                if cas && !state.no_cas_capability {
                    state.cas_mode = true;
                }
                Ok((FenceRaise::Installed(FenceCredential { token, receipt: FenceReceipt(receipt) }), Some(state.seq)))
            } else {
                Ok((FenceRaise::Refused(state.fence), None))
            }
        })
        .await
    }

    /// PATCH C2 (G-C2 v4.0 section 4): the CAS gate of a head-advancing mutation, checked after the fence and before
    /// any side effect. Ok(None): apply. Ok(Some(seq)): the identical operation was applied already (replayed; apply
    /// nothing). A v3 request on an enrolled account, or a v4 one that is not at the head, is refused.
    fn cas_gate(state: &State, v4: Option<crate::fence::C2Op>, digest: impl FnOnce() -> [u8; 32]) -> Result<Option<u64>, Error> {
        let Some(v4) = v4 else {
            return if state.cas_mode { Err(Error::ModeConflict) } else { Ok(None) };
        };
        let Some(sq) = v4.sq else {
            return Err(Error::Api(StatusCode::BAD_REQUEST, "sq is required on a head-advancing route".into()));
        };
        if !state.cas_mode {
            return Err(Error::SeqConflict(None));
        }
        if state.seq == sq {
            return Ok(None);
        }
        if state.seq == sq + 1 {
            if let Some((op, d)) = state.last_op {
                if op == v4.op {
                    return if d == digest() { Ok(Some(state.seq)) } else { Err(Error::OpConflict(Some(state.seq))) };
                }
            }
        }
        Err(Error::SeqConflict(Some(state.seq)))
    }

    /// PATCH C2: after an applied head-advancing mutation: the head advances and a v4 operation is recorded.
    fn cas_applied(state: &mut State, v4: Option<crate::fence::C2Op>, digest: [u8; 32]) -> Option<crate::fence::C2Answer> {
        state.seq += 1;
        v4.map(|v| {
            state.last_op = Some((v.op, digest));
            crate::fence::C2Answer { seq: state.seq, replayed: false }
        })
    }

    /// Appends to the host list returned by [`Client::hosts`].
    pub(crate) fn add_hosts(&self, hosts: Vec<Host>) {
        self.state.write().unwrap().hosts.extend(hosts);
    }

    /// Returns the number of slabs currently pinned.
    pub(crate) fn pinned_slabs(&self) -> usize {
        self.state.read().unwrap().slabs.len()
    }

    /// Makes the next `failures` calls to [`Client::pin_slabs`] fail with an
    /// [`Error::Api`] before they resume succeeding.
    pub(crate) fn set_pin_slabs_failures(&self, failures: usize) {
        self.set_pin_slabs_errors((0..failures).map(|_| {
            Error::Api(
                StatusCode::INTERNAL_SERVER_ERROR,
                "temporary pin failure".to_string(),
            )
        }));
    }

    /// Returns the given errors on successive pin requests, then succeeds.
    pub(crate) fn set_pin_slabs_errors(&self, errors: impl IntoIterator<Item = Error>) {
        self.state.write().unwrap().pin_slabs_errors = errors.into_iter().collect();
    }

    /// Returns the number of times [`Client::pin_slabs`] has been called,
    /// including the calls made to fail.
    pub(crate) fn pin_slabs_calls(&self) -> usize {
        self.state.read().unwrap().pin_slabs_calls
    }

    /// Makes the indexer unreachable (or reachable again). Stored objects and
    /// slabs are kept, as they would be across a real outage.
    pub(crate) fn set_offline(&self, offline: bool) {
        self.state.write().unwrap().offline = offline;
    }

    /// PATCH U1: hold (or release, publishing everything held) object-event publication.
    pub(crate) fn hold_publication(&self, hold: bool) {
        let mut state = self.state.write().unwrap();
        state.hold_publication = hold;
        if !hold {
            state.unpublished.clear();
        }
    }

    /// PATCH U1-B: the indexer's operator blocks (or unblocks) an object key, as its admin API does.
    pub(crate) fn block_object(&self, key: Hash256, blocked: bool) {
        let mut state = self.state.write().unwrap();
        if blocked {
            state.blocked.insert(key);
        } else {
            state.blocked.remove(&key);
        }
    }

    /// PATCH U1-B: cap every `current_objects` page at `n` entries (a server whose pages are shorter than asked).
    pub(crate) fn set_page_limit(&self, n: Option<usize>) {
        self.state.write().unwrap().page_limit = n;
    }

    /// Queues `fault` for the next call of `op` (`"pin_object"`, `"pin_slabs"` or `"delete_object"`).
    pub(crate) fn push_fault(&self, op: &'static str, fault: crate::mock::Fault) {
        self.state.write().unwrap().faults.entry(op).or_default().push_back(fault);
    }

    fn take_fault(&self, op: &'static str) -> Option<crate::mock::Fault> {
        self.state.write().unwrap().faults.get_mut(op).and_then(|q| q.pop_front())
    }

    /// Runs `apply` as the fault for `op` dictates: normally; then reporting a
    /// lost response; never answering; or applying it later, in the background,
    /// while the caller waits forever (a request the client gave up on that the
    /// indexer still carries out).
    async fn with_fault<T, E: From<Error>>(
        &self,
        op: &'static str,
        apply: impl FnOnce(&Client) -> Result<T, E> + Send + 'static,
    ) -> Result<T, E>
    where
        T: Send + 'static,
        E: Send + 'static,
    {
        use crate::mock::Fault;
        match self.take_fault(op) {
            None => apply(self),
            Some(Fault::ApplyThenFail) => {
                apply(self)?;
                Err(Error::Api(StatusCode::BAD_GATEWAY, format!("{op}: response lost")).into())
            }
            Some(Fault::Hang) => std::future::pending().await,
            Some(Fault::ApplyLate(delay)) => {
                let me = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _ = apply(&me);
                });
                std::future::pending().await
            }
            Some(Fault::Pass) => apply(self),
            Some(Fault::ApplyThenLose) => {
                // the request reaches the indexer (applied or refused there), and its answer, whatever it was, is lost
                let _ = apply(self);
                Err(Error::Api(StatusCode::BAD_GATEWAY, format!("{op}: response lost")).into())
            }
            Some(Fault::Reject) => Err(Error::Api(StatusCode::BAD_REQUEST, format!("{op}: rejected (test fault)")).into()),
            Some(Fault::Defer) => {
                self.deferred.lock().unwrap().push(Box::new(move |me: &Client| {
                    let _ = apply(me);
                }));
                std::future::pending().await
            }
        }
    }

    /// Applies every deferred call now, in the order they were made; returns how many.
    pub(crate) fn apply_deferred(&self) -> usize {
        let calls: Vec<Deferred> = std::mem::take(&mut *self.deferred.lock().unwrap());
        let n = calls.len();
        for call in calls {
            call(self);
        }
        n
    }

    fn reachable(&self) -> Result<(), Error> {
        if self.state.read().unwrap().offline {
            return Err(Error::Api(
                StatusCode::SERVICE_UNAVAILABLE,
                "mock indexer offline".to_string(),
            ));
        }
        Ok(())
    }

    pub(crate) async fn check_app_authenticated(&self, _: &PrivateKey) -> Result<bool, Error> {
        self.reachable()?;
        Ok(true)
    }

    pub(crate) async fn request_app_connection(
        &self,
        _: &PrivateKey,
        _: &AppMetadata,
    ) -> Result<RegisterAppResponse, Error> {
        let base = format!("{SHARE_URL_SCHEME}://{MOCK_AUTHORITY}/auth/connect/mock");
        Ok(RegisterAppResponse {
            response_url: base.clone(),
            status_url: format!("{base}/status"),
            register_url: format!("{base}/register"),
            expiration: Utc::now() + Duration::from_secs(600),
        })
    }

    pub(crate) async fn request_app_connection_pre_authorized(
        &self,
        ephemeral_key: &PrivateKey,
        opts: &AppMetadata,
        _: &PrivateKey,
    ) -> Result<RegisterAppResponse, Error> {
        self.request_app_connection(ephemeral_key, opts).await
    }

    pub(crate) async fn check_request_status(
        &self,
        _: &PrivateKey,
        _: Url,
    ) -> Result<Option<AuthApproval>, Error> {
        Ok(Some(AuthApproval {
            user_secret: self.state.read().unwrap().user_secret,
            reconnecting: false,
        }))
    }

    pub(crate) async fn register_app(
        &self,
        _: &PrivateKey,
        _: &PrivateKey,
        _: Url,
    ) -> Result<(), Error> {
        Ok(())
    }

    pub(crate) async fn hosts(&self, _: &PrivateKey, query: HostQuery) -> Result<Vec<Host>, Error> {
        self.reachable()?;
        let state = self.state.read().unwrap();
        let offset = query.offset.unwrap_or(0) as usize;
        let limit = query.limit.map_or(usize::MAX, |l| l as usize);
        Ok(state
            .hosts
            .iter()
            .skip(offset)
            .take(limit)
            .map(|h| Host {
                public_key: h.public_key,
                addresses: h.addresses.clone(),
                country_code: h.country_code.clone(),
                latitude: h.latitude,
                longitude: h.longitude,
                good_for_upload: h.good_for_upload,
            })
            .collect())
    }

    pub(crate) async fn object(
        &self,
        _: &PrivateKey,
        key: &Hash256,
    ) -> Result<SealedObject, Error> {
        self.reachable()?;
        if self.state.read().unwrap().blocked.contains(key) {
            return Err(Error::Api(StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS, "object is unavailable for legal reasons".into()));
        }
        self.state
            .read()
            .unwrap()
            .objects
            .get(key)
            .and_then(|o| o.sealed.clone())
            .ok_or_else(|| Error::Api(StatusCode::NOT_FOUND, format!("object {key} not found")))
    }

    pub(crate) async fn objects(
        &self,
        _: &PrivateKey,
        cursor: Option<ObjectsCursor>,
        limit: Option<usize>,
    ) -> Result<Vec<SealedObjectEvent>, Error> {
        self.reachable()?;
        let state = self.state.read().unwrap();
        let mut events: Vec<SealedObjectEvent> = state
            .objects
            .iter()
            .filter(|(id, _)| !state.unpublished.contains(*id) && !state.blocked.contains(*id))
            .map(|(id, stored)| SealedObjectEvent {
                id: *id,
                deleted: stored.sealed.is_none(),
                updated_at: stored.updated_at,
                object: stored.sealed.clone(),
                blocked: false,
            })
            .collect();
        // Hash256 is not Ord; order by its raw bytes so the cursor has a
        // total order to compare against.
        let sort_key = |e: &SealedObjectEvent| (e.updated_at, *AsRef::<[u8; 32]>::as_ref(&e.id));
        events.sort_by_key(sort_key);
        if let Some(ObjectsCursor { after, id }) = cursor {
            let cursor = (after, *AsRef::<[u8; 32]>::as_ref(&id));
            events.retain(|e| sort_key(e) > cursor);
        }
        events.truncate(limit.unwrap_or(usize::MAX));
        Ok(events)
    }

    /// PATCH U1: current (not deleted) objects in ID byte order after `after`, published or not. PATCH U1-B: blocked
    /// ones flagged, without their object, as `?blocked=true` lists them.
    pub(crate) async fn current_objects(
        &self,
        _: &PrivateKey,
        after: Option<Hash256>,
        limit: Option<usize>,
    ) -> Result<Vec<SealedObjectEvent>, Error> {
        self.reachable()?;
        let state = self.state.read().unwrap();
        let mut events: Vec<SealedObjectEvent> = state
            .objects
            .iter()
            .filter_map(|(id, stored)| {
                let blocked = state.blocked.contains(id);
                stored.sealed.clone().map(|o| SealedObjectEvent {
                    id: *id,
                    deleted: false,
                    updated_at: stored.updated_at,
                    object: (!blocked).then_some(o),
                    blocked,
                })
            })
            .collect();
        let key = |e: &SealedObjectEvent| *AsRef::<[u8; 32]>::as_ref(&e.id);
        events.sort_by_key(key);
        if let Some(after) = after {
            let after = *AsRef::<[u8; 32]>::as_ref(&after);
            events.retain(|e| key(e) > after);
        }
        events.truncate(limit.unwrap_or(usize::MAX).min(state.page_limit.unwrap_or(usize::MAX)));
        Ok(events)
    }

    pub(crate) async fn pin_object(
        &self,
        _: &PrivateKey,
        object: &SealedObject,
        v4: Option<crate::fence::C2Op>,
    ) -> Result<Option<crate::fence::C2Answer>, PinObjectError> {
        self.reachable()?;
        let object = object.clone();
        let cred = self.cred();
        let r = self.with_fault("pin_object", move |me| {
            let mut state = me.state.write().unwrap();
            if let Err(current) = fence_check(&state, cred) {
                return Err(PinObjectError::Client(fence_refusal_error(current)));
            }
            let body = serde_json::to_vec(&super::PinObjectRequest::from(&object)).unwrap_or_default();
            let digest = cred.zip(v4).map(|(c, v)| crate::fence::c2_op_digest("POST", "mock", "/objects", &c, &v, Some(&body))).unwrap_or([0; 32]);
            if let Some(seq) = Self::cas_gate(&state, v4, || digest)? {
                return Ok(Some(crate::fence::C2Answer { seq, replayed: true }));
            }
            if state.blocked.contains(&object.id()) {
                return Err(PinObjectError::Client(Error::Api(StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS, "object is unavailable for legal reasons".into())));
            }
            if object
                .slabs
                .iter()
                .any(|slab| !state.slabs.contains_key(&slab.digest()))
            {
                return Err(PinObjectError::UnpinnedSlab);
            }
            state.objects.insert(
                object.id(),
                StoredObject {
                    sealed: Some(object.clone()),
                    updated_at: Utc::now(),
                },
            );
            if state.hold_publication {
                state.unpublished.insert(object.id());
            }
            Ok(Self::cas_applied(&mut state, v4, digest))
        })
        .await;
        match r {
            Err(PinObjectError::Client(Error::Fenced(current))) => Err(PinObjectError::Client(self.refused(current))),
            other => other,
        }
    }

    pub(crate) async fn delete_object(&self, _: &PrivateKey, key: &Hash256, v4: Option<crate::fence::C2Op>) -> Result<Option<crate::fence::C2Answer>, Error> {
        self.reachable()?;
        let key = *key;
        let cred = self.cred();
        match self.with_fault("delete_object", move |me| me.apply_delete(&key, cred, v4)).await {
            Err(Error::Fenced(current)) => Err(self.refused(current)),
            other => other,
        }
    }

    fn apply_delete(&self, key: &Hash256, cred: Option<FenceCredential>, v4: Option<crate::fence::C2Op>) -> Result<Option<crate::fence::C2Answer>, Error> {
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, cred) {
            return Err(fence_refusal_error(current));
        }
        let digest = cred.zip(v4).map(|(c, v)| crate::fence::c2_op_digest("DELETE", "mock", &format!("/objects/{key}"), &c, &v, None)).unwrap_or([0; 32]);
        if let Some(seq) = Self::cas_gate(&state, v4, || digest)? {
            return Ok(Some(crate::fence::C2Answer { seq, replayed: true }));
        }
        match state.objects.get_mut(key) {
            Some(stored) => {
                stored.sealed = None;
                stored.updated_at = Utc::now();
                if state.hold_publication {
                    state.unpublished.insert(*key);
                }
            }
            None => {
                return Err(Error::Api(
                    StatusCode::NOT_FOUND,
                    format!("object {key} not found"),
                ));
            }
        }
        // Deleting an object detaches it from every sharing key it was
        // attached to.
        for stored in state.sharing_keys.values_mut() {
            stored.attached.remove(key);
        }
        Ok(Self::cas_applied(&mut state, v4, digest))
    }

    pub(crate) async fn pin_slabs(
        &self,
        _: &PrivateKey,
        slabs: &[SlabPinParams],
    ) -> Result<Vec<Hash256>, Error> {
        self.reachable()?;
        if let Some(crate::mock::Fault::Hang) = self.take_fault("pin_slabs") {
            return std::future::pending().await;
        }
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        state.pin_slabs_calls += 1;
        #[cfg(test)]
        state.pin_slabs_requests.push(slabs.to_vec());
        if let Some(error) = state.pin_slabs_errors.pop_front() {
            return Err(error);
        }
        Ok(slabs
            .iter()
            .map(|params| {
                let slab = Slab::from(params);
                let id = slab.digest();
                state.slabs.insert(
                    id,
                    StoredSlab {
                        min_shards: slab.min_shards,
                        sectors: slab.sectors.len(),
                    },
                );
                id
            })
            .collect())
    }

    /// `before` is accepted and ignored: a mock slab carries no pin time to
    /// compare it against, so every orphan is pruned.
    pub(crate) async fn prune_slabs(
        &self,
        _: &PrivateKey,
        _before: Option<DateTime<Utc>>,
    ) -> Result<(), Error> {
        self.reachable()?;
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        let referenced: HashSet<Hash256> = state
            .objects
            .values()
            .filter_map(|o| o.sealed.as_ref())
            .flat_map(|sealed| sealed.slabs.iter().map(|s| s.digest()))
            .collect();
        state.slabs.retain(|id, _| referenced.contains(id));
        Ok(())
    }

    pub(crate) async fn account(&self, app_key: &PrivateKey) -> Result<Account, Error> {
        self.reachable()?;
        let state = self.state.read().unwrap();
        let pinned_size: u64 = state
            .slabs
            .values()
            .map(|s| (s.sectors * SECTOR_SIZE) as u64)
            .sum();
        let pinned_data: u64 = state
            .slabs
            .values()
            .map(|s| (s.min_shards as usize * SECTOR_SIZE) as u64)
            .sum();
        Ok(Account {
            account_key: app_key.public_key(),
            max_pinned_data: u64::MAX,
            remaining_storage: u64::MAX - pinned_data,
            pinned_data,
            pinned_size,
            ready: true,
            app: App {
                id: Hash256::default(),
                name: "mock".to_string(),
                description: "mock indexer".to_string(),
                logo_url: None,
                service_url: None,
            },
            last_used: Utc::now(),
        })
    }

    pub(crate) fn shared_object_url(
        &self,
        app_key: &PrivateKey,
        object: &Object,
        valid_until: DateTime<Utc>,
    ) -> Result<Url, Error> {
        let mut url: Url = format!(
            "{SHARE_URL_SCHEME}://{MOCK_AUTHORITY}/objects/{}/shared",
            object.id()
        )
        .parse()?;

        let params = sign(app_key, &url, Method::GET, None, valid_until);
        url.set_fragment(Some(
            format!(
                "encryption_key={}",
                URL_SAFE.encode(object.data_key.as_ref())
            )
            .as_str(),
        ));

        let mut pairs = url.query_pairs_mut();
        for (key, value) in params {
            pairs.append_pair(key, value.as_str());
        }

        Ok(pairs.finish().to_owned())
    }

    pub(crate) async fn shared_object(&self, share_url: Url) -> Result<Object, Error> {
        if share_url.scheme() != SHARE_URL_SCHEME {
            return Err(Error::Format(format!(
                "invalid url scheme: expected {SHARE_URL_SCHEME}"
            )));
        }
        let data_key = match share_url.fragment() {
            Some(fragment) => {
                let fragment = fragment
                    .strip_prefix("encryption_key=")
                    .ok_or(Error::Format("missing encryption_key".into()))?;
                let mut out = [0u8; 32];
                match URL_SAFE.decode_slice(fragment, &mut out) {
                    Ok(32) => Ok(EncryptionKey::from(out)),
                    _ => Err(Error::Format(
                        "encryption key must be 32 bytes, base64url-encoded".into(),
                    )),
                }
            }
            None => Err(Error::Format("missing encryption_key".into())),
        }?;

        // ../objects/:id/shared
        let id: Hash256 = share_url
            .path_segments()
            .and_then(|segments| segments.rev().nth(1).map(str::to_string))
            .ok_or(Error::Format("invalid share url format".into()))?
            .parse()
            .map_err(|_| Error::Format("invalid object id".into()))?;

        let sealed = self
            .state
            .read()
            .unwrap()
            .objects
            .get(&id)
            .and_then(|o| o.sealed.clone())
            .ok_or_else(|| Error::Api(StatusCode::NOT_FOUND, format!("object {id} not found")))?;

        Ok(Object {
            data_key,
            slabs: sealed.slabs,
            ..Default::default()
        })
    }

    /// Records a sharing key. It must echo the submitted public key and nonce:
    /// `create_sharing_key` verifies the response against the nonce it generated.
    pub(crate) async fn add_sharing_key(
        &self,
        app_key: &PrivateKey,
        req: &KeyRequest,
    ) -> Result<KeyResponse, Error> {
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        if state.sharing_keys.contains_key(&req.public_key) {
            return Err(Error::Api(
                StatusCode::CONFLICT,
                "sharing key already exists".into(),
            ));
        }
        let stored = StoredSharingKey {
            account: app_key.public_key(),
            public_key: req.public_key,
            nonce: req.nonce,
            description: req.description.clone(),
            expires_at: req.expires_at,
            created_at: Utc::now(),
            attached: HashMap::new(),
        };
        let response = stored.response();
        state.sharing_keys.insert(req.public_key, stored);
        Ok(response)
    }

    pub(crate) async fn sharing_keys(
        &self,
        app_key: &PrivateKey,
        offset: Option<u64>,
        limit: Option<u64>,
    ) -> Result<Vec<KeyResponse>, Error> {
        let owner = app_key.public_key();
        let state = self.state.read().unwrap();
        // Scoped to the caller's own keys. Returning another account's key here
        // would fail nonce re-derivation in the SDK and surface as KeyMismatch.
        let mut keys: Vec<_> = state
            .sharing_keys
            .values()
            .filter(|k| k.account == owner && !k.expired())
            .collect();
        // Newest first, matching indexd, with the key's bytes breaking ties.
        keys.sort_by_key(|k| (k.created_at, k.public_key.as_ref().to_vec()));
        keys.reverse();
        Ok(keys
            .into_iter()
            .skip(offset.unwrap_or(0) as usize)
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .map(StoredSharingKey::response)
            .collect())
    }

    pub(crate) async fn sharing_key(
        &self,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<KeyResponse, Error> {
        let state = self.state.read().unwrap();
        Ok(Self::active(&state, app_key, public_key)?.response())
    }

    pub(crate) async fn delete_sharing_key(
        &self,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<(), Error> {
        let owner = app_key.public_key();
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        // Checked before removing so one account cannot revoke another's key.
        match state.sharing_keys.get(public_key) {
            Some(k) if k.account == owner => {}
            _ => return Err(key_not_found(public_key)),
        }
        state.sharing_keys.remove(public_key);
        Ok(())
    }

    pub(crate) async fn add_shared_object(
        &self,
        app_key: &PrivateKey,
        sharing_key: &PublicKey,
        req: &SharedObjectRequest,
    ) -> Result<(), Error> {
        let now = Utc::now();
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        let slabs = state
            .objects
            .get(&req.object_id)
            .and_then(|o| o.sealed.as_ref())
            .ok_or_else(|| {
                Error::Api(
                    StatusCode::NOT_FOUND,
                    format!("object {} not found", req.object_id),
                )
            })?
            .slabs
            .clone();
        let stored = Self::active_mut(&mut state, app_key, sharing_key)?;
        // The request carries the object's keys re-sealed under the sharing
        // key, so store those rather than the account-sealed originals.
        stored.attached.insert(
            req.object_id,
            SealedObject {
                slabs,
                created_at: now,
                updated_at: now,
                encrypted_data_key: req.encrypted_data_key.clone(),
                data_signature: req.data_signature.clone(),
                encrypted_metadata_key: req.encrypted_metadata_key.clone(),
                encrypted_metadata: req.encrypted_metadata.clone(),
                metadata_signature: req.metadata_signature.clone(),
            },
        );
        Ok(())
    }

    pub(crate) async fn sharing_key_objects(
        &self,
        app_key: &PrivateKey,
        sharing_key: &PublicKey,
        offset: Option<u64>,
        limit: Option<u64>,
    ) -> Result<Vec<SealedObject>, Error> {
        let state = self.state.read().unwrap();
        Ok(Self::active(&state, app_key, sharing_key)?.page(offset, limit))
    }

    /// Looks up a key the calling account owns.
    ///
    /// A key belonging to another account is reported as missing rather than
    /// forbidden. That is what indexd's queries produce by filtering on
    /// `account_id`, and it keeps one account from probing for the existence of
    /// another's keys.
    fn owned<'a>(
        state: &'a State,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<&'a StoredSharingKey, Error> {
        state
            .sharing_keys
            .get(public_key)
            .filter(|k| k.account == app_key.public_key())
            .ok_or_else(|| key_not_found(public_key))
    }

    /// Mutable counterpart of [`Client::owned`].
    fn owned_mut<'a>(
        state: &'a mut State,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<&'a mut StoredSharingKey, Error> {
        let owner = app_key.public_key();
        state
            .sharing_keys
            .get_mut(public_key)
            .filter(|k| k.account == owner)
            .ok_or_else(|| key_not_found(public_key))
    }

    /// Owner-scoped lookup that also rejects an expired key.
    ///
    /// indexd gates reads and new attachments on `expires_at`, but deliberately
    /// does not gate revoking or detaching, so an owner can still clean up after
    /// a key expires. Those two paths use [`Client::owned`] and
    /// [`Client::owned_mut`] directly for that reason.
    fn active<'a>(
        state: &'a State,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<&'a StoredSharingKey, Error> {
        let stored = Self::owned(state, app_key, public_key)?;
        if stored.expired() {
            return Err(key_not_found(public_key));
        }
        Ok(stored)
    }

    /// Mutable counterpart of [`Client::active`].
    fn active_mut<'a>(
        state: &'a mut State,
        app_key: &PrivateKey,
        public_key: &PublicKey,
    ) -> Result<&'a mut StoredSharingKey, Error> {
        let stored = Self::owned_mut(state, app_key, public_key)?;
        if stored.expired() {
            return Err(key_not_found(public_key));
        }
        Ok(stored)
    }

    /// Authenticates a `/shared` request the way the indexer does, by the public
    /// half of the key it is signed with. An expired key authenticates nothing,
    /// which is how a key with an expiry stops granting access without anyone
    /// having to revoke it.
    fn shared<'a>(
        state: &'a State,
        sharing_key: &PrivateKey,
    ) -> Result<&'a StoredSharingKey, Error> {
        let public_key = sharing_key.public_key();
        state
            .sharing_keys
            .get(&public_key)
            .filter(|k| !k.expired())
            .ok_or_else(|| {
                Error::Api(
                    StatusCode::UNAUTHORIZED,
                    format!("sharing key {public_key} not found"),
                )
            })
    }

    pub(crate) async fn shared_stats(&self, sharing_key: &PrivateKey) -> Result<KeyStats, Error> {
        let state = self.state.read().unwrap();
        let record = Self::shared(&state, sharing_key)?.response();
        Ok(record.stats)
    }

    pub(crate) async fn shared_objects(
        &self,
        sharing_key: &PrivateKey,
        offset: Option<u64>,
        limit: Option<u64>,
    ) -> Result<Vec<SealedObject>, Error> {
        let state = self.state.read().unwrap();
        Ok(Self::shared(&state, sharing_key)?.page(offset, limit))
    }

    /// Reports each object's size, as indexers that include it in listings
    /// without slabs do.
    pub(crate) async fn shared_object_summaries(
        &self,
        sharing_key: &PrivateKey,
        offset: Option<u64>,
        limit: Option<u64>,
    ) -> Result<Vec<SealedObjectSummary>, Error> {
        let state = self.state.read().unwrap();
        Ok(Self::shared(&state, sharing_key)?
            .page(offset, limit)
            .into_iter()
            .map(|sealed| SealedObjectSummary {
                object_id: sealed.id(),
                size: sealed.slabs.iter().map(|s| s.length as u64).sum(),
                encrypted_metadata_key: sealed.encrypted_metadata_key,
                encrypted_metadata: sealed.encrypted_metadata,
                metadata_signature: sealed.metadata_signature,
                created_at: sealed.created_at,
                updated_at: sealed.updated_at,
            })
            .collect())
    }

    pub(crate) async fn shared_object_by_id(
        &self,
        sharing_key: &PrivateKey,
        key: &Hash256,
    ) -> Result<SealedObject, Error> {
        let state = self.state.read().unwrap();
        Self::shared(&state, sharing_key)?
            .attached
            .get(key)
            .cloned()
            .ok_or_else(|| Error::Api(StatusCode::NOT_FOUND, format!("object {key} not found")))
    }

    /// Signs every token with one stand-in account key. Nothing in the SDK
    /// inspects which account paid, only that a token is present and unexpired.
    pub(crate) async fn shared_hosts(
        &self,
        sharing_key: &PrivateKey,
        query: HostQuery,
    ) -> Result<Vec<SharedHost>, Error> {
        let state = self.state.read().unwrap();
        Self::shared(&state, sharing_key)?;
        let account_key = PrivateKey::from_seed(&[7u8; 32]);
        let offset = query.offset.unwrap_or(0) as usize;
        let limit = query.limit.map_or(usize::MAX, |l| l as usize);
        Ok(state
            .hosts
            .iter()
            .skip(offset)
            .take(limit)
            .map(|h| SharedHost {
                token: AccountToken::new(&account_key, h.public_key),
                host: h.clone(),
            })
            .collect())
    }

    pub(crate) async fn delete_shared_object(
        &self,
        app_key: &PrivateKey,
        sharing_key: &PublicKey,
        object_key: &Hash256,
    ) -> Result<(), Error> {
        let mut state = self.state.write().unwrap();
        if let Err(current) = fence_check(&state, self.cred()) {
            drop(state);
            return Err(self.refused(current));
        }
        if state.cas_mode && !self.v4() {
            return Err(Error::ModeConflict);
        }
        let stored = Self::owned_mut(&mut state, app_key, sharing_key)?;
        if stored.attached.remove(object_key).is_none() {
            return Err(Error::Api(
                StatusCode::NOT_FOUND,
                format!("object {object_key} is not attached"),
            ));
        }
        Ok(())
    }
}

fn key_not_found(public_key: &PublicKey) -> Error {
    Error::Api(
        StatusCode::NOT_FOUND,
        format!("sharing key {public_key} not found"),
    )
}

impl StoredSharingKey {
    /// Whether the key's expiry has passed. indexd keeps expired rows until
    /// `PruneExpiredSharingKeys` sweeps them, and filters them out of its
    /// queries in the meantime, so the mock keeps them and filters too.
    fn expired(&self) -> bool {
        self.expires_at.is_some_and(|t| t <= Utc::now())
    }

    /// Builds the record the sharing key API returns, with counts derived from
    /// what is currently attached.
    fn response(&self) -> KeyResponse {
        let object_size: u64 = self
            .attached
            .values()
            .flat_map(|o| o.slabs.iter())
            .map(|s| s.length as u64)
            .sum();
        KeyResponse {
            public_key: self.public_key,
            nonce: self.nonce,
            account: self.account,
            description: self.description.clone(),
            stats: KeyStats {
                object_count: self.attached.len() as u64,
                object_size,
                pinned_data: object_size,
                pinned_size: object_size,
                expires_at: self.expires_at,
                created_at: self.created_at,
                updated_at: self.created_at,
            },
        }
    }

    /// Returns a stable page of the attached objects, ordered by id.
    fn page(&self, offset: Option<u64>, limit: Option<u64>) -> Vec<SealedObject> {
        let mut ids: Vec<_> = self.attached.keys().copied().collect();
        ids.sort_by_key(|id| *AsRef::<[u8; 32]>::as_ref(id));
        ids.into_iter()
            .skip(offset.unwrap_or(0) as usize)
            .take(limit.map_or(usize::MAX, |l| l as usize))
            .filter_map(|id| self.attached.get(&id).cloned())
            .collect()
    }
}
