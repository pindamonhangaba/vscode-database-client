import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { FileManager } from "@/common/filesManager";
import { ModelType } from "@/common/constants";
import { Global } from "@/common/global";

//#region Utilities

namespace _ {
  function handleResult<T>(
    resolve: (result: T) => void,
    reject: (error: Error) => void,
    error: Error | null | undefined,
    result: T
  ): void {
    if (error) {
      reject(massageError(error));
    } else {
      resolve(result);
    }
  }

  function massageError(error: Error & { code?: string }): Error {
    if (error.code === "ENOENT") {
      return vscode.FileSystemError.FileNotFound();
    }

    if (error.code === "EISDIR") {
      return vscode.FileSystemError.FileIsADirectory();
    }

    if (error.code === "EEXIST") {
      return vscode.FileSystemError.FileExists();
    }

    if (error.code === "EPERM" || error.code === "EACCES") {
      return vscode.FileSystemError.NoPermissions();
    }

    return error;
  }

  export function checkCancellation(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
      throw new Error("Operation cancelled");
    }
  }

  export function normalizeNFC(items: string): string;
  export function normalizeNFC(items: string[]): string[];
  export function normalizeNFC(items: string | string[]): string | string[] {
    if (process.platform !== "darwin") {
      return items;
    }

    if (Array.isArray(items)) {
      return items.map((item) => item.normalize("NFC"));
    }

    return items.normalize("NFC");
  }

  export function readdir(path: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      fs.readdir(path, (error, children) =>
        handleResult(resolve, reject, error, normalizeNFC(children))
      );
    });
  }

  export function stat(path: string): Promise<fs.Stats> {
    return new Promise<fs.Stats>((resolve, reject) => {
      fs.stat(path, (error, stat) =>
        handleResult(resolve, reject, error, stat)
      );
    });
  }

  export function readfile(path: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      fs.readFile(path, (error, buffer) =>
        handleResult(resolve, reject, error, buffer)
      );
    });
  }

  export function writefile(path: string, content: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.writeFile(path, content, (error) =>
        handleResult(resolve, reject, error, void 0)
      );
    });
  }

  export function exists(path: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      fs.exists(path, (exists) => handleResult(resolve, reject, null, exists));
    });
  }

  export async function rimraf(uri: vscode.Uri): Promise<void> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.File) {
      // If it's a file, simply delete it
      await vscode.workspace.fs.delete(uri);
    } else if (stat.type === vscode.FileType.Directory) {
      // If it's a directory, recursively delete its contents
      const children = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of children) {
        const childUri = vscode.Uri.joinPath(uri, name);
        await rimraf(childUri);
      }
      // Finally, delete the directory itself
      await vscode.workspace.fs.delete(uri);
    }
  }

  export async function mkdirp(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(uri);
    } catch (error) {
      // Ignore "File already exists" error
      if (
        error instanceof vscode.FileSystemError &&
        error.code === "FileExists"
      ) {
        return;
      }
      // If it's not a "File already exists" error, rethrow it
      throw error;
    }
  }

  export function rename(oldPath: string, newPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.rename(oldPath, newPath, (error) =>
        handleResult(resolve, reject, error, void 0)
      );
    });
  }

  export function unlink(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(path, (error) => handleResult(resolve, reject, error, void 0));
    });
  }
}

export class FileStat implements vscode.FileStat {
  constructor(private fsStat: fs.Stats) {}

  get type(): vscode.FileType {
    return this.fsStat.isFile()
      ? vscode.FileType.File
      : this.fsStat.isDirectory()
      ? vscode.FileType.Directory
      : this.fsStat.isSymbolicLink()
      ? vscode.FileType.SymbolicLink
      : vscode.FileType.Unknown;
  }

  get isFile(): boolean | undefined {
    return this.fsStat.isFile();
  }

  get isDirectory(): boolean | undefined {
    return this.fsStat.isDirectory();
  }

  get isSymbolicLink(): boolean | undefined {
    return this.fsStat.isSymbolicLink();
  }

  get size(): number {
    return this.fsStat.size;
  }

  get ctime(): number {
    return this.fsStat.ctime.getTime();
  }

  get mtime(): number {
    return this.fsStat.mtime.getTime();
  }
}

export class Entry {
  contextValue = ModelType.FOLDER;

  uri: vscode.Uri;
  type: vscode.FileType;
  constructor(uri: vscode.Uri, type: vscode.FileType) {
    this.uri = uri;
    this.type = type;
    if (type !== vscode.FileType.Directory) {
      this.contextValue = ModelType.FILE;
    }
  }
}

//#endregion

const viewItemContext = "focusedItem";

