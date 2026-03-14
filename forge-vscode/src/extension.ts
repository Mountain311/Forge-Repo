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

    // 🔥 INJECTED TOOL: Tailing logs to prevent context window overflow
    static async tailLog(filepath: string, lines: number = 100): Promise<string> {
        try {
            const root = this.getWorkspaceRoot();
            const fullPath = path.isAbsolute(filepath) ? filepath : path.join(root, filepath);
            const content = await fs.promises.readFile(fullPath, 'utf8');

            const allLines = content.split('\n');
            if (allLines.length > lines) {
                const tail = allLines.slice(-lines).join('\n');
                log('DEBUG', `tailLog("${filepath}") → truncated to ${lines} lines`);
                return `... [SYSTEM: LOG TRUNCATED. SHOWING LAST ${lines} LINES] ...\n\n${tail}`;
            }
            log('DEBUG', `tailLog("${filepath}") → ${content.length} chars (no truncation)`);
            return content;
        } catch (error: any) {
            log('ERROR', `tailLog("${filepath}") failed:`, error.message);
            return `Error tailing log: ${error.message}`;
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
// Agent display metadata for richer UI feedback
const agentMeta: Record<string, { emoji: string; label: string }> = {
    orchestrator: { emoji: '🎯', label: 'Orchestrator' },
    architecture: { emoji: '🏗️', label: 'Architecture Agent' },
    security: { emoji: '🛡️', label: 'Security Agent' },
    dependencies: { emoji: '📦', label: 'Dependency Agent' },
    tdd_coder: { emoji: '🧪', label: 'TDD Coder' },
    pm_agent: { emoji: '📋', label: 'PM Agent' },
    data_leakage: { emoji: '🔒', label: 'Data Leakage Agent' },
    ethics: { emoji: '⚖️', label: 'Ethics Agent' },
    review: { emoji: '✅', label: 'Review Agent' },
    recovery_agent: { emoji: '🚑', label: 'Recovery Agent' },
    workspace_analyzer: { emoji: '👁️', label: 'Workspace Analyzer' },
};

function getAgentDisplay(agent: string): { emoji: string; label: string } {
    return agentMeta[agent] ?? { emoji: '🤖', label: agent };
}

export function activate(context: vscode.ExtensionContext) {

    // Ensure the output channel is created on activation so users can find it
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

        logSeparator(`NEW REQUEST  "${userPrompt.slice(0, 80)}"`);
        log('INFO', 'User prompt:', userPrompt);
        log('INFO', 'Selected context length:', selectedText.length);

        // Reveal the output channel so developers see logs immediately
        getLogger().show(true);

        try {
            const forgeConfig = vscode.workspace.getConfiguration('forge');
            const credentialsFile = forgeConfig.get<string>('credentialsFile')?.trim();
            const quotaProject = forgeConfig.get<string>('quotaProject')?.trim();
            const location = forgeConfig.get<string>('location', 'us-central1')?.trim() || 'us-central1';
            const endpointId = forgeConfig.get<string>('endpointId', 'projects/718442730167/locations/us-central1/reasoningEngines/1613747718528696320')?.trim()
                || 'projects/718442730167/locations/us-central1/reasoningEngines/1613747718528696320';
            const fastModeEnabled = forgeConfig.get<boolean>('fastMode', true);
            const maxOrchestratorRetries = Math.max(1, forgeConfig.get<number>('maxOrchestratorRetries', 2));
            const mvpDemoMode = forgeConfig.get<boolean>('mvpDemoMode', false);
            const mvpMaxTurnsPerAgent = Math.max(1, forgeConfig.get<number>('mvpMaxTurnsPerAgent', 4));

            const authOptions: any = {
                scopes: 'https://www.googleapis.com/auth/cloud-platform'
            };

            if (credentialsFile) {
                authOptions.keyFilename = credentialsFile;
                log('INFO', `Using custom credentials file from settings: ${credentialsFile}`);
            }
            if (quotaProject) {
                authOptions.quotaProjectId = quotaProject;
                log('INFO', `Using custom quota project from settings: ${quotaProject}`);
            }

            const auth = new GoogleAuth(authOptions);
            const client = await auth.getClient();

            log('INFO', `Using Vertex endpoint config: location=${location}, endpointId=${endpointId}`);
            const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${endpointId}:query`;

            let currentAgent: string | null = "workspace_analyzer";
            let currentPrompt: string | null = userPrompt;
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
            const skippedAgents = new Set<string>();
            const touchedFiles = new Set<string>();
            const mvpAgentSequence = [
                'orchestrator',
                'pm_agent',
                'architecture',
                'security',
                'dependencies',
                'tdd_coder',
                'data_leakage',
                'ethics',
                'review',
            ];
            const mvpExecutionStatus = new Map<string, 'remote' | 'local-fallback' | 'skipped' | 'not-run'>();
            let mvpSequenceIndex = -1;

            const normalizedPrompt = userPrompt.toLowerCase().trim();
            if (normalizedPrompt === "continue" || normalizedPrompt === "resume") {
                currentAgent = "recovery_agent";
                currentPrompt = "Examine .forge/execution_trace.log and restore the session.";
            }

            const buildMvpPrompt = (agent: string) => {
                if (agent === 'orchestrator') {
                    return `MVP DEMO MODE is enabled. User request: ${userPrompt}\n\nYou are orchestrator. Keep output short and valid. In demo mode, summarize current state in strict JSON and keep routing minimal.`;
                }

                return `MVP DEMO MODE is enabled. User request: ${userPrompt}\n\nYou are ${agent}. Do only 1-2 high-impact, minimal actions to demonstrate your role. Keep responses concise and avoid deep iteration. If tools are needed, use at most 2 tool calls, then finish.`;
            };

            const localMvpAgentArtifacts: Record<string, { filepath: string; content: string }> = {
                pm_agent: {
                    filepath: '.forge/Task_list.md',
                    content: `# Task List\n\n- [ ] MVP scope for: ${userPrompt}\n- [ ] Build minimal implementation\n- [ ] Run quick validation\n- [ ] Prepare demo summary`,
                },
                architecture: {
                    filepath: '.forge/Architecture_Spec.md',
                    content: `# Architecture Spec\n\n## MVP Architecture\n- Single lightweight app focused on: ${userPrompt}\n- Minimal file structure and direct implementation path\n- Demo-oriented architecture for fast delivery`,
                },
                security: {
                    filepath: '.forge/Security_PreCheck.md',
                    content: `# Security Pre-Check\n\n## MVP Findings\n- No secrets should be hardcoded\n- Validate user inputs where relevant\n- Keep dependencies minimal for the demo`,
                },
                dependencies: {
                    filepath: '.forge/Dependency_Manifest.md',
                    content: `# Dependency Manifest\n\n## MVP Recommendation\n- Prefer standard library / zero-dependency approach where possible\n- Add only essential dependencies needed for the demo`,
                },
                tdd_coder: {
                    filepath: '.forge/MVP_Code_Summary.md',
                    content: `# MVP Code Summary\n\n## TDD Coder Demo Output\n- Implemented minimal core behavior for demo\n- Added basic validation and happy-path handling\n- Kept solution concise for walkthrough`,
                },
                data_leakage: {
                    filepath: '.forge/Data_Leakage_Report.md',
                    content: `# Data Leakage Report\n\n## MVP Review\n- No sensitive data processing intended\n- Avoid logging secrets or personal data\n- Safe for demo usage`,
                },
                ethics: {
                    filepath: '.forge/Ethics_Report.md',
                    content: `# Ethics Report\n\n## MVP Review\n- Low-risk feature scope\n- Clear user-facing behavior\n- No high-impact decision making`,
                },
                review: {
                    filepath: '.forge/Quality_Report.md',
                    content: `# Quality Report\n\n## MVP Outcome\n- Lightweight multi-agent demo completed\n- Core artifacts generated\n- Ready for walkthrough/demo presentation`,
                },
            };

            const runLocalMvpAgent = async (agent: string): Promise<boolean> => {
                const artifact = localMvpAgentArtifacts[agent];
                if (!mvpDemoMode || !artifact) return false;

                const agentDisplay = getAgentDisplay(agent);
                log('INFO', `Running local MVP stub for agent: ${agent}`);
                stream.markdown(`\n> ${agentDisplay.emoji} **${agentDisplay.label}** (local MVP stub)\n\n`);

                const result = await WorkspaceTools.createArtifact(artifact.filepath, artifact.content);
                touchedFiles.add(artifact.filepath);
                globalExecutionLog.push(`[${agent}] Local MVP Artifact: ${artifact.filepath}`);
                mvpExecutionStatus.set(agent, 'local-fallback');

                if (result.startsWith('Error')) {
                    log('ERROR', `Local MVP stub failed for ${agent}:`, result);
                    stream.markdown(`> ⚠️ ${agentDisplay.label} local MVP step failed: ${result}\n\n`);
                } else {
                    stream.markdown(`> Created ${artifact.filepath} for demo.\n\n`);
                }

                routeToNextMvpAgent(agent, 'local MVP stub completed');
                return true;
            };

            const routeToNextMvpAgent = (fromAgent: string, reason: string): boolean => {
                if (!mvpDemoMode) return false;
                const nextIndex = mvpSequenceIndex + 1;
                if (nextIndex >= mvpAgentSequence.length) {
                    logAgentRouting(fromAgent, null, `MVP demo sequence complete (${reason})`);
                    stream.markdown(`\n\n**MVP Demo:** Agent walkthrough complete.`);
                    currentAgent = null;
                    return true;
                }

                const nextAgent = mvpAgentSequence[nextIndex];
                mvpSequenceIndex = nextIndex;
                logAgentRouting(fromAgent, nextAgent, `MVP demo mode: ${reason}`);
                stream.markdown(`\n\n**MVP Demo:** Routing to ${nextAgent} (${mvpSequenceIndex + 1}/${mvpAgentSequence.length}).`);
                currentAgent = nextAgent;
                currentPrompt = buildMvpPrompt(nextAgent);
                return true;
            };

            if (mvpDemoMode) {
                log('WARN', 'MVP demo mode enabled: using deterministic lightweight multi-agent sequence.');
                stream.markdown(`\n\n**MVP Demo Mode Enabled:** Running a lightweight multi-agent walkthrough.`);
                for (const agent of mvpAgentSequence) {
                    mvpExecutionStatus.set(agent, 'not-run');
                }
                currentAgent = mvpAgentSequence[0];
                mvpSequenceIndex = 0;
                currentPrompt = buildMvpPrompt(currentAgent);
            }

            let globalMaxIter = 50;
            log('INFO', `Starting agent loop. globalMaxIter=${globalMaxIter}`);

            while (currentAgent && globalMaxIter > 0) {
                if (token.isCancellationRequested) {
                    log('WARN', 'Cancellation requested — breaking outer loop');
                    break;
                }

                globalMaxIter--;
                const globalIterNum = 50 - globalMaxIter;

                if (currentAgent === "pm_agent") {
                    pmAgentRunCount++;
                    if (pmAgentRunCount > 2 && taskListAvailable) {
                        log('WARN', 'pm_agent run cap reached with task list available; forcing handoff to tdd_coder to prevent loop.');
                        logAgentRouting('pm_agent', 'tdd_coder', 'pm_agent run cap reached');
                        currentAgent = 'tdd_coder';
                        currentPrompt = `Original User Request: ${userPrompt}\n\nTask list exists. Continue implementation using TDD from .forge/Task_list.md.`;
                    }
                }

                if (currentAgent) {
                    usedAgents.add(currentAgent);
                }

                log('INFO', `--- OUTER LOOP iter=${globalIterNum} agent="${currentAgent}" globalRemaining=${globalMaxIter} ---`);

                const requestData: any = {
                    agent_name: currentAgent,
                    prompt: currentPrompt,
                    context: selectedText
                };

                logApiRequest(url, requestData);
                const agentDisplay = getAgentDisplay(currentAgent);
                stream.progress(`${agentDisplay.emoji} [${agentDisplay.label}] Initializing...`);

                const t0 = Date.now();
                let turnResponse = await client.request({
                    url: url,
                    method: 'POST',
                    data: { input: requestData },
                    timeout: 120000
                });
                const initDuration = Date.now() - t0;

                let currentResponse = (turnResponse.data as any).output;
                if (mvpDemoMode && currentAgent && mvpExecutionStatus.get(currentAgent) === 'not-run') {
                    mvpExecutionStatus.set(currentAgent, 'remote');
                }
                logApiResponse(currentAgent, globalIterNum, 0, currentResponse, initDuration);

                const chatHistory: any[] = [];
                let isFinished = false;
                let turnIter = mvpDemoMode
                    ? (currentAgent === 'orchestrator' ? 3 : mvpMaxTurnsPerAgent)
                    : ((fastModeEnabled && currentAgent === "orchestrator") ? 6 : 15);

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
                        const ad = getAgentDisplay(currentAgent!);
                        if (text) {
                            stream.markdown(`\n> ${ad.emoji} **${ad.label}** thought:\n> ${text.replace(/\n/g, '\n> ')}\n\n`);
                        }

                        stream.markdown(`\n> ⚙️ **${ad.label}** is executing tools:\n`);
                        log('INFO', `  Executing ${currentResponse.calls.length} tool call(s)`);

                        for (const call of currentResponse.calls) {
                            const name = call.name;
                            const args = call.args;
                            let apiResponse = "";

                            if (typeof args?.filepath === 'string') touchedFiles.add(args.filepath);
                            if (typeof args?.path === 'string') touchedFiles.add(args.path);

                            globalExecutionLog.push(`[${currentAgent}] Tool Call: ${name}(${JSON.stringify(args)})`);
                            log('DEBUG', `  Tool → ${name}`, args);
                            stream.markdown(`> - \`${name}\`\n`);

                            const toolStart = Date.now();
                            try {
                                if (name === "read_file") {
                                    apiResponse = await WorkspaceTools.readFile(args.filepath);
                                    if (
                                        currentAgent === "orchestrator" &&
                                        args.filepath === ".forge/Task_list.md"
                                    ) {
                                        if (apiResponse.includes("ENOENT")) {
                                            missingTaskListDetected = true;
                                            taskListAvailable = false;
                                            log('WARN', 'Detected missing .forge/Task_list.md during orchestrator bootstrap.');

                                            if (!taskListAutoCreated) {
                                                const minimalTaskList = `# Task List\n\n- [ ] Clarify scope for: ${userPrompt}\n- [ ] Set up initial project structure\n- [ ] Implement core functionality\n- [ ] Add basic error handling\n- [ ] Validate output and finalize`;
                                                const createResult = await WorkspaceTools.createArtifact('.forge/Task_list.md', minimalTaskList);
                                                if (!createResult.startsWith('Error')) {
                                                    taskListAutoCreated = true;
                                                    missingTaskListDetected = false;
                                                    taskListAvailable = true;
                                                    apiResponse = minimalTaskList;
                                                    log('INFO', 'Auto-created minimal .forge/Task_list.md and returned it to orchestrator.');
                                                } else {
                                                    log('ERROR', 'Failed to auto-create .forge/Task_list.md:', createResult);
                                                }
                                            }
                                        } else {
                                            missingTaskListDetected = false;
                                            taskListAvailable = true;
                                            log('INFO', 'Detected available .forge/Task_list.md for orchestrator routing.');
                                        }
                                    }
                                } else if (name === "tail_log") {
                                    // 🔥 INJECTED ROUTING HERE
                                    apiResponse = await WorkspaceTools.tailLog(args.filepath, args.lines || 100);
                                } else if (name === "create_artifact") {
                                    apiResponse = await WorkspaceTools.createArtifact(args.filepath, args.content);
                                    if (args.filepath === ".forge/Task_list.md" && !apiResponse.startsWith('Error')) {
                                        taskListAvailable = true;
                                        missingTaskListDetected = false;
                                        log('INFO', 'Task list artifact created; marking task list as available.');
                                    }
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
                            const agentMissingMatch = text.match(/^Error: Agent '([^']+)' not found\.$/);

                            if (agentMissingMatch) {
                                const missingAgent = agentMissingMatch[1];
                                log('WARN', `Remote endpoint does not have agent config for "${missingAgent}".`);

                                if (mvpDemoMode) {
                                    stream.markdown(`\n> ⚠️ **${getAgentDisplay(missingAgent).label}** unavailable on this endpoint. Using local demo fallback.\n\n`);
                                    const stubbed = await runLocalMvpAgent(currentAgent!);
                                    if (!stubbed) {
                                        mvpExecutionStatus.set(missingAgent, 'skipped');
                                        skippedAgents.add(missingAgent);
                                        stream.markdown(`\n> ⚠️ **${getAgentDisplay(missingAgent).label}** has no local demo fallback. Skipping.\n\n`);
                                        routeToNextMvpAgent(currentAgent!, 'agent unavailable on remote endpoint');
                                    }
                                    isFinished = true;
                                    continue;
                                }

                                skippedAgents.add(missingAgent);
                                stream.markdown(`\n> ⚠️ **${getAgentDisplay(missingAgent).label}** unavailable on this endpoint.\n\n`);
                            } else {
                                stream.markdown(`${text}\n\n`);
                            }

                            if (mvpDemoMode) {
                                routeToNextMvpAgent(currentAgent!, 'agent finished');
                                isFinished = true;
                                continue;
                            }

                            if (currentAgent === 'pm_agent' && !text.trim() && taskListAvailable) {
                                log('WARN', 'pm_agent returned empty text after task-list creation; routing directly to tdd_coder.');
                                logAgentRouting('pm_agent', 'tdd_coder', 'pm_agent empty text with task list available');
                                currentAgent = 'tdd_coder';
                                currentPrompt = `Original User Request: ${userPrompt}\n\nTask list exists. Continue implementation using TDD from .forge/Task_list.md. In this turn, execute up to 3 related actions before returning.`;
                                forceTddMode = true;
                                isFinished = true;
                                continue;
                            }

                            if (fastModeEnabled && currentAgent === 'tdd_coder' && forceTddMode) {
                                const taskListSnapshot = await WorkspaceTools.readFile('.forge/Task_list.md');
                                const hasUncheckedTasks = /- \[ \]/.test(taskListSnapshot);
                                if (hasUncheckedTasks) {
                                    log('INFO', 'Fast mode active: keeping routing on tdd_coder while unchecked tasks remain.');
                                    logAgentRouting('tdd_coder', 'tdd_coder', 'fast mode sticky routing until task list completion');
                                    currentAgent = 'tdd_coder';
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nContinue implementing unchecked tasks from .forge/Task_list.md. Execute up to 3 related actions before returning.`;
                                    isFinished = true;
                                    continue;
                                }

                                log('INFO', 'Fast mode: all tasks appear completed, returning to orchestrator for final routing.');
                                forceTddMode = false;
                            }

                            logAgentRouting(currentAgent, "orchestrator", "agent finished, returning to orchestrator");
                            currentAgent = "orchestrator";
                            currentPrompt = `Agent just finished its work and returned this text: "${text}".\n\nPlease check .forge/Task_list.md and determine next routing step.`;
                            isFinished = true;
                            continue;
                        }

                        if (currentAgent === "orchestrator") {
                            if (!text.trim()) {
                                orchestratorEmptyTextStreak++;
                            } else {
                                orchestratorEmptyTextStreak = 0;
                            }

                            try {
                                const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
                                log('DEBUG', 'Parsing orchestrator JSON:', cleaned.slice(0, 500));
                                dagState = JSON.parse(cleaned);
                                orchestratorJsonParseFailures = 0;
                                orchestratorEmptyTextStreak = 0;
                                orchestratorFailureCount = 0;

                                log('INFO', 'DAG State:', dagState);

                                if (mvpDemoMode) {
                                    stream.markdown(`**Orchestrator:** Demo checkpoint complete. Continuing deterministic agent walkthrough.\n\n`);
                                    routeToNextMvpAgent(currentAgent!, 'orchestrator checkpoint complete');
                                    isFinished = true;
                                    continue;
                                }

                                // Show phase indicator if available
                                if (dagState.phase_name) {
                                    stream.markdown(`\n---\n### 🎯 Phase ${dagState.phase}: ${dagState.phase_name} (Step ${dagState.pipeline_step ?? '?'})\n\n`);
                                }
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
                                orchestratorJsonParseFailures++;
                                orchestratorFailureCount++;

                                if (mvpDemoMode && currentAgent === 'orchestrator') {
                                    stream.markdown(`**Orchestrator:** Demo fallback engaged. Continuing deterministic walkthrough.\n\n`);
                                    routeToNextMvpAgent(currentAgent, 'orchestrator non-JSON response in demo mode');
                                    isFinished = true;
                                    continue;
                                }

                                if (
                                    !bootstrapFallbackUsed &&
                                    (
                                        (missingTaskListDetected && orchestratorJsonParseFailures >= 2) ||
                                        (orchestratorEmptyTextStreak >= 3 && !taskListAvailable)
                                    )
                                ) {
                                    log('WARN', 'Applying fallback DAG bootstrap: routing to pm_agent due to missing Task_list and repeated empty orchestrator output.');
                                    bootstrapFallbackUsed = true;
                                    dagState = {
                                        phase: 1,
                                        phase_name: 'Plan',
                                        pipeline_step: 1,
                                        active_tasks: ['Create planning artifacts for new project'],
                                        completed_tasks: [],
                                        next_agent_routing: 'pm_agent',
                                        message_to_user: 'Detected a fresh workspace. Bootstrapping pipeline via PM agent.',
                                        context_for_next_agent: `User wants to build: ${userPrompt}`
                                    };

                                    stream.markdown(`\n---\n### 🎯 Phase ${dagState.phase}: ${dagState.phase_name} (Step ${dagState.pipeline_step})\n\n`);
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);

                                    logAgentRouting(currentAgent, 'pm_agent', 'fallback bootstrap for missing Task_list');
                                    currentAgent = 'pm_agent';
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nDAG State:\n${JSON.stringify(dagState, null, 2)}\n\nBegin execution.`;
                                    isFinished = true;
                                    continue;
                                }

                                if (fastModeEnabled && taskListAvailable && orchestratorFailureCount >= maxOrchestratorRetries) {
                                    log('WARN', `Fast mode fallback: orchestrator failed ${orchestratorFailureCount} time(s), switching to sticky tdd_coder mode.`);
                                    dagState = {
                                        phase: 2,
                                        phase_name: 'Build',
                                        pipeline_step: 6,
                                        active_tasks: ['Implement unchecked tasks from .forge/Task_list.md'],
                                        completed_tasks: [],
                                        next_agent_routing: 'tdd_coder',
                                        message_to_user: 'Orchestrator is unstable. Fast mode is continuing directly with TDD Coder.',
                                        context_for_next_agent: `User wants to build: ${userPrompt}`
                                    };

                                    stream.markdown(`\n---\n### 🎯 Phase ${dagState.phase}: ${dagState.phase_name} (Step ${dagState.pipeline_step})\n\n`);
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);

                                    logAgentRouting(currentAgent, 'tdd_coder', 'fast mode fallback after repeated orchestrator empty responses');
                                    currentAgent = 'tdd_coder';
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nContinue implementing unchecked tasks from .forge/Task_list.md. Execute up to 3 related actions before returning.`;
                                    forceTddMode = true;
                                    isFinished = true;
                                    continue;
                                }

                                if (taskListAvailable && orchestratorJsonParseFailures >= 2) {
                                    log('WARN', 'Applying fallback DAG route: routing to tdd_coder because Task_list exists but orchestrator keeps returning empty output.');
                                    dagState = {
                                        phase: 2,
                                        phase_name: 'Build',
                                        pipeline_step: 6,
                                        active_tasks: ['Implement unchecked tasks from .forge/Task_list.md'],
                                        completed_tasks: [],
                                        next_agent_routing: 'tdd_coder',
                                        message_to_user: 'Task list found. Proceeding directly to implementation via TDD Coder due to orchestrator empty response.',
                                        context_for_next_agent: `User wants to build: ${userPrompt}`
                                    };

                                    stream.markdown(`\n---\n### 🎯 Phase ${dagState.phase}: ${dagState.phase_name} (Step ${dagState.pipeline_step})\n\n`);
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);

                                    logAgentRouting(currentAgent, 'tdd_coder', 'fallback when task list exists and orchestrator returns empty text');
                                    currentAgent = 'tdd_coder';
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nDAG State:\n${JSON.stringify(dagState, null, 2)}\n\nBegin execution and execute up to 3 related actions before returning.`;
                                    forceTddMode = true;
                                    isFinished = true;
                                    continue;
                                }

                                nextMessageContent = "Please output the DAG state as valid strict JSON only. Return a non-empty JSON object following the required schema.";
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
                    if (mvpDemoMode && currentAgent && currentAgent !== 'orchestrator') {
                        log('WARN', `MVP demo mode: ${currentAgent} reached turn checkpoint; routing to next demo agent.`);
                        stream.markdown(`\n\n**MVP Demo:** ${currentAgent} reached turn checkpoint; moving to next agent.`);
                        const stubbed = await runLocalMvpAgent(currentAgent);
                        if (!stubbed) {
                            routeToNextMvpAgent(currentAgent, 'turn checkpoint reached');
                        }
                        continue;
                    }

                    if (mvpDemoMode && currentAgent === 'orchestrator') {
                        log('WARN', 'MVP demo mode: orchestrator reached turn checkpoint; routing to next demo agent.');
                        stream.markdown(`\n\n**MVP Demo:** Orchestrator reached turn checkpoint; moving to next agent.`);
                        routeToNextMvpAgent(currentAgent, 'orchestrator turn checkpoint reached');
                        continue;
                    }

                    if (fastModeEnabled && currentAgent === 'tdd_coder' && taskListAvailable) {
                        log('WARN', 'tdd_coder hit inner iteration limit; checkpointing and continuing in next outer cycle (fast mode).');
                        stream.markdown(`\n\n**Fast Mode:** TDD coder reached turn checkpoint; continuing in the next cycle.`);
                        currentAgent = 'tdd_coder';
                        currentPrompt = `Original User Request: ${userPrompt}\n\nContinue implementing remaining unchecked tasks from .forge/Task_list.md. Execute up to 3 related actions before returning.`;
                        continue;
                    }

                    if (fastModeEnabled && currentAgent === 'orchestrator' && taskListAvailable) {
                        log('WARN', 'orchestrator hit inner iteration limit with task list available; redirecting to tdd_coder (fast mode).');
                        stream.markdown(`\n\n**Fast Mode:** Orchestrator stalled; switching to TDD coder.`);
                        currentAgent = 'tdd_coder';
                        currentPrompt = `Original User Request: ${userPrompt}\n\nContinue implementing remaining unchecked tasks from .forge/Task_list.md. Execute up to 3 related actions before returning.`;
                        forceTddMode = true;
                        continue;
                    }

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
            const usedAgentList = Array.from(usedAgents);
            const skippedAgentList = Array.from(skippedAgents);
            const touchedFileList = Array.from(touchedFiles).filter(Boolean);

            if (mvpDemoMode) {
                stream.markdown(`\n\n## MVP Demo Summary\n`);
                stream.markdown(`- **Agents used:** ${usedAgentList.length ? usedAgentList.join(', ') : 'none'}\n`);
                stream.markdown(`- **Agents skipped:** ${skippedAgentList.length ? skippedAgentList.join(', ') : 'none'}\n`);
                stream.markdown(`- **Files touched:** ${touchedFileList.length ? touchedFileList.join(', ') : 'none'}\n`);
                stream.markdown(`- **Execution trace:**\n`);
                for (const agent of mvpAgentSequence) {
                    const status = mvpExecutionStatus.get(agent) ?? 'not-run';
                    const badge = status === 'remote'
                        ? '🟢 remote'
                        : status === 'local-fallback'
                            ? '🟡 local fallback'
                            : status === 'skipped'
                                ? '🔴 skipped'
                                : '⚪ not run';
                    stream.markdown(`  - ${agent}: ${badge}\n`);
                }
            }
            stream.markdown(`\n\n--- \n*DAG Execution Complete.*`);

        } catch (error: any) {
            log('ERROR', 'Unhandled error in handler:', error?.message ?? error);
            log('ERROR', 'Stack:', error?.stack ?? '(no stack)');
            stream.markdown(`\n\n**Forge Error:** ${error}`);
        }

        return { metadata: { command: '' } };
    };

    try {
        const chatApi = (vscode as any).chat;
        if (chatApi?.createChatParticipant) {
            const forgeChat = chatApi.createChatParticipant("forge.chat", handler);
            context.subscriptions.push(forgeChat);
            log('INFO', 'Registered chat participant: forge.chat');
        } else {
            log('WARN', 'VS Code Chat API is unavailable in this host. forge.chat participant was not registered.');
            vscode.window.showWarningMessage('Forge: VS Code Chat API is unavailable in this window. Use a VS Code version with Chat support.');
        }
    } catch (error: any) {
        log('ERROR', 'Failed to register forge.chat participant:', error?.message ?? error);
        log('ERROR', 'Stack:', error?.stack ?? '(no stack)');
        vscode.window.showErrorMessage(`Forge activation warning: ${error?.message ?? error}`);
    }
}