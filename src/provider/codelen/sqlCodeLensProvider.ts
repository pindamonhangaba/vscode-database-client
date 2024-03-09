import { ConfigKey } from '@/common/constants';
import { Global } from '@/common/global';
import * as vscode from 'vscode';
import { SQLParser } from '../parser/sqlParser';

export class SqlCodeLensProvider implements vscode.CodeLensProvider {
    public activeConnectionName:string;


    onDidChangeCodeLenses?: vscode.Event<void>;
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