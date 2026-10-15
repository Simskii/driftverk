// Only this observed Sysbox failure is eligible for automatic recovery.
export function isBrokenSysbox(error) {
  return /unsafe procfs detected:.*operation not permitted/s.test(String(error?.message ?? error));
}

export async function probeRuntime(runner, runtimeId) {
  try {
    await runner('timeout', ['-k', '2', '5', 'docker', 'exec', runtimeId, '/bin/true']);
    return 'healthy';
  } catch (error) {
    return isBrokenSysbox(error) ? 'sysbox-failed' : 'unavailable';
  }
}
