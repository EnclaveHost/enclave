/*
 * AnchorService -- the same VM owner as Main, hosted from a FOREGROUND SERVICE.
 *
 * Placement, not privilege: an activity started onto a locked screen lives in
 * the /background cpuset (the four A510 little cores on Tensor G3) and the
 * virtmgr/crosvm it spawns inherit that, which made the heavy shapes 6-12x
 * slower in REPORT.md §9. A foreground service is in the foreground cpuset
 * whatever the screen is doing, and it is the shape an operator app would
 * use anyway: a VM hosting the anchor is long-lived work with a notification.
 *
 *   adb shell am start-foreground-service -n host.enclave.anchor.avf/.AnchorService
 */
package host.enclave.anchor.avf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

public class AnchorService extends Service {
    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("anchor", "Enclave Anchor", NotificationManager.IMPORTANCE_LOW));
        Notification n = new Notification.Builder(this, "anchor")
            .setContentTitle("Enclave anchor VM").setContentText("protected VM running")
            .setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true).build();
        startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        final String payload = intent != null && intent.getStringExtra("payload") != null ? intent.getStringExtra("payload") : "libanchor.so";
        final int debug = intent != null ? intent.getIntExtra("debug", 0) : 0;
        final long memMib = intent != null ? intent.getIntExtra("mem", 1024) : 1024;
        Log.i(Main.TAG, "SERVICE foreground, starting VM");
        new Thread(() -> { Main.runVm(this, payload, debug, memMib); }, "anchor-service").start();
        return START_NOT_STICKY;
    }
}
