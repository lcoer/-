// Local recommendation classification; age, score and other level systems are not mixed.
const LEVEL_FIELDS = ['wealthLevel', 'charmLevel'];
function timestamp(value) {
  const parsed=typeof value==='number'?value:/^\d+$/.test(String(value??''))?Number(value):Date.parse(value);
  return Number.isFinite(parsed)&&parsed>=0&&parsed<=8.64e15?parsed:0;
}
function validateOptions(options) {
  if (!options || !LEVEL_FIELDS.includes(options.levelField)) throw Error('INVALID_LEVEL_FIELD');
  if (!Number.isSafeInteger(options.threshold) || options.threshold < 0) throw Error('INVALID_LEVEL_THRESHOLD');
  return {levelField:options.levelField, threshold:options.threshold};
}
function normalizeLevel(value) {
  if (typeof value === 'string' && /^[?？]+$/.test(value.trim())) return '?';
  if (typeof value === 'string' && /^\d{1,16}$/.test(value.trim())) value = Number(value.trim());
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function classifyRecommendations(records, options) {
  if (!Array.isArray(records)) throw Error('INVALID_RECORDS');
  const {levelField, threshold} = validateOptions(options);
  const latest = new Map();
  records.forEach((record, index) => {
    if (!record || record.source !== 'room' || (record.uidReal !== true && record.uidReal !== undefined) || typeof record.uid!=='string' || !/^\d{1,32}$/.test(record.uid)) return;
    const time = timestamp(record.lastSeenAt ?? record.ts), prior = latest.get(record.uid);
    if (prior) {
      prior.indexes.push(index);
      if (time >= prior.time) Object.assign(prior, {record,time,index});
    } else latest.set(record.uid,{record,time,index,indexes:[index],attributes:{},attributeSources:{}});
    const entry=latest.get(record.uid);
    for(const field of [...LEVEL_FIELDS,'sex']) {
      const value=field==='sex'?(['male','female','other'].includes(record.sex)?record.sex:null):normalizeLevel(record[field]);
      if(value!==null && (!entry.attributeSources[field] || time>=entry.attributeSources[field].observedAt)) {
        entry.attributes[field]=value;
        entry.attributeSources[field]={sourceRecordIndex:index,observedAt:time};
      }
    }
  });
  const groups = {high:[],low:[],unclassified:[]};
  for (const {record,index,indexes,attributes,attributeSources} of latest.values()) {
    const level = normalizeLevel(attributes[levelField]), levelHidden = level === '?';
    const group = levelHidden || (level !== null && level >= threshold) ? 'high' : level === null ? 'unclassified' : 'low';
    groups[group].push({uid:record.uid,nickname:record.nickname,sex:attributes.sex||'unknown',level,levelHidden,group,
      attributeValues:structuredClone(attributes),attributeSources:structuredClone(attributeSources),
      original:structuredClone(record),sourceRecordIndex:index,sourceRecordIndexes:indexes});
  }
  const sort = (a,b) => Number(b.levelHidden)-Number(a.levelHidden) || (b.level ?? -1)-(a.level ?? -1) || a.uid.localeCompare(b.uid);
  Object.values(groups).forEach(users=>users.sort(sort));
  const users = [...groups.high,...groups.low,...groups.unclassified];
  return {levelField,threshold,counts:{high:groups.high.length,low:groups.low.length,unclassified:groups.unclassified.length,total:users.length},groups,users};
}
module.exports = {LEVEL_FIELDS,validateOptions,normalizeLevel,classifyRecommendations};
