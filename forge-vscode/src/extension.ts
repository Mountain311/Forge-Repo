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

function logApiRequest(url: string, data: any) {
    logSeparator('API REQUEST');
    log('DEBUG', `URL: ${url}`);
    log('DEBUG', 'Payload:', data);
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
        if (agent === 'orchestrator' && !response?.text?.trim()) {
            log('WARN', 'Orchestrator returned empty text response. See raw response summary above for part-level diagnostics.');
        }
    } else {
        log('WARN', 'Unexpected response shape:', response);
    }
}

function logAgentRouting(from: string | null, to: string | null, reason: string) {
    log('INFO', `ROUTING  ${from ?? 'START'} → ${to ?? 'DONE'}  (${reason})`);
    // 🔥 Dashboard Hook: Routing event
    ForgeDashboard.sendEvent({ type: 'routing', data: { from: from, to: to } });
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
            return content;
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
            } else {
                return `Task string not found in file.`;
            }
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
            return results.length > 0 ? results.slice(0, 100).join('\n') : "No matches found.";
        } catch (error: any) {
            return `Error searching code: ${error.message}`;
        }
    }

    // 🔥 NEW: Context Bus Handlers
    static async readContext(): Promise<string> {
        try {
            const contextPath = path.resolve(this.getWorkspaceRoot(), '.forge', 'context_bus.json');
            if (!fs.existsSync(contextPath)) {
                return "{}";
            }
            const content = await fs.promises.readFile(contextPath, 'utf8');
            return content;
        } catch (error: any) {
            return `Error reading context: ${error.message}`;
        }
    }

    static async updateContext(updates: any): Promise<string> {
        try {
            const forgeDir = path.resolve(this.getWorkspaceRoot(), '.forge');
            const contextPath = path.resolve(forgeDir, 'context_bus.json');

            await fs.promises.mkdir(forgeDir, { recursive: true });

            let currentContext = {};
            if (fs.existsSync(contextPath)) {
                const content = await fs.promises.readFile(contextPath, 'utf8');
                try {
                    currentContext = JSON.parse(content);
                } catch (e) {
                    log('WARN', 'Could not parse existing context_bus.json, starting fresh.');
                }
            }

            const updatesObj = typeof updates === 'string' ? JSON.parse(updates) : updates;
            const newContext = { ...currentContext, ...updatesObj };

            await fs.promises.writeFile(contextPath, JSON.stringify(newContext, null, 2), 'utf8');
            return `Successfully updated context bus.`;
        } catch (error: any) {
            return `Error updating context: ${error.message}`;
        }
    }

    // 🔥 NEW: Execution Trace Logger
    static async appendToTrace(text: string): Promise<void> {
        try {
            const tracePath = path.resolve(this.getWorkspaceRoot(), '.forge', 'execution_trace.log');
            await fs.promises.mkdir(path.dirname(tracePath), { recursive: true });
            await fs.promises.appendFile(tracePath, text + '\n', 'utf8');
        } catch (e) {
            // Silently fail if we can't write to the trace log
        }
    }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------
const agentMeta: Record<string, { emoji: string; label: string }> = {
    workspace_analyzer: { emoji: '👁️', label: 'Workspace Analyzer' },
    orchestrator: { emoji: '🎯', label: 'Orchestrator' },
    architecture: { emoji: '🏗️', label: 'Architecture Agent' },
    security: { emoji: '🛡️', label: 'Security Agent' },
    dependencies: { emoji: '📦', label: 'Dependency Agent' },
    tdd_coder: { emoji: '🧪', label: 'TDD Coder' },
    pm_agent: { emoji: '📋', label: 'PM Agent' },
    data_leakage: { emoji: '🔒', label: 'Data Leakage Agent' },
    ethics: { emoji: '⚖️', label: 'Ethics Agent' },
    review: { emoji: '✅', label: 'Review Agent' },
    recovery_agent: { emoji: '🚑', label: 'Recovery Agent' }
};

function getAgentDisplay(agent: string): { emoji: string; label: string } {
    return agentMeta[agent] ?? { emoji: '🤖', label: agent };
}

