// The ONE Buffer use the host-capacity record module makes, for the browser bundle (scripts/build-host-capacity-vendor.mjs):
// Buffer.byteLength(text) of a string in network/host-capacity-record.mjs parseAvailability (the 32 KiB bound), i.e. its
// UTF-8 length. Anything other than a string throws rather than guess. Tested against Node's Buffer.byteLength.
export const Buffer = {
  byteLength(value){
    if (typeof value !== "string") throw new Error("the browser bundle measures UTF-8 text only");
    return new TextEncoder().encode(value).length;
  },
};
