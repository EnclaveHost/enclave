/* The default authority profile packaged with the site (js/core/default-authority.js).

   null here: the site keeps its hosted default, exactly as before this module existed. A build that ships the
   reviewed independent default replaces this module through scripts/build-site.mjs --default-profile <module>, with a
   module written by scripts/network/default-profile.mjs module (it refuses a gate report that is not publishable unless
   --provisional, and a provisional module only starts on a loopback origin). Never edit this by hand.

   Shape: { format: "enclave-default-profile/v1", provisional, profileText, profileDigest, authorityText,
            authorityDigest, gateDigest } */
export const DEFAULT_PROFILE = null;