export function activate(context: vscode.ExtensionContext) {
    getLogger().show(true);
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

        // 🔥 Dashboard Hook: Open the dashboard and start the session
        ForgeDashboard.createOrShow();
        ForgeDashboard.sendEvent({ type: 'pipeline_start', data: { prompt: userPrompt } });

        logSeparator(`NEW REQUEST  "${userPrompt.slice(0, 80)}"`);

        try {
            const forgeConfig = vscode.workspace.getConfiguration('forge');
            const credentialsFile = forgeConfig.get<string>('credentialsFile')?.trim();
            const quotaProject = forgeConfig.get<string>('quotaProject')?.trim();
            const location = forgeConfig.get<string>('location', 'us-central1')?.trim() || 'us-central1';
            const endpointId = forgeConfig.get<string>('endpointId', 'projects/718442730167/locations/us-central1/reasoningEngines/7243950940183592960')?.trim()
                || 'projects/718442730167/locations/us-central1/reasoningEngines/7243950940183592960';
            const fastModeEnabled = forgeConfig.get<boolean>('fastMode', true);
            const maxOrchestratorRetries = Math.max(1, forgeConfig.get<number>('maxOrchestratorRetries', 2));
            const mvpDemoMode = forgeConfig.get<boolean>('mvpDemoMode', false);
            const mvpMaxTurnsPerAgent = Math.max(1, forgeConfig.get<number>('mvpMaxTurnsPerAgent', 4));

            const authOptions: any = { scopes: 'https://www.googleapis.com/auth/cloud-platform' };
            if (credentialsFile) authOptions.keyFilename = credentialsFile;
            if (quotaProject) authOptions.quotaProjectId = quotaProject;

            const auth = new GoogleAuth(authOptions);
            const client = await auth.getClient();
            const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${endpointId}:query`;

            let currentAgent: string | null = "workspace_analyzer";
            let currentPrompt: string | null = `Please analyze the current directory and Task_list.md and provide a state summary for the Orchestrator regarding this new user request: "${userPrompt}"`;

            // 🔥 NEW: Context Recovery Intercept
            const normalizedPrompt = userPrompt.toLowerCase().trim();
            if (normalizedPrompt === "continue" || normalizedPrompt.includes("resume")) {
                currentAgent = "recovery_agent";
                currentPrompt = `The system experienced an interruption. Read the execution trace log and the current workspace state to determine exactly where we left off. Provide a Warm Start Directive for the Orchestrator.`;
                await WorkspaceTools.appendToTrace(`\n--- SYSTEM RECOVERY INITIATED ---`);
            }

            let dagState: any = {};
            const globalExecutionLog: string[] = [];
            let orchestratorJsonParseFailures = 0;
            let missingTaskListDetected = false;
            let orchestratorEmptyTextStreak = 0;
            let taskListAvailable = false;
            let bootstrapFallbackUsed = false;
            let taskListAutoCreated = false;
            let pmAgentRunCount = 0;
            let forceTddMode = false;
            let orchestratorFailureCount = 0;
            const usedAgents = new Set<string>();
            const touchedFiles = new Set<string>();

            let globalMaxIter = 50;

            while (currentAgent && globalMaxIter > 0) {
                if (token.isCancellationRequested) break;
                globalMaxIter--;

                // 🔥 Dashboard Hook: Mark agent as running
                ForgeDashboard.sendEvent({ type: 'agent_start', agent: currentAgent });

                if (currentAgent) usedAgents.add(currentAgent);

                const requestData: any = {
                    agent_name: currentAgent,
                    prompt: currentPrompt,
                    context: selectedText
                };

                const agentDisplay = getAgentDisplay(currentAgent);
                stream.progress(`${agentDisplay.emoji} [${agentDisplay.label}] Initializing...`);

                const t0 = Date.now();
                let turnResponse = await client.request({
                    url: url,
                    method: 'POST',
                    data: { input: requestData },
                    timeout: 120000
                });

                let currentResponse = (turnResponse.data as any).output;
                logApiResponse(currentAgent, (50 - globalMaxIter), 0, currentResponse, Date.now() - t0);

                const chatHistory: any[] = [];
                let isFinished = false;
                let turnIter = 15;

                while (!isFinished && turnIter > 0) {
                    if (token.isCancellationRequested) break;
                    turnIter--;

                    chatHistory.push(currentResponse.raw_assistant_message);
                    let nextMessageContent: any;

                    if (currentResponse.type === "function_calls") {
                        const functionResponses: any[] = [];
                        const text = currentResponse.text || "";
                        const ad = getAgentDisplay(currentAgent!);

                        if (text) {
                            stream.markdown(`\n> ${ad.emoji} **${ad.label}** thought:\n> ${text.replace(/\n/g, '\n> ')}\n\n`);
                        }

                        stream.markdown(`\n> ⚙️ **${ad.label}** is executing tools:\n`);

                        for (const call of currentResponse.calls) {
                            const name = call.name;
                            const args = call.args;
                            let apiResponse = "";

                            // 🔥 Dashboard Hook: Tool Execution Started
                            ForgeDashboard.sendEvent({ type: 'tool_call', agent: currentAgent, data: { name: name } });

                            globalExecutionLog.push(`[${currentAgent}] Tool Call: ${name}`);
                            await WorkspaceTools.appendToTrace(`[${currentAgent}] Tool Call: ${name}(${JSON.stringify(args)})`);
                            stream.markdown(`> - \`${name}\`\n`);

                            try {
                                if (name === "read_file") {
                                    apiResponse = await WorkspaceTools.readFile(args.filepath);
                                    if (currentAgent === "orchestrator" && args.filepath === ".forge/Task_list.md") {
                                        taskListAvailable = !apiResponse.includes("ENOENT");
                                    }
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
                                } else if (name === "read_context") {
                                    apiResponse = await WorkspaceTools.readContext();
                                } else if (name === "update_context") {
                                    apiResponse = await WorkspaceTools.updateContext(args.updates);
                                } else {
                                    apiResponse = `Tool ${name} not implemented locally.`;
                                }
                            } catch (e: any) {
                                apiResponse = `Tool execution failed: ${e.message}`;
                            }

                            // 🔥 Dashboard Hook: Tool Execution Completed
                            ForgeDashboard.sendEvent({ type: 'tool_result', agent: currentAgent, data: { name: name } });

                            functionResponses.push({
                                functionResponse: { name: name, response: { content: apiResponse } }
                            });
                        }

                        stream.markdown(`\n`);
                        nextMessageContent = JSON.stringify(functionResponses);

                    } else {
                        // Text response block
                        const text = currentResponse.text || "";
                        globalExecutionLog.push(`[${currentAgent}] Agent Output: ${text}`);
                        await WorkspaceTools.appendToTrace(`[${currentAgent}] Agent Output: ${text}`);

                        // 🔥 Dashboard Hook: Mark agent as successfully done
                        ForgeDashboard.sendEvent({ type: 'agent_done', agent: currentAgent });

                        if (currentAgent === "workspace_analyzer" || currentAgent === "recovery_agent") {
                            logAgentRouting(currentAgent, "orchestrator", "analyzer/recovery finished");
                            currentAgent = "orchestrator";
                            currentPrompt = `Workspace State Report:\n${text}\n\nProvide the STRICT JSON routing response.`;
                            isFinished = true;
                            continue;
                        }
                        else if (currentAgent === "orchestrator") {
                            try {
                                const startIndex = text.indexOf('{');
                                const endIndex = text.lastIndexOf('}');
                                if (startIndex === -1 || endIndex === -1) throw new Error("No JSON found");

                                const jsonString = text.substring(startIndex, endIndex + 1);
                                dagState = JSON.parse(jsonString);

                                // 🔥 Dashboard Hook: Phase Update Detection
                                if (dagState.phase !== undefined) {
                                    ForgeDashboard.sendEvent({
                                        type: 'phase_update',
                                        data: { phase: dagState.phase, name: dagState.phase_name || "Executing" }
                                    });
                                }

                                if (dagState.message_to_user) {
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);
                                }

                                const nextRoute = dagState.next_agent_routing;
                                if (nextRoute && nextRoute !== "none" && nextRoute !== "null") {
                                    logAgentRouting(currentAgent, nextRoute, `DAG routing`);
                                    currentAgent = nextRoute;
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nDAG State:\n${JSON.stringify(dagState, null, 2)}\n\nBegin execution.`;
                                } else {
                                    logAgentRouting(currentAgent, null, `Done`);
                                    currentAgent = null;
                                }
                                isFinished = true;
                                continue;
                            } catch (e: any) {
                                nextMessageContent = "Your output failed to parse. You MUST output valid JSON.";
                            }
                        }
                        else {
                            stream.markdown(`${text}\n\n`);
                            logAgentRouting(currentAgent, "workspace_analyzer", "worker finished");
                            currentAgent = "workspace_analyzer";
                            currentPrompt = `The agent just finished its work and returned: "${text}".\n\nPlease analyze the current directory and Task_list.md and provide a state summary.`;
                            isFinished = true;
                            continue;
                        }
                    }

                    if (isFinished) break;

                    if (nextMessageContent) {
                        chatHistory.push({ role: "user", parts: [{ text: nextMessageContent }] });
                        const nextRequestData = { agent_name: currentAgent, message: nextMessageContent, chat_history: chatHistory };
                        turnResponse = await client.request({ url: url, method: 'POST', data: { input: nextRequestData }, timeout: 120000 });
                        currentResponse = (turnResponse.data as any).output;
                    }
                }
            }

            // 🔥 Dashboard Hook: Pipeline finished successfully
            ForgeDashboard.sendEvent({ type: 'pipeline_complete' });
            stream.markdown(`\n\n--- \n*DAG Execution Complete.*`);

        } catch (error: any) {
            // 🔥 Dashboard Hook: Error encountered
            ForgeDashboard.sendEvent({ type: 'error', data: { message: error?.message || 'Unknown error' } });
            stream.markdown(`\n\n**Forge Error:** ${error}`);
        }

        return { metadata: { command: '' } };
    };

    try {
        const chatApi = (vscode as any).chat;
        if (chatApi?.createChatParticipant) {
            const forgeChat = chatApi.createChatParticipant("forge.chat", handler);
            context.subscriptions.push(forgeChat);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Forge activation error: ${error?.message}`);
    }
}