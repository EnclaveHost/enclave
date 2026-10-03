#!/usr/bin/env node
// Read-only: no wallet, signing, deposit order or customer ledger access.
import {discoverConversion} from '../../network/conversion/swft-discovery.mjs';
try{console.log(JSON.stringify(await discoverConversion(),null,2));}
catch(e){console.error('Currency conversion is unavailable: '+e.message);process.exitCode=1;}
