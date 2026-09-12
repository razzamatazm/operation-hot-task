import { promises as fs } from "node:fs";
import path from "node:path";

/* How a store's file is created, read and saved. */
export interface JsonFileOptions<T> {
  /* What a new file starts as — and, for a lenient store, what an unreadable
     one reads as. Called fresh each time, so a caller may mutate what it gets. */
  empty: () => T;
  /* Shapes what was parsed into the stored type: defaults, legacy fields.
     Runs on every read. Without it, the parsed JSON is taken as-is. */
  decode?: (parsed: unknown) => T;
  /* Shapes a value on its way to disk. Runs on every save. */
  encode?: (value: T) => unknown;
  /* Read a file that can't be read or parsed as `empty()` instead of throwing.
     Only for state that is safe to lose, where carrying on beats failing. */
  lenient?: boolean;
}

/* The one place the server reads and writes a data file (#339).

   Every store keeps its state in a JSON file and rewrites the whole file on
   each save, and a whole-file write truncates before it fills. A read landing
   in that gap parses an empty or partial file, and depending on the store that
   either threw or quietly answered "nothing here": a loan rename left a channel
   card on the old name (#331), and admin settings answered "no channel chosen",
   broadcasting to every channel. The fix was the same every time — make reads
   wait behind saves — and was applied store by store until there were seven
   copies of it, each fix finding a store the last one missed.

   So the rule lives here, once, and a store gets it by being built on this
   rather than by remembering it. One queue per file runs everything in call
   order: creating the file, every read, every change. There is no way to read
   the file that skips the queue.

   A change is one step: `update` hands `apply` the file as it is at that
   change's turn and saves what comes back, so two changes can never overwrite
   each other from the same starting point (#158). `apply` is synchronous on
   purpose. It cannot await anything, so it cannot await a read of this same
   file from inside the queue — the one way a queue like this deadlocks. */
export class JsonFile<T> {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly options: JsonFileOptions<T>
  ) {}

  /* Create the file with `empty()` if it isn't there. An existing file is left
     exactly as it is, whatever it holds. */
  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.enqueue(async () => {
      try {
        await fs.access(this.filePath);
      } catch {
        await this.save(this.options.empty());
      }
    });
  }

  /* The file as it stands once every change queued before this read is done.
     A fresh copy each time, so the caller may keep or mutate it. */
  read(): Promise<T> {
    return this.enqueue(() => this.load());
  }

  /* Read, change and save in one step. `apply` gets a fresh copy of the file as
     it is now and returns the value to save, or `undefined` to save nothing.
     Resolves with what was saved. If `apply` or the read throws, nothing is
     saved and only this caller sees the error; the queue carries on. */
  update(apply: (current: T) => T | undefined): Promise<T | undefined> {
    return this.enqueue(async () => {
      const next = apply(await this.load());
      if (next !== undefined) {
        await this.save(next);
      }
      return next;
    });
  }

  /* Copy the file, byte for byte and under its own name, into `dir` (#370's
     start-up backup). Queued like everything else, so the copy is the file
     between two saves and never a half-written one. */
  copyInto(dir: string): Promise<void> {
    return this.enqueue(async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.copyFile(this.filePath, path.join(dir, path.basename(this.filePath)));
    });
  }

  private async load(): Promise<T> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return this.options.decode ? this.options.decode(parsed) : (parsed as T);
    } catch (error) {
      if (this.options.lenient) {
        return this.options.empty();
      }
      throw error;
    }
  }

  private async save(value: T): Promise<void> {
    const encoded = this.options.encode ? this.options.encode(value) : value;
    await fs.writeFile(this.filePath, JSON.stringify(encoded, null, 2), "utf8");
  }

  /* One operation at a time, in call order. The chain is kept settled and
     value-free: the caller gets its own result or rejection, and the next
     operation runs either way, so one failure never wedges the file. */
  private enqueue<R>(operation: () => Promise<R>): Promise<R> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
