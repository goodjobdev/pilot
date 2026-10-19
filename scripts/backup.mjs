import {backup} from './data-tools.mjs';
if(process.argv.length!==4)throw Error('Usage: node scripts/backup.mjs DATA_ROOT NEW_BACKUP_DIRECTORY (stop service first)');
const result=await backup(process.argv[2],process.argv[3]);console.log('Verified snapshot created:',result.files.length,'files. Copy to approved independent backup storage.');
