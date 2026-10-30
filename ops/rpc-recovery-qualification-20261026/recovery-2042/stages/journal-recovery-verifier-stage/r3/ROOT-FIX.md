Root1654 exposed accidental recursion in the r2 output-capture fixture helper. r3 calls V.main(args) once instead of itself. Verifier runtime and all nine assertions unchanged.
