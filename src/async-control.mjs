export function isAbortError(error) { return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'; }
export function throwIfAborted(signal) {
  if (signal?.aborted) { const error = new Error('Operation cancelled'); error.name = 'AbortError'; throw error; }
}
export function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); const e = new Error('Operation cancelled'); e.name = 'AbortError'; reject(e); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', abort, { once: true });
  });
}
