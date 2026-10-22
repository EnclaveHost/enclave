def gate_opts(names=None):
    """(PowerShell prefix, OPTSX) - platform-carrier: the RPC list and the carrier JSON appear ONCE, each option references them:
    @(name, rpcs, carriers). names: the options to prove (default all; --gate proves the carrier pair, or one --option)"""
    ref = lambda v: "$R5" if v == R5 else "''"
    return (f"$R5={q(R5)};$C={q(CARRIERS)};",
            "@(" + ",".join(f"@('{k}',{ref(v)},{'$C' if CARRIER_OF(k) else chr(39) * 2})" for k, v in OPTIONS.items() if names is None or k in names) + ")")
