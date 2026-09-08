package host.enclave.anchor.avf;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public final class PadAckQueueTest {
    static final String SEED = "ab".repeat(16);
    static void check(boolean ok, String why) { if (!ok) throw new AssertionError(why); }
    static void await(CountDownLatch latch) throws Exception { check(latch.await(5,TimeUnit.SECONDS), "timed out"); }
    static String line(long lo, long count) { return "PADACK " + SEED + " " + lo + " " + count + " " + "12".repeat(32) + " " + "34".repeat(16) + " " + "56".repeat(64); }
    static PadAckQueue.Ack ack(long lo) { return PadAckQueue.Ack.parse(line(lo,1), SEED); }
    public static void main(String[] args) throws Exception {
        String valid = line(0,64);
        check(PadAckQueue.Ack.parse(valid,SEED).count == 64,"valid line");
        for (String bad : new String[]{line(-1,1),line(0,0),line(1,1L<<24),line(1L<<24,1),valid.replace(" 0 64 "," 00 64 "),valid.replace(SEED,"cd".repeat(16)),valid+" extra"}) {
            try { PadAckQueue.Ack.parse(bad,SEED); throw new AssertionError("accepted malformed ACK"); } catch (IllegalArgumentException expected) { }
        }
        CountDownLatch started=new CountDownLatch(1), release=new CountDownLatch(1), sent=new CountDownLatch(2);
        List<Long> order=Collections.synchronizedList(new ArrayList<>()); AtomicInteger calls=new AtomicInteger();
        PadAckQueue q=new PadAckQueue(a -> {
            order.add(a.index0);
            if(calls.getAndIncrement()==0) { started.countDown(); await(release); throw new IOException("transient outage"); }
            sent.countDown(); return true;
        },10);
        check(q.offer(ack(64)),"first enqueue"); await(started);
        // Enqueue is independent of blocked HTTP. A duplicate does not grow
        // memory, and an earlier range jumps ahead of the failed high range.
        check(q.offer(ack(64)) && q.offer(ack(0)) && q.size()==2,"nonblocking deduplication");
        release.countDown(); await(sent); q.close();
        check(order.equals(List.of(64L,0L,64L)),"gap before retry: " + order);

        CountDownLatch blocked=new CountDownLatch(1), canceled=new CountDownLatch(1);
        PadDelivery.Session first=PadDelivery.begin(); first.bind("http://old",SEED);
        PadAckQueue old=first.acknowledgments(a -> {
            blocked.countDown();
            try { new CountDownLatch(1).await(); } catch (InterruptedException e) { canceled.countDown(); throw e; }
            return false;
        });
        old.offer(ack(0)); await(blocked);
        for(int i=1;i<PadAckQueue.CAPACITY;i++) check(old.offer(ack(i)),"capacity fill");
        check(!old.offer(ack(PadAckQueue.CAPACITY)),"bounded memory");
        PadDelivery.Session second=PadDelivery.begin(); second.bind("http://new",SEED);
        await(canceled); check(!old.offer(ack(0)) && old.size()==0,"old generation canceled");
        CountDownLatch fresh=new CountDownLatch(1);
        second.acknowledgments(a -> { fresh.countDown(); return true; }).offer(ack(0)); await(fresh);
        second.close();
        System.out.println("pad-ack-queue: ok");
    }
}
