const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
const validResult = r => r && typeof r === 'object' && Number.isFinite(r.at) && typeof r.targetUid === 'string' && ['android','demo'].includes(r.mode) && ['confirmed_ui','failed','unconfirmed','cancelled','skipped','simulated'].includes(r.outcome);

// Both copies are append-only. A torn write or disagreement blocks new sends.
function openOutcomeJournal(file) {
  function read(name) {
    if (!fs.existsSync(name)) return {entries:[], missing:true, broken:false};
    const entries = []; let previous = '';
    try {
      const raw = fs.readFileSync(name,'utf8');
      const lines = raw.split('\n');
      for (let i=0;i<lines.length-1;i++) {
        const entry = JSON.parse(lines[i]);
        if (entry.version !== 3 || entry.previous !== previous || !validResult(entry.result) || entry.checksum !== digest(JSON.stringify({version:3,previous,result:entry.result}))) throw Error('checksum');
        entries.push(entry); previous = entry.checksum;
      }
      return {entries, broken:lines.at(-1) !== ''};
    } catch { return {entries, broken:true}; }
  }
  const primary = read(file), backup = read(`${file}.bak`);
  const recoveryRequired = primary.broken || backup.broken || primary.entries.length !== backup.entries.length || primary.missing !== backup.missing || primary.entries.some((e,i)=>e.checksum !== backup.entries[i]?.checksum);
  // Prefer the longest verified prefix, retaining durable dispatch intents.
  const entries = primary.entries.length >= backup.entries.length ? primary.entries : backup.entries;
  if (recoveryRequired && !entries.length && (primary.broken && backup.broken)) throw Error('DATA_CORRUPT: Cannot read outcome journal or its backup');
  let previous = entries.at(-1)?.checksum || '';
  return {
    results:entries.map(e=>e.result), recoveryRequired,
    append(result) {
      if (!validResult(result)) throw Error('DATA_CORRUPT: Invalid outcome journal entry');
      const payload = {version:3,previous,result};
      const checksum = digest(JSON.stringify(payload));
      const line = JSON.stringify({...payload,checksum})+'\n';
      fs.mkdirSync(path.dirname(file),{recursive:true});
      for (const name of [file,`${file}.bak`]) {
        const fd = fs.openSync(name,'a');
        try { fs.writeFileSync(fd,line,'utf8'); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
      previous = checksum;
    },
  };
}
module.exports = {openOutcomeJournal,validResult};
