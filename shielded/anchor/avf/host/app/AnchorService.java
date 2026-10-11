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
        nm.createNotificationChannel(new NotificationChannel("anchor", "Hosting", NotificationManager.IMPORTANCE_LOW));
        final boolean slot = Main.slotIndex() > 0, product = Tier.PVM_CPU.equals(Tier.of(this));
        // the Enclave mark (res/drawable/ic_stat_enclave), found through the app icon's resource package (a release build renames
        // the manifest's package, not the resource table's)
        int mark = 0;
        try { mark = getResources().getIdentifier("ic_stat_enclave", "drawable", getResources().getResourcePackageName(getApplicationInfo().icon)); } catch (Exception ignored) {}
        Notification n = new Notification.Builder(this, "anchor")
            .setContentTitle(product ? "Enclave" : "Enclave anchor VM")
            .setContentText(!product ? "protected VM running" : slot ? "Serving an app" : "Hosting apps")
            .setSmallIcon(mark != 0 ? mark : android.R.drawable.stat_notify_sync).setOngoing(true)
            // a tap opens the app's status screen (Status.java): what this phone hosts
            .setContentIntent(android.app.PendingIntent.getActivity(this, 0, new Intent(this, Main.class).setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), android.app.PendingIntent.FLAG_IMMUTABLE))
            .build();
        startForeground(1 + Main.slotIndex(), n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);   /* a slot's own notification */
        final Main.Plan plan = Main.Plan.from(intent);
        final String tierWhy = Tier.refusal(Tier.of(this), plan.mode, intent);   /* the same tier refusal as the activity, named first */
        if (tierWhy != null) plan.configError = "tier " + Tier.of(this) + ": " + tierWhy;
        if (!plan.configError.isEmpty()) { Main.say("HOST FAIL: " + plan.configError); stopSelf(); return START_NOT_STICKY; }   /* an inconsistent plan never runs a VM */
        if (!Main.captureOpen(this, intent)) { Main.say("CAPTURE FAIL: launch refused"); stopSelf(); return START_NOT_STICKY; }   /* a requested capture that cannot open refuses the VM launch */
        Main.say("SERVICE foreground, starting VM");
        new Thread(() -> { Main.runVm(this, plan); }, "anchor-service").start();
        return START_NOT_STICKY;
    }
}
