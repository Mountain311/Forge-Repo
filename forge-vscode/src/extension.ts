import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// ---------------------------------------------------------------------------
// Forge Logger — writes to VS Code Output Channel "Forge Debug"
// Open it via: View → Output → select "Forge Debug" in the dropdown
// ---------------------------------------------------------------------------
let forgeOutputChannel: vscode.OutputChannel;

function getLogger(): vscode.OutputChannel {
    if (!forgeOutputChannel) {
        forgeOutputChannel = vscode.window.createOutputChannel('Forge Debug');
    }
    return forgeOutputChannel;
}

function log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', ...parts: any[]) {
    const ts = new Date().toISOString();
    const msg = parts.map(p => (typeof p === 'object' ? JSON.stringify(p, null, 2) : String(p))).join(' ');
    getLogger().appendLine(`[${ts}] [${level}] ${msg}`);
}

function logSeparator(label: string) {
    getLogger().appendLine(`\n${'='.repeat(80)}`);
    getLogger().appendLine(`  ${label}`);
    getLogger().appendLine('='.repeat(80));
}

function logApiRequest(url: string, data: any) {
    logSeparator('API REQUEST');
    log('DEBUG', `URL: ${url}`);
    log('DEBUG', 'Payload:', data);
}

function logApiResponse(agent: string, globalIter: number, turnIter: number, response: any, durationMs: number) {
    logSeparator(`API RESPONSE  [agent=${agent}] [globalIter=${globalIter}] [turnIter=${turnIter}]`);
    log('DEBUG', `Duration: ${durationMs}ms`);
    log('DEBUG', 'Response type:', response?.type ?? 'unknown');
    if (response?.type === 'function_calls') {
        log('DEBUG', `Function calls (${response.calls?.length ?? 0}):`,
            (response.calls ?? []).map((c: any) => `${c.name}(${JSON.stringify(c.args)})`));
        if (response.text) {
            log('DEBUG', 'Accompanying text:', response.text);
        }
    } else if (response?.type === 'text') {
        log('DEBUG', 'Text response:', response.text);
    } else {
        log('WARN', 'Unexpected response shape:', response);
    }
}

function logAgentRouting(from: string | null, to: string | null, reason: string) {
    log('INFO', `ROUTING  ${from ?? 'START'} → ${to ?? 'DONE'}  (${reason})`);
}

function logChatHistory(agent: string, history: any[]) {
    log('DEBUG', `[${agent}] Chat history (${history.length} messages):`);
    history.forEach((msg, i) => {
        const parts = (msg.parts ?? []).map((p: any) => {
            if (p.text !== undefined) return `text:"${p.text.slice(0, 120)}${p.text.length > 120 ? '…' : ''}"`;
            if (p.functionCall) return `functionCall:${p.functionCall.name}`;
            if (p.functionResponse) return `functionResponse:${p.functionResponse.name}`;
            return JSON.stringify(p);
        });
        log('DEBUG', `  [${i}] role=${msg.role}  parts=[${parts.join(', ')}]`);
    });
}

