import { executeCli } from './cli';
void executeCli(process.argv.slice(2)).then(code => process.exit(code));
