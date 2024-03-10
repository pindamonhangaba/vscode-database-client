import { ConfigKey } from '@/common/constants';
import { Global } from '@/common/global';
import * as vscode from 'vscode';
import { SQLParser } from '../parser/sqlParser';
import { Node } from '@/model/interface/node';

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
    public activeConnectionName:string;


    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    public refresh({node}:{node:Node}): void {
        this.activeConnectionName=(node.parent.name||node.parent.label) +" "+(node.label||node.name);
        this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
        return this.parseCodeLens(document)
    }
    resolveCodeLens?(codeLens: vscode.CodeLens, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens> {
        throw new Error('Method not implemented.');
    }

    public parseCodeLens(document: vscode.TextDocument): vscode.ProviderResult<vscode.CodeLens[]> {
        if (Global.getConfig<number>(ConfigKey.DISABLE_SQL_CODELEN)) {
            return []
        }

        return SQLParser.parseBlocks(document).map(
          (block) =>
            new vscode.CodeLens(block.range, {
              command: "mysql.codeLens.run",
              title: `${
                this.activeConnectionName ?? "[no connection]"
              } ▶ Run SQL`,
              arguments: [block.sql, document.uri.fsPath],
            })
        );
    }

}