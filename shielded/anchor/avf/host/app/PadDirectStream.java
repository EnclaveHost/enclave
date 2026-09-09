package host.enclave.anchor.avf;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/* One sealed pad shipment, straight from its HTTP response body into the pVM's PADS receiver, with no Android file in
 * between. Pure (no Android imports) so a host fixture drives it through pipes. The receiver's contract is unchanged:
 * "PADS <name> <bytes>\n" -> 'H' (already stored, header re-judged) | 'E' (refused) | 'G' (send exactly <bytes>), then 'K'
 * once the hidden temp is fsynced, its HEADER judged and the file published. The header judgment does not authenticate
 * every cell: per-cell AEAD and the u = r.W check still happen at consumption, unchanged. The app never sees plaintext:
 * it forwards sealed bytes. Only ACCEPTED and ALREADY mark the name accepted; every other outcome leaves it for the
 * existing cached-file path. The caller must close the vsock descriptor BEFORE any fallback so the receiver sees EOF,
 * unlinks its temp and can take the next offer. */
final class PadDirectStream {
    enum Outcome { ACCEPTED, ALREADY, LENGTH_MISMATCH, REFUSED_HEADER, SHORT_BODY, OVERSIZED_BODY, NO_ACK, SESSION_ENDED, IO_ERROR }
    private PadDirectStream() {}

    /** contentLength < 0 = unknown (the bounded copy still enforces `bytes`). The caller owns and closes all three streams. */
    static Outcome stream(PadDelivery.Session session, String name, long bytes, long contentLength,
                          InputStream body, OutputStream toVm, InputStream fromVm) {
        if (session == null || name == null || bytes <= 0 || body == null || toVm == null || fromVm == null) return Outcome.IO_ERROR;
        if (contentLength >= 0 && contentLength != bytes) return Outcome.LENGTH_MISMATCH;
        if (!session.shouldFetch(name)) return Outcome.SESSION_ENDED;
        try {
            toVm.write(("PADS " + name + " " + bytes + "\n").getBytes("US-ASCII")); toVm.flush();
            final int go = fromVm.read();                       /* blocks until the receiver answers, or the tracked descriptor is closed by cancellation */
            if (go == 'H') { session.accept(name); return session.accepted(name) ? Outcome.ALREADY : Outcome.SESSION_ENDED; }   /* accept() is a no-op once cancelled: say so */
            if (go < 0 && !session.active()) return Outcome.SESSION_ENDED;
            if (go != 'G') return Outcome.REFUSED_HEADER;
            try { session.copy(body, toVm, bytes); }
            catch (IOException e) {
                final String why = String.valueOf(e.getMessage());
                if (why.contains("incomplete")) return Outcome.SHORT_BODY;
                if (why.contains("oversized")) return Outcome.OVERSIZED_BODY;
                if (why.contains("session ended")) return Outcome.SESSION_ENDED;
                return Outcome.IO_ERROR;
            }
            toVm.flush();
            final int ack = fromVm.read();                      /* same: cancellation closes the descriptor, the read returns */
            if (ack < 0 && !session.active()) return Outcome.SESSION_ENDED;
            if (ack != 'K') return Outcome.NO_ACK;
            session.accept(name);
            return session.accepted(name) ? Outcome.ACCEPTED : Outcome.SESSION_ENDED;
        } catch (IOException e) {
            return session.active() ? Outcome.IO_ERROR : Outcome.SESSION_ENDED;
        }
    }
}
