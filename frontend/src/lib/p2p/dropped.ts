/**
 * Files from a drop, with folders expanded.
 *
 * `dataTransfer.files` lists a dropped folder as a single zero-byte "file" that
 * fails the moment anything reads it — and dropping the folder is exactly how
 * most people would hand over a batch of photos from a laptop. The entries API
 * lets us walk into it instead.
 *
 * `webkitGetAsEntry` must be called synchronously inside the drop handler (the
 * DataTransfer is emptied once the event returns), so collect the entries
 * first and only then go async.
 */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);

  if (!entries.length) return Array.from(dt.files);

  const out: File[] = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(entry: FileSystemEntry, out: File[]): Promise<void> {
  // Skip .DS_Store, Thumbs.db-style dotfiles and hidden folders.
  if (entry.name.startsWith(".")) return;
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (file) out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns batches (100 at a time in Chrome); read until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (!batch.length) break;
      for (const child of batch) await walk(child, out);
    }
  }
}
