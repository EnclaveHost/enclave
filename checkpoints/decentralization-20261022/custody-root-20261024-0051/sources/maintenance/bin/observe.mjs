#!/usr/bin/env node
// Read-only production observation; never asserts quiescence or creates an executable plan.
import fs from 'node:fs';
import { createPreparer } from '../lib/maintenance.mjs';
const leaseIds = ['0xda09d0f2649ae2afa76403f1f15d87db58faaeb9a3d5bab0fddfb5bc44ba68d9','0x9eb4e60063aa079cebed355f96b2d049457ae77bdbcd49086040282e1e4b871c'];
const result = await createPreparer().observe({leaseIds});
fs.mkdirSync(new URL('../observations/', import.meta.url), {recursive:true});
fs.writeFileSync(new URL(`../observations/${result.hash}.json`, import.meta.url), result.text, {flag:'wx'});
console.log(JSON.stringify({hash:result.hash,requests:result.requests,executable:false,findings:result.observation.findings,fees:result.observation.fees,leases:result.observation.leases},null,2));
