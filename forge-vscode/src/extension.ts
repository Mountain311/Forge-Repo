import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// Ensure you have this import for the dashboard!
import { ForgeDashboard } from './dashboard';

// ---------------------------------------------------------------------------
// Forge Logger — writes to VS Code Output Channel "Forge Debug"
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

function summariseRawAssistantMessage(response: any) {
    const raw = response?.raw_assistant_message;
    const parts = raw?.parts ?? [];
    const textParts = parts.filter((p: any) => p?.text !== undefined);
    const functionCallParts = parts.filter((p: any) => p?.functionCall);

    return {
        hasRawAssistantMessage: !!raw,
        role: raw?.role ?? 'unknown',
        partCount: parts.length,
        textPartCount: textParts.length,
        functionCallPartCount: functionCallParts.length,
        textLengths: textParts.map((p: any) => (p.text ?? '').length),
        hasNonEmptyTextPart: textParts.some((p: any) => (p.text ?? '').trim().length > 0),
        responseTextLength: (response?.text ?? '').length,
    };
}

function logApiResponse(agent: string, globalIter: number, turnIter: number, response: any, durationMs: number) {
    logSeparator(`API RESPONSE  [agent=${agent}] [globalIter=${globalIter}] [turnIter=${turnIter}]`);
    log('DEBUG', `Duration: ${durationMs}ms`);
    log('DEBUG', 'Response type:', response?.type ?? 'unknown');
    const rawSummary = summariseRawAssistantMessage(response);
    log('DEBUG', 'Raw response summary:', rawSummary);
    if (response?.type === 'function_calls') {
        log('DEBUG', `Function calls (${response.calls?.length ?? 0}):`,
            (response.calls ?? []).map((c: any) => `${c.name}(${JSON.stringify(c.args)})`));
        if (response.text) {
            log('DEBUG', 'Accompanying text:', response.text);
        }
    } else if (response?.type === 'text') {
        log('DEBUG', 'Text response:', response.text);
    }
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
            const root = this.getWorkspaceRoot();
            const fullPath = path.isAbsolute(filepath) ? filepath : path.join(root, filepath);
            return await fs.promises.readFile(fullPath, 'utf8');
        } catch (error: any) {
            return `Error reading file: ${error.message}`;
        }
    }

    static async createArtifact(filepath: string, content: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, content, 'utf8');
            return `Successfully created artifact at ${filepath}`;
        } catch (error: any) {
            return `Error creating artifact: ${error.message}`;
        }
    }

    static async writeCode(filepath: string, content: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), filepath);
            await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.promises.writeFile(fullPath, content, 'utf8');
            return `Successfully wrote code to ${filepath}`;
        } catch (error: any) {
            return `Error writing code: ${error.message}`;
        }
    }

    static async executeCommand(command: string): Promise<string> {
        return new Promise((resolve) => {
            exec(command, { cwd: this.getWorkspaceRoot() }, (error, stdout, stderr) => {
                let result = "";
                if (stdout) result += `STDOUT:\n${stdout}\n`;
                if (stderr) result += `STDERR:\n${stderr}\n`;
                if (error) result += `ERROR:\n${error.message}\n`;
                resolve(result || "Command executed with no output.");
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
                return `Successfully updated task status.`;
            }
            return `Task string not found in file.`;
        } catch (error: any) {
            return `Error updating task status: ${error.message}`;
        }
    }

    static async listDirectory(dirPath: string): Promise<string> {
        try {
            const fullPath = path.resolve(this.getWorkspaceRoot(), dirPath);
            const items = await fs.promises.readdir(fullPath, { withFileTypes: true });
            const result = items.map(i => `${i.isDirectory() ? '[DIR]' : '[FILE]'} ${i.name}`).join('\n');
            return result === "" ? "Directory is empty." : result;
        } catch (error: any) {
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
                    if (file.isDirectory() && !res.includes('node_modules') && !res.includes('.git')) {
                        await walk(res);
                    } else if (file.isFile()) {
                        const content = await fs.promises.readFile(res, 'utf-8');
                        if (content.includes(query)) results.push(res);
                    }
                }
            }
            await walk(targetPath);
            return results.join('\n') || "No matches found.";
        } catch (error: any) {
            return `Error searching code: ${error.message}`;
        }
    }

    static async appendToTrace(text: string): Promise<void> {
        try {
            const tracePath = path.resolve(this.getWorkspaceRoot(), '.forge', 'execution_trace.log');
            await fs.promises.mkdir(path.dirname(tracePath), { recursive: true });
            await fs.promises.appendFile(tracePath, `${new Date().toISOString()} ${text}\n`, 'utf8');
        } catch (e) { }
    }
}

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------
const agentMeta: Record<string, { emoji: string; label: string }> = {
    workspace_analyzer: { emoji: '👁️', label: 'Workspace Analyzer' },
    orchestrator: { emoji: '🎯', label: 'Orchestrator' },
    pm_agent: { emoji: '📋', label: 'PM Agent' },
    recovery_agent: { emoji: '🚑', label: 'Recovery Agent' },
    tdd_coder: { emoji: '🧪', label: 'TDD Coder' }
};

function getAgentDisplay(agent: string) {
    return agentMeta[agent] ?? { emoji: '🤖', label: agent };
}

