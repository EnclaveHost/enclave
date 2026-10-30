// Bundle entry of the staged operator tool (work/hosted-services-activation build): the argv guard, then the tool's CLI.
import '../argv-guard.mjs';
import { main } from '../stage-tool.mjs';
main(process.argv.slice(2));