export class FileSystemProvider
  implements vscode.TreeDataProvider<Entry>, vscode.FileSystemProvider
{
  private watcher: vscode.Disposable;
  private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;
  private defaultLocation?: vscode.Uri;
  private selection: Entry[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Check if the configuration change affects your extension
      if (event.affectsConfiguration("database-client.scriptsFolder")) {
        // Retrieve the updated setting value
        this.defaultLocation = Global.getConfig("scriptsFolder")
          ? vscode.Uri.file(Global.getConfig("scriptsFolder"))
          : this.defaultLocation;
      }
      this.refresh();
    });

    if (Global.getConfig("scriptsFolder")) {
      this.defaultLocation = vscode.Uri.file(
        `${Global.getConfig("scriptsFolder")}`
      );
    } else {
      const dir = vscode.Uri.joinPath(context.globalStorageUri, "./scripts");
      this.createDirectory(dir).then(() => {
        this.defaultLocation = dir;
        this.watcher = this.watch(this.defaultLocation, {
          recursive: true,
          excludes: [],
        });
      });
    }
  }

  // Method to update the viewItem context key
  private updateViewItemContext(selectedItems: Entry[]): void {
    this.selection = selectedItems;
  }

  public getDefaultLocation() {
    return this.defaultLocation;
  }

  public async refresh() {
    this.watcher?.dispose?.();
    this.watcher = this.watch(this.defaultLocation, {
      recursive: true,
      excludes: [],
    });
    this._onDidChangeTreeData.fire();
  }

  public selected() {
    return this.selection;
  }

  // Event handler for tree view selection change
  public onDidChangeTreeSelection(
    event: vscode.TreeViewSelectionChangeEvent<Entry>
  ): void {
    this.updateViewItemContext(event.selection);
  }

  get onDidChangeFile(): vscode.Event<vscode.FileChangeEvent[]> {
    return this._onDidChangeFile.event;
  }

  private _onDidChangeTreeData: vscode.EventEmitter<
    Entry | undefined | null | void
  > = new vscode.EventEmitter<Entry | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<Entry | undefined | null | void> =
    this._onDidChangeTreeData.event;

  watch(
    uri: vscode.Uri,
    options: { recursive: boolean; excludes: string[] }
  ): vscode.Disposable {
    const watcher = fs.watch(
      uri.fsPath,
      { recursive: options.recursive },
      async (event, filename) => {
        this._onDidChangeTreeData.fire(); // Signal tree data change
        if (filename) {
          const filepath = path.join(
            uri.fsPath,
            _.normalizeNFC(filename.toString())
          );

          // TODO support excludes (using minimatch library?)
          this._onDidChangeFile.fire([
            {
              type:
                event === "change"
                  ? vscode.FileChangeType.Changed
                  : (await _.exists(filepath))
                  ? vscode.FileChangeType.Created
                  : vscode.FileChangeType.Deleted,
              uri: uri.with({ path: filepath }),
            } as vscode.FileChangeEvent,
          ]);
        }
      }
    );

    return { dispose: () => watcher.close() };
  }

  stat(uri: vscode.Uri): vscode.FileStat | Thenable<vscode.FileStat> {
    return this._stat(uri.fsPath);
  }

  async _stat(path: string): Promise<vscode.FileStat> {
    return new FileStat(await _.stat(path));
  }

  readDirectory(
    uri: vscode.Uri
  ): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
    return this._readDirectory(uri);
  }

  async _readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const children = await _.readdir(uri.fsPath);

    const result: [string, vscode.FileType][] = [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const stat = await this._stat(path.join(uri.fsPath, child));
      result.push([child, stat.type]);
    }

    return Promise.resolve(result);
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return _.mkdirp(uri) as any;
  }

  readFile(uri: vscode.Uri): Uint8Array | Thenable<Uint8Array> {
    return _.readfile(uri.fsPath);
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): void | Thenable<void> {
    return this._writeFile(uri, content, options);
  }

  async _writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const exists = await _.exists(uri.fsPath);
    if (!exists) {
      if (!options.create) {
        throw vscode.FileSystemError.FileNotFound();
      }

      await _.mkdirp(vscode.Uri.file(path.dirname(uri.fsPath)));
    } else {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists();
      }
    }

    return _.writefile(uri.fsPath, content as Buffer);
  }

  delete(
    uri: vscode.Uri,
    options: { recursive: boolean }
  ): void | Thenable<void> {
    if (options.recursive) {
      return _.rimraf(uri) as any;
    }

    return _.unlink(uri.fsPath);
  }

  rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): void | Thenable<void> {
    return this._rename(oldUri, newUri, options);
  }

  async _rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const exists = await _.exists(newUri.fsPath);
    if (exists) {
      if (!options.overwrite) {
        throw vscode.FileSystemError.FileExists();
      } else {
        await _.rimraf(newUri);
      }
    }

    const parentExists = await _.exists(path.dirname(newUri.fsPath));
    if (!parentExists) {
      await _.mkdirp(vscode.Uri.file(path.dirname(newUri.fsPath)));
    }

    return _.rename(oldUri.fsPath, newUri.fsPath);
  }

  // tree data provider

  async getChildren(element?: Entry): Promise<Entry[]> {
    if (element) {
      const children = await this.readDirectory(element.uri);
      return children.map(
        ([name, type]) =>
          new Entry(vscode.Uri.file(path.join(element.uri.fsPath, name)), type)
      );
    }

    if (this.defaultLocation) {
      const children = await this.readDirectory(this.defaultLocation);
      children.sort((a, b) => {
        if (a[1] === b[1]) {
          return a[0].localeCompare(b[0]);
        }
        return a[1] === vscode.FileType.Directory ? -1 : 1;
      });
      return children.map(
        ([name, type]) =>
          new Entry(
            vscode.Uri.file(path.join(this.defaultLocation.fsPath, name)),
            type
          )
      );
    }
    return [];
  }

  getTreeItem(element: Entry): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(
      element.uri,
      element.type === vscode.FileType.Directory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    if (element.type === vscode.FileType.File) {
      treeItem.command = {
        command: "github.cweijan.scripts.openFile",
        title: "Open File",
        arguments: [element.uri],
      };
      treeItem.contextValue = "file";
    }
    return treeItem;
  }
}
