import { access, appendFile, constants, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Picks a free name in `dir`, following the "name, name.2, name.3, ..." convention GNOME/KDE/macOS trash use. */
async function uniqueName(dir: string, name: string): Promise<string> {
  let candidate = name;
  let suffix = 2;
  for (;;) {
    try {
      await access(join(dir, candidate), constants.F_OK);
      candidate = `${name}.${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

/** rename() across filesystems throws EXDEV — fall back to copy+unlink so the move still succeeds. */
async function renameOrCopy(originalPath: string, destPath: string): Promise<void> {
  try {
    await rename(originalPath, destPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(originalPath, destPath);
    await unlink(originalPath);
  }
}

// ---------------------------------------------------------------------------
// Linux: freedesktop.org XDG Trash (~/.local/share/Trash) — the same trash
// GNOME/KDE file managers read. Identical across every distro family (Debian,
// RHEL/Fedora, Arch, ...) since it's a desktop-environment spec, not a
// distro-specific mechanism, and this module never shells out to anything
// distro-specific to implement it.
// ---------------------------------------------------------------------------

function xdgTrashHome(): string {
  return process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "Trash") : join(homedir(), ".local", "share", "Trash");
}

function trashInfoContent(originalPath: string): string {
  const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  return `[Trash Info]\nPath=${originalPath}\nDeletionDate=${deletionDate}\n`;
}

async function moveToTrashLinux(originalPath: string): Promise<void> {
  const home = xdgTrashHome();
  const filesDir = join(home, "files");
  const infoDir = join(home, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });

  const name = await uniqueName(filesDir, basename(originalPath));
  await appendFile(join(infoDir, `${name}.trashinfo`), trashInfoContent(originalPath));
  await renameOrCopy(originalPath, join(filesDir, name));
}

// ---------------------------------------------------------------------------
// macOS: ~/.Trash — the same folder Finder's Trash reads, on both Apple
// Silicon and Intel (this is purely an OS/filesystem convention, identical
// across CPU architecture). Finder won't get "Put Back" origin metadata for a
// file moved here directly (that's Finder-internal xattr bookkeeping we can't
// set without AppleScript), but the file lands in the real Trash, is visible
// there, and is recoverable — same approach widely-used CLI trash tools take.
// ---------------------------------------------------------------------------

async function moveToTrashMac(originalPath: string): Promise<void> {
  const trashDir = join(homedir(), ".Trash");
  await mkdir(trashDir, { recursive: true });
  const name = await uniqueName(trashDir, basename(originalPath));
  await renameOrCopy(originalPath, join(trashDir, name));
}

// ---------------------------------------------------------------------------
// Windows: the real Recycle Bin, via the standard documented .NET call
// (Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile with
// RecycleOption.SendToRecycleBin) — no native addon or extra dependency
// needed, just shelling out to the PowerShell that ships with every Windows
// install. The Recycle Bin itself handles name collisions (each deletion
// keeps its own origin-path metadata), so no uniqueName step is needed here.
// ---------------------------------------------------------------------------

function powerShellQuote(path: string): string {
  return path.replace(/'/g, "''");
}

async function moveToTrashWindows(originalPath: string): Promise<void> {
  const script = `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${powerShellQuote(originalPath)}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Add-Type -AssemblyName Microsoft.VisualBasic; ${script}`,
  ]);
}

/**
 * Moves a file to the current OS's real trash/recycle bin — never a hard delete. Dispatches by
 * `process.platform` to the Linux/macOS/Windows implementation above. Idempotent on an already-missing
 * file (the goal state — "this session's file is gone" — already holds).
 */
export async function moveToTrash(originalPath: string): Promise<void> {
  try {
    await stat(originalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  if (process.platform === "win32") return moveToTrashWindows(originalPath);
  if (process.platform === "darwin") return moveToTrashMac(originalPath);
  return moveToTrashLinux(originalPath);
}
