import type { UploadItem } from './api';

// Minimal shape of the non-standard (but universally supported) entries API.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  name: string;
  file(onSuccess: (file: File) => void, onError: (err: unknown) => void): void;
  createReader(): {
    readEntries(onSuccess: (entries: FsEntry[]) => void, onError: (err: unknown) => void): void;
  };
}

const fileOf = (entry: FsEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** readEntries yields at most ~100 entries per call, so it must be drained. */
async function readAll(entry: FsEntry): Promise<FsEntry[]> {
  const reader = entry.createReader();
  const entries: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function walk(entry: FsEntry, prefix: string, out: UploadItem[]): Promise<void> {
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ file: await fileOf(entry), relPath });
    return;
  }
  if (entry.isDirectory) {
    for (const child of await readAll(entry)) {
      await walk(child, relPath, out);
    }
  }
}

/** Flattens a drop of files and/or folders into uploadable items with relative paths. */
export async function itemsFromDrop(transfer: DataTransfer): Promise<UploadItem[]> {
  const entries: FsEntry[] = [];
  for (const item of Array.from(transfer.items)) {
    // The DOM's FileSystemEntry type omits file()/createReader(), so re-type it.
    const entry = item.webkitGetAsEntry?.() as unknown as FsEntry | null;
    if (entry) entries.push(entry);
  }

  // Browsers without the entries API still give us a flat file list.
  if (!entries.length) {
    return Array.from(transfer.files).map((file) => ({ file, relPath: file.name }));
  }

  const items: UploadItem[] = [];
  for (const entry of entries) await walk(entry, '', items);
  return items;
}

/** Items from an <input type="file"> — webkitdirectory sets webkitRelativePath. */
export function itemsFromInput(files: FileList): UploadItem[] {
  return Array.from(files).map((file) => ({
    file,
    relPath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }));
}
