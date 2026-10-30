/*
 * BootReceiver -- a phone that hosts on its own (STANDALONE.md) starts hosting again after a reboot or an app update, once
 * it is set up (AgentService.start checks files/agent/setup.json). The owner's Hosting switch still decides whether apps run:
 * the agent reads it from files/offer.json.
 */
package host.enclave.anchor.avf;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent i) {
        final String a = i.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) AgentService.start(ctx);
    }
}
