import {restore} from './data-tools.mjs';
if(process.argv.length!==4)throw Error('Usage: node scripts/restore.mjs BACKUP_DIRECTORY NEW_ISOLATED_DATA_ROOT');
console.log(await restore(process.argv[2],process.argv[3]));
