        # platform-carrier (root review B-RPC / B2): ONLY RC is offered. P/PC use the bundle's production quorum, which includes
        # BlockPI (503 natively, ROOT-BLOCKPI-0419); R has no carrier, so an admin anchor would strand this host (B2).
        if o.option != "RC":
            print(json.dumps({"refused": [f"option {o.option}: only RC is offered (P/PC: production quorum incl. BlockPI not proven natively; R: no policy carrier)"]}, indent=1)); return 2
