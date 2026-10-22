// The HTTP paths of a box's public raw attestation document (RAD): the ONE place that names them. supervisor.js serves
// the document under every path in RAD_PATHS and advertises ADVERTISED_RAD_PATH as verification.attestationEndpoint;
// relay/api-relay.js lets an ineligible box's tunnel answer every path in RAD_PATHS (BOX_OWN_SURFACES). Both are exact,
// lower-case paths: the relay compares them after canonicalizing (percent-decoding and lower-casing) the request path.
//
// CANONICAL_RAD_PATH is Enclave's name, the same /.well-known/enclave-attestation the guest agent, the isolation fronts
// and app origins already answer.
//
// LEGACY_RAD_PATH is a WIRE-COMPATIBILITY ALIAS, not product branding. It is the exact path today's deployed system
// speaks: production supervisors serve the document there and advertise it, the deployed relays pass only it for an
// ineligible box, and earlier verifier tools build it from a bare host name. Its bytes come from the hosted-attestation
// path format this protocol first interoperated with, and they must stay exactly as they are for those verifiers. Keep
// it out of every other file; code and tests refer to it through this module.
//
// ADVERTISED_RAD_PATH stays the legacy path while any relay that fronts boxes predates CANONICAL_RAD_PATH: such a relay
// refuses the canonical path for an ineligible box, so advertising it there would break clients that follow the
// advertised URL. Switching the advertised path, and later retiring the alias, are changes to this file only.
export const CANONICAL_RAD_PATH = "/.well-known/enclave-attestation";
export const LEGACY_RAD_PATH = "/.well-known/tinfoil-attestation";
export const RAD_PATHS = Object.freeze([CANONICAL_RAD_PATH, LEGACY_RAD_PATH]);
export const ADVERTISED_RAD_PATH = LEGACY_RAD_PATH;
