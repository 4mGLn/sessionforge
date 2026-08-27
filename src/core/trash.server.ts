import { access, appendFile, constants, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

function trashHome(): string {
  return process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "Trash") : join(homedir(), ".local", "share", "Trash");
}

function trashInfoContent(originalPath: string): string {
  const deletionDate = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  return `[Trash Info]\nPath=${originalPath}\nDeletionDate=${deletionDate}\n`;
}

/** Picks a free name in trash `files/`, following the "name, name.2, name.3, ..." convention GNOME/KDE use. */
async function uniqueTrashName(filesDir: string, name: string): Promise<string> {
  let candidate = name;
  let suffix = 2;
  for (;;) {
    try {
      await access(join(filesDir, candidate), constants.F_OK);
      candidate = `${name}.${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * Moves a file to the freedesktop.org XDG Trash (`~/.local/share/Trash`) — the same trash GNOME/KDE file
 * managers read, so a deleted session is restorable from there even though SessionForge itself offers no
 * undo. Falls back to copy+unlink when the trash directory is on a different filesystem (`rename`'s EXDEV).
 */
export async function moveToTrash(originalPath: string): Promise<void> {
  try {
    await stat(originalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  const home = trashHome();
  const filesDir = join(home, "files");
  const infoDir = join(home, "info");
  await mkdir(filesDir, { recursive: true });
  await mkdir(infoDir, { recursive: true });

  const name = await uniqueTrashName(filesDir, basename(originalPath));
  const destPath = join(filesDir, name);
  await appendFile(join(infoDir, `${name}.trashinfo`), trashInfoContent(originalPath));

  try {
    await rename(originalPath, destPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(originalPath, destPath);
    await unlink(originalPath);
  }
}
