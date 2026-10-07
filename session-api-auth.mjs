// metal images carry the verifier beside supervisor.js (metal/overlay-control-image.py adds /app/session-api-auth.mjs from
// windows/node/session-api-auth.mjs); in a checkout this re-exports that one file
export * from "./windows/node/session-api-auth.mjs";