// ---------------------------------------------------------------------------
// Workspace Tools
// ---------------------------------------------------------------------------
class WorkspaceTools {
    static getWorkspaceRoot(): string {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error("No active workspace folder");
        }
        return folders[0].uri.fsPath;
    }

    static async readFile(filepath: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            const content = await fs.promises.readFile(fullPath, 'utf8');
            log('DEBUG', `readFile("${filepath}") → ${content.length} chars`);
            return content;
        } catch (error: any) {
            log('ERROR', `readFile("${filepath}") failed:`, error.message);
            return `Error reading file: ${error.message}`;
        }
    }

    static async createArtifact(filepath: string, content: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, content, 'utf8');
            log('DEBUG', `createArtifact("${filepath}") → success`);
            return `Successfully created artifact at ${filepath}`;
        } catch (error: any) {
            log('ERROR', `createArtifact("${filepath}") failed:`, error.message);
            return `Error creating artifact: ${error.message}`;
        }
    }

    static async writeCode(filepath: string, content: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, content, 'utf8');
            log('DEBUG', `writeCode("${filepath}") → success`);
            return `Successfully wrote code to ${filepath}`;
        } catch (error: any) {
            log('ERROR', `writeCode("${filepath}") failed:`, error.message);
            return `Error writing code: ${error.message}`;
        }
    }

    static async executeCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            log('DEBUG', `executeCommand: ${command}`);
            exec(command, { cwd: this.getWorkspaceRoot() }, (error, stdout, stderr) => {
                let result = "";
                if (stdout) result += `STDOUT:\n${stdout}\n`;
                if (stderr) result += `STDERR:\n${stderr}\n`;
                if (error) result += `ERROR:\n${error.message}\n`;
                const output = result || "Command executed with no output.";
                log('DEBUG', `executeCommand result (${command}):`, output.slice(0, 500));
                resolve(output);
            });
        });
    }

    static async updateTaskStatus(filepath: string, taskString: string, newStatus: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            let content = await fs.promises.readFile(fullPath, 'utf8');
            if (content.includes(taskString)) {
                content = content.replace(`- [ ] ${taskString}`, `- [${newStatus}] ${taskString}`);
                content = content.replace(`- [x] ${taskString}`, `- [${newStatus}] ${taskString}`);
                content = content.replace(`- [/] ${taskString}`, `- [${newStatus}] ${taskString}`);
                await fs.promises.writeFile(fullPath, content, 'utf8');
                log('DEBUG', `updateTaskStatus("${taskString}") → [${newStatus}]`);
                return `Successfully updated task status.`;
            } else {
                log('WARN', `updateTaskStatus: task string not found: "${taskString}"`);
                return `Task string not found in file.`;
            }
        } catch (error: any) {
            log('ERROR', `updateTaskStatus failed:`, error.message);
            return `Error updating task status: ${error.message}`;
        }
    }

    static async listDirectory(dirPath: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), dirPath);
            const items = await fs.promises.readdir(fullPath, { withFileTypes: true });
            const result = items.map(i => `${i.isDirectory() ? '[DIR]' : '[FILE]'} ${i.name}`).join('\n');
            log('DEBUG', `listDirectory("${dirPath}") → ${items.length} items`);
            return result === "" ? "Directory is empty." : result;
        } catch (error: any) {
            log('ERROR', `listDirectory("${dirPath}") failed:`, error.message);
            return `Error listing directory: ${error.message}`;
        }
    }

    static async searchCode(query: string, searchPath: string): Promise<string> {
        try {
            const targetPath = path.resolve(this.getWorkspaceRoot(), searchPath);
            const results: string[] = [];

            async function walk(dir: string) {
                const files = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const file of files) {
                    const res = path.resolve(dir, file.name);
                    if (file.isDirectory() && !res.includes('node_modules') && !res.includes('.git') && !res.includes('.venv')) {
                        await walk(res);
                    } else if (file.isFile()) {
                        const ext = path.extname(res);
                        if (['.ts', '.js', '.py', '.md', '.json', '.yaml', '.yml', '.txt', '.html', '.css'].includes(ext)) {
                            const content = await fs.promises.readFile(res, 'utf-8');
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                if (lines[i].includes(query)) {
                                    results.push(`${res.replace(targetPath, '')}:${i + 1}: ${lines[i].trim()}`);
                                }
                            }
                        }
                    }
                }
            }

            await walk(targetPath);
            log('DEBUG', `searchCode("${query}") → ${results.length} matches`);
            return results.length > 0 ? results.slice(0, 100).join('\n') : "No matches found.";
        } catch (error: any) {
            log('ERROR', `searchCode failed:`, error.message);
            return `Error searching code: ${error.message}`;
        }
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {

    // Ensure the output channel is created on activation so users can find it
    getLogger();
    log('INFO', 'Forge extension activated. Output channel: "Forge Debug"');

    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const userPrompt = request.prompt;
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor ? editor.document.getText(editor.selection) : "";

        logSeparator(`NEW REQUEST  "${userPrompt.slice(0, 80)}"`);
        log('INFO', 'User prompt:', userPrompt);
        log('INFO', 'Selected context length:', selectedText.length);

        // Reveal the output channel so developers see logs immediately
        getLogger().show(true);

        try {
            const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
            const client = await auth.getClient();

            const location = "us-central1";
            const endpointId = "projects/718442730167/locations/us-central1/reasoningEngines/754686089607774208";
            const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${endpointId}:query`;

            let currentAgent: string | null = "orchestrator";
            let currentPrompt: string | null = userPrompt;
            let dagState: any = {};
            const globalExecutionLog: string[] = [];

            let globalMaxIter = 50;
            log('INFO', `Starting agent loop. globalMaxIter=${globalMaxIter}`);

            while (currentAgent && globalMaxIter > 0) {
                if (token.isCancellationRequested) {
                    log('WARN', 'Cancellation requested — breaking outer loop');
                    break;
                }

                globalMaxIter--;
                const globalIterNum = 50 - globalMaxIter;

                log('INFO', `--- OUTER LOOP iter=${globalIterNum} agent="${currentAgent}" globalRemaining=${globalMaxIter} ---`);

                const requestData: any = {
                    agent_name: currentAgent,
                    prompt: currentPrompt,
                    context: selectedText
                };

                logApiRequest(url, requestData);
                stream.progress(`[${currentAgent}] Initializing...`);

                const t0 = Date.now();
                let turnResponse = await client.request({
                    url: url,
                    method: 'POST',
                    data: { input: requestData },
                    timeout: 120000
                });
                const initDuration = Date.now() - t0;

                let currentResponse = (turnResponse.data as any).output;
                logApiResponse(currentAgent, globalIterNum, 0, currentResponse, initDuration);

                const chatHistory: any[] = [];
                let isFinished = false;
                let turnIter = 15;

                while (!isFinished && turnIter > 0) {
                    if (token.isCancellationRequested) {
                        log('WARN', 'Cancellation requested — breaking inner loop');
                        break;
                    }

                    turnIter--;
                    const turnIterNum = 15 - turnIter;

                    log('INFO', `  INNER LOOP iter=${turnIterNum} agent="${currentAgent}" turnRemaining=${turnIter}`);
                    logChatHistory(currentAgent!, chatHistory);

                    chatHistory.push(currentResponse.raw_assistant_message);
                    let nextMessageContent: any;

                    if (currentResponse.type === "function_calls") {
                        const functionResponses: any[] = [];

                        const text = currentResponse.text || "";
                        if (text) {
                            stream.markdown(`\n> 🧠 **${currentAgent}** thought:\n> ${text.replace(/\n/g, '\n> ')}\n\n`);
                        }

                        stream.markdown(`\n> ⚙️ **${currentAgent}** is executing tools:\n`);
                        log('INFO', `  Executing ${currentResponse.calls.length} tool call(s)`);

                        for (const call of currentResponse.calls) {
                            const name = call.name;
                            const args = call.args;
                            let apiResponse = "";

                            globalExecutionLog.push(`[${currentAgent}] Tool Call: ${name}(${JSON.stringify(args)})`);
                            log('DEBUG', `  Tool → ${name}`, args);
                            stream.markdown(`> - \`${name}\`\n`);

                            const toolStart = Date.now();
                            try {
                                if (name === "read_file") {
                                    apiResponse = await WorkspaceTools.readFile(args.filepath);
                                } else if (name === "create_artifact") {
                                    apiResponse = await WorkspaceTools.createArtifact(args.filepath, args.content);
                                } else if (name === "write_code") {
                                    apiResponse = await WorkspaceTools.writeCode(args.filepath, args.content);
                                } else if (name === "execute_command") {
                                    apiResponse = await WorkspaceTools.executeCommand(args.command);
                                } else if (name === "update_task_status") {
                                    apiResponse = await WorkspaceTools.updateTaskStatus(args.filepath, args.task_string, args.new_status);
                                } else if (name === "list_directory") {
                                    apiResponse = await WorkspaceTools.listDirectory(args.path);
                                } else if (name === "search_code") {
                                    apiResponse = await WorkspaceTools.searchCode(args.query, args.directory);
                                } else {
                                    apiResponse = `Tool ${name} not implemented locally.`;
                                    log('WARN', `Unknown tool called: ${name}`);
                                }
                            } catch (e: any) {
                                apiResponse = `Tool execution failed: ${e.message}`;
                                log('ERROR', `Tool "${name}" threw:`, e.message);
                            }

                            log('DEBUG', `  Tool ← ${name} (${Date.now() - toolStart}ms) response:`,
                                apiResponse.slice(0, 300) + (apiResponse.length > 300 ? '…' : ''));

                            functionResponses.push({
                                functionResponse: { name: name, response: { content: apiResponse } }
                            });
                        }

                        stream.markdown(`\n`);
                        nextMessageContent = JSON.stringify(functionResponses);

                    } else {
                        // Text response
                        const text = currentResponse.text || "";
                        globalExecutionLog.push(`[${currentAgent}] Agent Output: ${text}`);

                        log('DEBUG', `  Text response from "${currentAgent}":`, text.slice(0, 400));

                        if (currentAgent !== "orchestrator") {
                            stream.markdown(`${text}\n\n`);

                            logAgentRouting(currentAgent, "orchestrator", "agent finished, returning to orchestrator");
                            currentAgent = "orchestrator";
                            currentPrompt = `Agent just finished its work and returned this text: "${text}".\n\nPlease check .forge/Task_list.md and determine next routing step.`;
                            isFinished = true;
                            continue;
                        }

                        if (currentAgent === "orchestrator") {
                            try {
                                const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
                                log('DEBUG', 'Parsing orchestrator JSON:', cleaned.slice(0, 500));
                                dagState = JSON.parse(cleaned);

                                log('INFO', 'DAG State:', dagState);

                                if (dagState.message_to_user) {
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);
                                }

                                const nextRoute = dagState.next_agent_routing;
                                if (nextRoute && nextRoute !== "none" && nextRoute !== "null" && nextRoute !== null) {
                                    logAgentRouting(currentAgent, nextRoute, `DAG next_agent_routing="${nextRoute}"`);
                                    currentAgent = nextRoute;
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nDAG State:\n${JSON.stringify(dagState, null, 2)}\n\nBegin execution.`;
                                } else {
                                    logAgentRouting(currentAgent, null, `DAG routing resolved to null/none — done`);
                                    currentAgent = null;
                                }
                                isFinished = true;
                                continue;
                            } catch (e) {
                                log('WARN', 'Failed to parse orchestrator JSON:', e);
                                nextMessageContent = "Please output the DAG state as valid strict JSON only. Do not wrap it in text.";
                            }
                        }
                    }

                    if (isFinished) break;

                    if (nextMessageContent) {
                        chatHistory.push({
                            role: "user",
                            parts: [{ text: nextMessageContent }]
                        });

                        const nextRequestData = {
                            agent_name: currentAgent,
                            message: nextMessageContent,
                            chat_history: chatHistory
                        };

                        logApiRequest(url, {
                            agent_name: currentAgent,
                            message: nextMessageContent.slice(0, 200) + '…',
                            chat_history_length: chatHistory.length
                        });

                        const tCont = Date.now();
                        turnResponse = await client.request({
                            url: url,
                            method: 'POST',
                            data: { input: nextRequestData },
                            timeout: 120000
                        });
                        const contDuration = Date.now() - tCont;

                        currentResponse = (turnResponse.data as any).output;
                        logApiResponse(currentAgent!, globalIterNum, turnIterNum, currentResponse, contDuration);
                    }
                }

                if (turnIter === 0) {
                    log('ERROR', `Agent "${currentAgent}" hit max turn iterations (15) — halting to prevent infinite loop`);
                    log('ERROR', 'Chat history at halt:', chatHistory);
                    stream.markdown(`\n\n**System Error:** Agent hit maximum function call iterations and was halted to prevent an infinite loop.`);
                    currentAgent = null;
                }
            }

            if (globalMaxIter === 0) {
                log('ERROR', 'System hit max global iterations (50) — halting');
                log('ERROR', 'Execution log at halt:', globalExecutionLog);
                stream.markdown(`\n\n**System Error:** System hit maximum agent routing iterations and was halted.`);
            }

            logSeparator('DAG EXECUTION COMPLETE');
            log('INFO', 'Final execution log:', globalExecutionLog);
            stream.markdown(`\n\n--- \n*DAG Execution Complete.*`);

        } catch (error: any) {
            log('ERROR', 'Unhandled error in handler:', error?.message ?? error);
            log('ERROR', 'Stack:', error?.stack ?? '(no stack)');
            stream.markdown(`\n\n**Forge Error:** ${error}`);
        }

        return { metadata: { command: '' } };
    };

    const forgeChat = vscode.chat.createChatParticipant("forge.chat", handler);
    context.subscriptions.push(forgeChat);
}
