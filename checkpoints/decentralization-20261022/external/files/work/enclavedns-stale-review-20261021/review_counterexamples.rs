// Reviewer counterexamples for fresh-before-stale (resolver.rs b09130c7). NOT COMPILED/RUN: Rust needs a root budget
// decision. Paste into `mod tests` of src/resolver.rs (they reuse fake/resolver/seed/advance/ask/settle/run/OLD/NEW).

    /// R1: a validating refresh slower than STALE_WAIT_MS that comes back BOGUS is not cached by the refresh job
    /// (`answered && a.sec != Sec::Bogus`), so the old NOERROR entry keeps being served stale, for up to STALE_MS,
    /// although every fresh answer is bogus. Expected: once the refresh has a bogus answer, no stale NOERROR data.
    #[test]
    fn slow_bogus_refresh_does_not_keep_old_data_alive() {
        run(|| async {
            let name = Name::parse("slow-signed.test").unwrap();
            let (up, addr) = fake("slow-signed.test", Mode::Answer(NEW, 60)).await;
            up.delay_ms.set(2_500);
            let r = resolver(addr, true);   // validating: the fake's unsigned answer is bogus
            seed(&r, &name, OLD, Sec::Insecure, 30, 31_000);
            let (a, _) = ask(&r, &name).await;            // times out: stale (allowed: no answer yet)
            assert_eq!(a.source, "stale cache");
            settle(&r).await;                              // the refresh got its (bogus) answer
            up.mode.set(Mode::Silent);
            advance(FWD_MEMO_MS + 100);
            let (a, _) = ask(&r, &name).await;
            assert!(!(a.source == "stale cache" && a.rcode == rcode::NOERROR && !a.answer.is_empty()),
                "old data served stale after the refresh returned bogus");
            up.stop.set(true);
        });
    }

    /// R2: the client response timer is per lookup, not per client request. A CNAME chain of 3 expired names with a
    /// silent upstream makes the FIRST client request wait ~3 x 1.8 s (one 9 s Ctx for the whole chain), past common stub
    /// timeouts; the published behaviour answered at once. Expected (RFC 8767 sec. 5): one bounded wait per request.
    #[test]
    fn expired_cname_chain_waits_once_per_request() {
        run(|| async {
            let (a_, b_, c_) = (Name::parse("a.chain.test").unwrap(), Name::parse("b.chain.test").unwrap(), Name::parse("c.chain.test").unwrap());
            let (up, addr) = fake("a.chain.test", Mode::Silent).await;
            let r = resolver(addr, false);
            for (n, t) in [(&a_, &b_), (&b_, &c_)] {
                let mut x = Answer::negative(rcode::NOERROR, 300, "network");
                x.answer.push(Record::new(n.clone(), ty::CNAME, 300, t.wire().to_vec()));
                r.cache_put(n, ty::A, &x);
            }
            seed(&r, &c_, OLD, Sec::Insecure, 300, 301_000);   // ages all three past their TTL
            let server = Server::new(r.clone(), Vec::new(), None, false, None, true, 1000.0, 1000.0);
            let t0 = net::now_ms();
            let res = server.resolve(&a_, ty::A, false, false).await;
            let ms = net::now_ms() - t0;
            assert!(res.answer.iter().filter_map(rr_ip).any(|ip| ip == IpAddr::from(OLD)));
            assert!(ms < STALE_WAIT_MS + 700, "the first request waited {ms} ms for a 3-name chain");
            up.stop.set(true);
        });
    }
