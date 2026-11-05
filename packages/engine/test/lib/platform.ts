// Shared platform switches for tests.
/** POSIX shell scripts, file modes and `"` in file names work (not on Windows). */
export const posix = process.platform !== "win32";
