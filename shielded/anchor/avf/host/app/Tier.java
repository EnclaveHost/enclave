package host.enclave.anchor.avf;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.widget.TextView;

/* The build's product tier (PVM-CPU.md), from assets/tier -- an APK asset, so it is covered by the codeHash the pVM attests.
 *   "pvm-cpu"   the pVM CPU product build: the whole model on the protected VM's own vCPUs, mode local ONLY, no TPU
 *               backend, worker or dispatch library in the APK (build.sh ANCHOR_TIER=pvm-cpu).
 *   "research"  the combined build (mode local, the split engine, the closed Shielded-TPU lane). Never a product tier.
 * An APK without the asset predates tiers and is "research". The label is the tier's identity on this screen, not a claim of
 * verification: the relay admits a phone as pVM CPU from its verified evidence (codeHash, isVmSecure, model pin), never from
 * this label or the device name. */
final class Tier {
    static final String PVM_CPU = "pvm-cpu", RESEARCH = "research";
    /* the design system's amber (site/css/src/tokens.css --amber #FF914D): the pVM CPU tier's orange, paired with its name */
    static final int ORANGE = 0xFFFF914D, ORANGE_DEEP = 0xFF3A2014, GREY = 0xFF5A5A5A;

    private Tier() {}

    static String of(Context c) {
        try (java.io.InputStream in = c.getAssets().open("tier")) {
            byte[] b = new byte[32]; int n = in.read(b); String s = n > 0 ? new String(b, 0, n, "US-ASCII").trim() : "";
            if (PVM_CPU.equals(s) || RESEARCH.equals(s)) return s;
            return "invalid:" + s;   /* a present-but-unknown tier is refused by refusal(), never read as a weaker one */
        } catch (java.io.IOException e) { return RESEARCH; }
    }

    /* Why this launch must not run in this build, or null. A pVM CPU build serves ONE thing: the whole model on the VM's vCPUs. */
    static String refusal(String tier, String mode, Intent i) {
        if (tier.startsWith("invalid:")) return "assets/tier holds an unknown tier '" + tier.substring(8) + "'";
        if (!PVM_CPU.equals(tier)) return null;
        if (!"local".equals(mode) && !"app".equals(mode)) return "a pVM CPU build runs mode local or app only (asked for mode " + mode + ")";
        for (String k : new String[] { "tpu_graphs", "tpu_bundle", "tpu_bank", "tpu_refill", "tpu_layers", "tpu_links", "tpu_spin", "tpu_worker_spin", "tpu_prio", "corr_threads" })
            if (i.hasExtra(k)) return "a pVM CPU build has no TPU path (" + k + " was given)";
        for (String k : new String[] { "pads", "prefix", "prefix_name", "artifacts", "artifacts_url" })   // "relay" is allowed: the attach is how the tier is admitted
            if (i.hasExtra(k)) return "a pVM CPU build takes no split-engine input (" + k + " was given)";
        return null;
    }

    /* The tier label shown above the run log. */
    static TextView badge(Context c, String tier) {
        TextView b = new TextView(c);
        final boolean pvm = PVM_CPU.equals(tier);
        b.setText(pvm ? "pVM CPU  ·  CPU-only inference inside the protected VM" : "research build  ·  not a product tier");
        b.setTextSize(13); b.setTypeface(Typeface.DEFAULT_BOLD); b.setPadding(28, 18, 28, 18);
        b.setTextColor(pvm ? ORANGE_DEEP : 0xFFFFFFFF);
        GradientDrawable bg = new GradientDrawable(); bg.setColor(pvm ? ORANGE : GREY); bg.setCornerRadius(18f);
        b.setBackground(bg);
        return b;
    }
}
