package host.enclave.anchor.avf;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/* Bounded per-leg capture of every say() line into an INTERNAL file the route pulls with run-as. Pure java.io, no
 * Android types, so the host fixture (fixtures/CaptureSinkTest.java) runs the real class. Why: logcat DROPS lines when
 * a burst exceeds liblog's non-blocking send budget (ping-3: the 212-chunk STDERR export in 22 ms kept 126 lines), so
 * bounded records (export, receipts, acks) must not depend on logd.
 *   line 1 : CAPTURE BEGIN label=<label> path=<abs> cap_bytes=<n>
 *   body   : the exact say() strings, one per call, '\n'-terminated, flushed per line
 *   last   : CAPTURE END label=<label> lines=<newlines written> bytes=<UTF-8 body bytes incl. newlines>
 *            status=complete|capped|failed:<io|no-end> [attempted_lines=<n> attempted_bytes=<n>]   (not for complete)
 *            ... unless the footer itself could not be written+flushed+fsynced: then the last line is
 *            CAPTURE INVALID label=<label> reason=<footer|fsync> <error>   and the file must be REJECTED.
 * complete = the control loop saw END and no I/O/cap error; EOF or an exception = failed:no-end. The file is created
 * EXCLUSIVELY (a label is used once; an existing file is never touched); the footer is written once from the control
 * loop's cleanup and nothing is written after it. A refused open must refuse the launch (the caller's job).
 * COMPLETION MARKER: an EXCLUSIVE empty <label>.complete beside the log is created ONLY after the footer's write +
 * flush + fsync AND the stream close all succeeded, and only for status=complete; a pre-existing marker refuses the
 * open; a marker that cannot be created = failed completion. The invalidation line is best effort, so the host
 * requires the marker after parsing the capture: a missing marker fails closed. */
final class CaptureSink {
    interface Warn { void warn(String message); }
    static final int CAP_MIB_MIN = 1, CAP_MIB_MAX = 64, CAP_MIB_DEFAULT = 16;
    private final FileOutputStream out; private final File marker; private final String label; private final long cap;
    private long bytes, lines, tryBytes, tryLines; private String fail = ""; private boolean closed;

    private CaptureSink(FileOutputStream out, File marker, String label, long cap) { this.out = out; this.marker = marker; this.label = label; this.cap = cap; }
    static File markerFor(File log) { return new File(log.getParentFile(), log.getName().replaceFirst("\\.log$", "") + ".complete"); }

    /* Validates BEFORE creating anything: label [A-Za-z0-9._-]{1,64}, capMib in [1,64]. null = refused (reason in warn). */
    static CaptureSink open(File dir, String label, int capMib, Warn warn) {
        if (label == null || !label.matches("[A-Za-z0-9._-]{1,64}")) { warn.warn("CAPTURE FAIL label"); return null; }
        if (capMib < CAP_MIB_MIN || capMib > CAP_MIB_MAX) { warn.warn("CAPTURE FAIL cap_mib " + capMib + " not in " + CAP_MIB_MIN + ".." + CAP_MIB_MAX); return null; }
        try {
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("mkdir " + dir);
            File f = new File(dir, label + ".log");
            if (markerFor(f).exists()) { warn.warn("CAPTURE FAIL marker exists " + markerFor(f).getAbsolutePath()); return null; }   // a completed label is never reused
            if (!f.createNewFile()) { warn.warn("CAPTURE FAIL exists " + f.getAbsolutePath()); return null; }   // exclusive: a label is used once
            return start(f, label, (long) capMib << 20, warn);
        } catch (IOException e) { warn.warn("CAPTURE FAIL open " + e); return null; }
    }
    /* opens the (already created) file for append and writes the header; package-private so the fixture can drive a
     * FIFO through the real write/fsync paths. null = refused. */
    static CaptureSink start(File f, String label, long capBytes, Warn warn) {
        FileOutputStream out;
        try { out = new FileOutputStream(f, true); } catch (IOException e) { warn.warn("CAPTURE FAIL open " + e); return null; }
        return adopt(out, f, markerFor(f), label, capBytes, warn);
    }
    /* writes the header on an already-open stream; the marker path is explicit (fixture: unwritable marker dir, failing close()) */
    static CaptureSink adopt(FileOutputStream out, File f, File marker, String label, long capBytes, Warn warn) {
        try {
            out.write(("CAPTURE BEGIN label=" + label + " path=" + f.getAbsolutePath() + " cap_bytes=" + capBytes + "\n").getBytes(StandardCharsets.UTF_8)); out.flush();
            return new CaptureSink(out, marker, label, capBytes);
        } catch (IOException e) {
            warn.warn("CAPTURE FAIL header " + e);
            try { out.close(); } catch (IOException ignored) { }
            return null;
        }
    }
    /* one say() string; counts what was actually written (and, separately, what was attempted) */
    synchronized void line(String s, Warn warn) {
        if (closed) return;
        final byte[] b = (s + "\n").getBytes(StandardCharsets.UTF_8);
        int nl = 0; for (byte c : b) if (c == '\n') nl++;
        tryBytes += b.length; tryLines += nl;
        if (!fail.isEmpty()) return;
        if (bytes + b.length > cap) { fail = "cap"; warn.warn("CAPTURE CAP reached at " + bytes + " bytes"); return; }
        try { out.write(b); out.flush(); bytes += b.length; lines += nl; }
        catch (IOException e) { fail = "io"; warn.warn("CAPTURE FAIL io " + e); }
    }
    /* The footer, once: write + flush + fsync + close, THEN the exclusive empty marker (status=complete only). Any
     * failure: best-effort CAPTURE INVALID last line (not after a failed close), no marker, and a failed:<stage> line
     * for logcat (stage = footer|fsync|close|marker). Later line() calls are ignored. */
    synchronized String close(boolean sawEnd) {
        if (closed) return null;
        closed = true;
        final String status = fail.equals("cap") ? "capped" : !fail.isEmpty() ? "failed:" + fail : sawEnd ? "complete" : "failed:no-end";
        final String footer = "CAPTURE END label=" + label + " lines=" + lines + " bytes=" + bytes + " status=" + status
                            + (status.equals("complete") ? "" : " attempted_lines=" + tryLines + " attempted_bytes=" + tryBytes);
        String stage = "footer";
        try { out.write((footer + "\n").getBytes(StandardCharsets.UTF_8)); out.flush(); stage = "fsync"; out.getFD().sync(); stage = "close"; out.close(); }
        catch (IOException e) {
            if (!stage.equals("close")) try { out.write(("CAPTURE INVALID label=" + label + " reason=" + stage + " " + e + "\n").getBytes(StandardCharsets.UTF_8)); out.flush(); } catch (IOException ignored) { }
            try { out.close(); } catch (IOException ignored) { }
            return failedFooter(stage, e);
        }
        if (!status.equals("complete")) return footer;
        try { if (!marker.createNewFile()) return failedFooter("marker", new IOException("exists " + marker.getAbsolutePath())); }
        catch (IOException e) { return failedFooter("marker", e); }
        return footer;
    }
    private String failedFooter(String stage, IOException e) {
        return "CAPTURE END label=" + label + " lines=" + lines + " bytes=" + bytes + " status=failed:" + stage + " attempted_lines=" + tryLines + " attempted_bytes=" + tryBytes + " (" + e + ")";
    }
}