export function activate(context: vscode.ExtensionContext) {
    log('INFO', 'Forge extension activated.');

    const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
        const userPrompt = request.prompt;
        ForgeDashboard.createOrShow();
        ForgeDashboard.sendEvent({ type: 'pipeline_start', data: { prompt: userPrompt } });

        try {
            const forgeConfig = vscode.workspace.getConfiguration('forge');
            const location = forgeConfig.get<string>('location', 'us-central1');
            const endpointId: string | undefined = forgeConfig.get<string>('endpointId')?.trim();

            if (!endpointId) {
                throw new Error("Forge Endpoint ID not found in configuration.");
            }

            log('INFO', `Using Reasoning Engine: ${endpointId}`);

            const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
            const client = await auth.getClient();
            const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${endpointId}:query`;

            let currentAgent: string | null = "workspace_analyzer";
            let currentPrompt: string | null = userPrompt;
            let chatHistory: any[] = [];

            const normalizedPrompt = userPrompt.toLowerCase().trim();
            if (normalizedPrompt === "continue" || normalizedPrompt === "resume") {
                currentAgent = "recovery_agent";
                currentPrompt = "Examine .forge/execution_trace.log and restore the session.";
                await WorkspaceTools.appendToTrace(`--- SYSTEM RECOVERY INITIATED ---`);
            }

            let globalMaxIter = 50;
            while (currentAgent && globalMaxIter > 0) {
                if (token.isCancellationRequested) break;
                globalMaxIter--;

                ForgeDashboard.sendEvent({ type: 'agent_start', agent: currentAgent });
                const ad = getAgentDisplay(currentAgent);
                stream.progress(`${ad.emoji} [${ad.label}] Thinking...`);

                let isFinished = false;
                let turnIter = 10;
                let nextMessage: string | null = currentPrompt;

                while (!isFinished && turnIter > 0) {
                    turnIter--;

                    const requestData: any = {
                        agent_name: currentAgent,
                        chat_history: chatHistory
                    };

                    if (nextMessage) {
                        requestData.message = nextMessage;
                    }

                    const t0 = Date.now();
                    const turnResponse: any = await client.request({
                        url,
                        method: 'POST',
                        data: { input: requestData },
                        timeout: 120000
                    });

                    const currentResponse: any = (turnResponse.data as any).output;
                    logApiResponse(currentAgent, (50 - globalMaxIter), (10 - turnIter), currentResponse, Date.now() - t0);

                    // Update history with the model's response
                    if (currentResponse.raw_assistant_message) {
                        chatHistory.push(currentResponse.raw_assistant_message);
                    }

                    if (currentResponse.type === "text") {
                        const text: string = currentResponse.text || "";
                        await WorkspaceTools.appendToTrace(`[${currentAgent}] Output: ${text}`);

                        // Transition logic
                        if (currentAgent === "workspace_analyzer" || currentAgent === "recovery_agent") {
                            currentAgent = "orchestrator";
                            currentPrompt = `Workspace state report: ${text}`;
                        } else if (currentAgent === "orchestrator") {
                            try {
                                const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
                                const dagState = JSON.parse(jsonStr);
                                currentAgent = dagState.next_agent_routing !== "none" ? dagState.next_agent_routing : null;
                                currentPrompt = `Proceed with tasks: ${JSON.stringify(dagState.active_tasks)}`;
                            } catch (e) {
                                currentAgent = null; // Exit on parse error
                            }
                        } else {
                            currentAgent = "workspace_analyzer";
                            currentPrompt = `Verify work finished: ${text}`;
                        }

                        chatHistory = []; // Reset history for the next agent
                        isFinished = true;
                        ForgeDashboard.sendEvent({ type: 'agent_done', agent: currentAgent || 'done' });
                    }
                    else if (currentResponse.type === "function_calls") {
                        const toolResults: any[] = [];
                        for (const call of currentResponse.calls) {
                            await WorkspaceTools.appendToTrace(`[${currentAgent}] Tool: ${call.name}(${JSON.stringify(call.args)})`);
                            ForgeDashboard.sendEvent({ type: 'tool_call', agent: currentAgent, data: { name: call.name } });

                            let result = "";
                            if (call.name === "read_file") result = await WorkspaceTools.readFile(call.args.filepath);
                            else if (call.name === "create_artifact") result = await WorkspaceTools.createArtifact(call.args.filepath, call.args.content);
                            else if (call.name === "write_code") result = await WorkspaceTools.writeCode(call.args.filepath, call.args.content);
                            else if (call.name === "execute_command") result = await WorkspaceTools.executeCommand(call.args.command);
                            else if (call.name === "list_directory") result = await WorkspaceTools.listDirectory(call.args.path);
                            else if (call.name === "search_code") result = await WorkspaceTools.searchCode(call.args.query, call.args.directory);
                            else if (call.name === "update_task_status") result = await WorkspaceTools.updateTaskStatus(call.args.filepath, call.args.task_string, call.args.new_status);

                            toolResults.push({
                                functionResponse: {
                                    name: call.name,
                                    response: { content: result }
                                }
                            });
                            ForgeDashboard.sendEvent({ type: 'tool_result', agent: currentAgent, data: { name: call.name } });
                        }

                        // 🔥 CRITICAL FIX: Package responses as a user turn and continue the inner loop
                        const toolUserTurn = { role: "user", parts: toolResults };
                        chatHistory.push(toolUserTurn);
                        nextMessage = JSON.stringify(toolResults);
                    }
                }
            }

            ForgeDashboard.sendEvent({ type: 'pipeline_complete' });
            stream.markdown("\n\n--- \n*DAG Execution Complete.*");

        } catch (error: any) {
            ForgeDashboard.sendEvent({ type: 'error', data: { message: error.message } });
            stream.markdown(`**Forge Error:** ${error.message}`);
        }
        return { metadata: { command: '' } };
    };

    const chatApi = (vscode as any).chat;
    if (chatApi?.createChatParticipant) {
        context.subscriptions.push(chatApi.createChatParticipant("forge.chat", handler));
    }
}