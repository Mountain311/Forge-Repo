import * as vscode from 'vscode';
import { GoogleAuth } from 'google-auth-library';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// --- Workspace Tools ---
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
            return fs.promises.readFile(fullPath, 'utf8');
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
            const lines = content.split('\n');
            let updated = false;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(taskString)) {
                    // Replace the markdown checkbox [ ], [x], or [/]
                    lines[i] = lines[i].replace(/\[[ x\/]\]/, `[${newStatus}]`);
                    updated = true;
                    break;
                }
            }
            
            if (updated) {
                await fs.promises.writeFile(fullPath, lines.join('\n'), 'utf8');
                return `Updated task status in ${filepath}`;
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
                        // Only text-based files
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
}

export function activate(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        stream: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const userPrompt = request.prompt;
        
        const editor = vscode.window.activeTextEditor;
        const selectedText = editor ? editor.document.getText(editor.selection) : "";

        try {
            const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
            const client = await auth.getClient();
            
            const projectId = "nastwest-u26wck-607";
            const location = "us-central1";
            const endpointId = "projects/718442730167/locations/us-central1/reasoningEngines/754686089607774208"; 
            
            const url = `https://${location}-aiplatform.googleapis.com/v1beta1/${endpointId}:query`;

            let currentAgent: string | null = "orchestrator";
            let currentPrompt: string | null = userPrompt;
            
            let dagState: any = {};
            const globalExecutionLog: string[] = [];
            
            let globalMaxIter = 50;
            while (currentAgent && globalMaxIter > 0) {
                if (token.isCancellationRequested) break;
                globalMaxIter--;
                
                const requestData: any = {
                    agent_name: currentAgent,
                    prompt: currentPrompt,
                    context: selectedText
                };
                
                stream.progress(`[${currentAgent}] Initializing...`);
                
                let turnResponse = await client.request({
                    url: url,
                    method: 'POST',
                    data: { input: requestData },
                    timeout: 120000 // 2 minutes
                });
                
                let currentResponse = (turnResponse.data as any).output;
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
                        
                        // Output the text directly to the chat stream if it's meant for the user before the tool calls
                        const text = currentResponse.text || "";
                        if (text) {
                             stream.markdown(`\n> 🧠 **${currentAgent}** thought:\n> ${text.replace(/\\n/g, '\\n> ')}\n\n`);
                        }
                        
                        stream.markdown(`\n> ⚙️ **${currentAgent}** is executing tools:\n`);

                        for (const call of currentResponse.calls) {
                            const name = call.name;
                            const args = call.args;
                            let apiResponse = "";
                            
                            globalExecutionLog.push(`[${currentAgent}] Tool Call: ${name}(${JSON.stringify(args)})`);
                            
                            // Let the user know exactly what tool is being called
                            stream.markdown(`> - \`${name}\`\n`);
                            
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
                                }
                            } catch (e: any) {
                                apiResponse = `Tool execution failed: ${e.message}`;
                            }
                            
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
                        
                        // Output the text directly to the chat stream if it's meant for the user.
                        if (currentAgent !== "orchestrator") {
                             // PM Agent or TDD Coder talking
                             stream.markdown(`${text}\n\n`);
                              
                             // Hand control BACK to the orchestrator to determine the next step
                             currentAgent = "orchestrator";
                             currentPrompt = `Agent just finished its work and returned this text: "${text}".\n\nPlease check .forge/Task_list.md and determine next routing step.`;
                             isFinished = true;
                             continue;
                        }
                        
                        if (currentAgent === "orchestrator") {
                            try {
                                const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
                                dagState = JSON.parse(cleaned);
                                
                                if (dagState.message_to_user) {
                                    stream.markdown(`**Orchestrator:** ${dagState.message_to_user}\n\n`);
                                }
                                
                                if (dagState.next_agent_routing && dagState.next_agent_routing !== "none" && dagState.next_agent_routing !== "null" && dagState.next_agent_routing !== null) {
                                    currentAgent = dagState.next_agent_routing;
                                    currentPrompt = `Original User Request: ${userPrompt}\n\nDAG State:\n${JSON.stringify(dagState, null, 2)}\n\nBegin execution.`;
                                } else {
                                    currentAgent = null; // We are completely done
                                }
                                isFinished = true;
                                continue; // Breaks inner loop
                            } catch (e) {
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
                        
                        let nextRequestData = {
                            agent_name: currentAgent,
                            message: nextMessageContent,
                            chat_history: chatHistory
                        };
                        
                        turnResponse = await client.request({
                            url: url,
                            method: 'POST',
                            data: { input: nextRequestData },
                            timeout: 120000 // 2 minutes
                        });
                        currentResponse = (turnResponse.data as any).output;
                    }
                }
                
                if (turnIter === 0) {
                     stream.markdown(`\n\n**System Error:** Agent hit maximum function call iterations and was halted to prevent an infinite loop.`);
                     currentAgent = null;
                }
            }
            
            if (globalMaxIter === 0) {
                 stream.markdown(`\n\n**System Error:** System hit maximum agent routing iterations and was halted.`);
            }
            
            stream.markdown(`\n\n--- \n*DAG Execution Complete.*`);
            
        } catch (error) {
            stream.markdown(`\n\n**Forge Error:** ${error}`);
        }
        
        return { metadata: { command: '' } };
    };

    const forgeChat = vscode.chat.createChatParticipant("forge.chat", handler);
    context.subscriptions.push(forgeChat);
}
