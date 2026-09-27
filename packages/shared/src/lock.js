import fsp from 'node:fs/promises';

/** mkdir is atomic on POSIX, which makes it a usable cross-process lock. */
export async function acquireLock(dir, { timeoutMs = 5000, retryMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.mkdir(dir);
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new Error(`lock timeout: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

export async function releaseLock(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}
