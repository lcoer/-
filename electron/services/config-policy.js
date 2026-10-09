function validateConfigChange(key, value) {
  const error = reason => ({ ok: false, reason });
  if (!['rules', 'copywriting', 'blacklist', 'settings', 'collection'].includes(key))
    return error('INVALID_CONFIG_KEY');
  if (key === 'blacklist')
    return Array.isArray(value) && value.every(v => typeof v === 'string' && /^\d+$/.test(v)) ? { ok: true } : error('INVALID_BLACKLIST');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return error('INVALID_CONFIG');
  if (key === 'settings' && !['android', 'demo'].includes(value.executionMode))
    return error('INVALID_EXECUTION_MODE');
  if (key === 'collection' && (!['single', 'multi'].includes(value.scope) || !Number.isInteger(value.maxRooms) || value.maxRooms < 1 || value.maxRooms > 30 || !Number.isInteger(value.maxPages) || value.maxPages < 1 || value.maxPages > 12))
    return error('INVALID_COLLECTION_CONFIG');
  if (key === 'collection' && value.maxProfiles != null && (!Number.isInteger(value.maxProfiles) || value.maxProfiles < 0 || value.maxProfiles > 12))
    return error('INVALID_COLLECTION_CONFIG');
  if (key === 'copywriting' && (!Array.isArray(value.contents) || value.contents.some(t => typeof t !== 'string') || !['random', 'select', 'mediaonly'].includes(value.mode)))
    return error('INVALID_COPYWRITING');
  if (key === 'rules') {
    if (!Number.isFinite(value.delayMin) || !Number.isFinite(value.delayMax) || value.delayMin < 0 || value.delayMax < value.delayMin || value.delayMax > 86400)
      return error('INVALID_DELAY');
    if (value.sendLimit != null && (!Number.isSafeInteger(value.sendLimit) || value.sendLimit < 0))
      return error('INVALID_SEND_LIMIT');
  }
  return { ok: true };
}
module.exports = { validateConfigChange };
