from dotenv import load_dotenv
load_dotenv()

import yaml
import json
import os
from pathlib import Path
import vertexai
from vertexai.generative_models import GenerativeModel, Tool, Part, FunctionDeclaration
from tools import tool_map

# --- Function Declaration Schemas ---

# 1. Read File Schema
read_file_func = FunctionDeclaration(
    name="read_file",
    description="Reads the content of a file from the sandbox.",
    parameters={
        "type": "object",
        "properties": {"filepath": {"type": "string", "description": "The exact path to the file."}},
        "required": ["filepath"]
    }
)

# 2a. Create Artifact Schema
create_artifact_func = FunctionDeclaration(
    name="create_artifact",
    description="Creates or updates a planning artifact (e.g., .md files in the .forge/ directory).",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string", "description": "The exact path to the file (e.g., '.forge/Task_list.md')."},
            "content": {"type": "string", "description": "The full markdown content to write."}
        },
        "required": ["filepath", "content"]
    }
)

# 2b. Write Code Schema
write_code_func = FunctionDeclaration(
    name="write_code",
    description="Writes application code to a file in the workspace. Overwrites existing files.",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string", "description": "The exact path to the source code file (e.g., 'src/main.py')."},
            "content": {"type": "string", "description": "The full code snippet to write."}
        },
        "required": ["filepath", "content"]
    }
)

# 3. Execute Command Schema
execute_command_func = FunctionDeclaration(
    name="execute_command",
    description="Executes a bash command in the terminal (e.g., running pytest, node, etc.) and returns the output.",
    parameters={
        "type": "object",
        "properties": {"command": {"type": "string", "description": "The terminal command to run."}},
        "required": ["command"]
    }
)

# 4. Update Task Status Schema
update_task_status_func = FunctionDeclaration(
    name="update_task_status",
    description="Updates the checkbox status of a specific task in a markdown task list.",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string", "description": "The exact path to the file."},
            "task_string": {"type": "string", "description": "The exact task text string to search for in the markdown file."},
            "new_status": {"type": "string", "description": "The new status character to place in the brackets (e.g., 'x', ' ', '/')."}
        },
        "required": ["filepath", "task_string", "new_status"]
    }
)

# 5. List Directory Schema
list_directory_func = FunctionDeclaration(
    name="list_directory",
    description="Returns the contents (files and folders) of a specified directory.",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "The relative or absolute path of the directory to list (e.g., './src')."}
        },
        "required": ["path"]
    }
)

# 6. Search Code Schema
search_code_func = FunctionDeclaration(
    name="search_code",
    description="Searches all files in a directory for a specific text, class, or function name (like grep).",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The text pattern or keyword to search for."},
            "directory": {"type": "string", "description": "The directory to search within (e.g., './')."}
        },
        "required": ["query", "directory"]
    }
)

# Bind them into a Vertex AI Tool
forge_tools = Tool(function_declarations=[read_file_func, create_artifact_func, write_code_func, execute_command_func, update_task_status_func, list_directory_func, search_code_func])


class ForgeEngine:
    def __init__(self):
        self.configs = {}
        self._initialized = False

    def _ensure_initialized(self):
        """Lazy initialization — runs on first query, not at pickle time."""
        if self._initialized:
            return
        vertexai.init()
        # Resolve configs relative to this file's location (works locally and in cloud)
        config_dir = Path(__file__).parent / "agent_configs"
        if not config_dir.exists():
            # Fallback for cloud environment where extra_packages are extracted
            config_dir = Path("agent_configs")
        for file in config_dir.glob("*.yaml"):
            with open(file, "r") as f:
                self.configs[file.stem] = yaml.safe_load(f)
        self._initialized = True

    def query(self, prompt: str = None, context: str = "", message: str = None, chat_history: list = None, agent_name: str = "orchestrator") -> dict:
        """Entry point from VS Code. Multiplexes all agent tasks."""
        self._ensure_initialized()
        
        # If 'message' is present, this is a continuation of a specific agent's loop
        if message is not None:
            return self._send_message_to_agent(agent_name, message, chat_history)
        
        # Otherwise, this is a fresh start for the specified agent
        if agent_name == "orchestrator":
            initial_prompt = f"User Request: {prompt}\nCode Context:\n{context}\n\nPlease determine the next routing step. Use tools to read files if necessary."
        else:
            initial_prompt = prompt
            
        return self._send_message_to_agent(agent_name, initial_prompt, [])

    @staticmethod
    def _extract_function_calls(response):
        """Extract function calls from a GenerationResponse's parts."""
        calls = []
        try:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'function_call') and part.function_call.name:
                    calls.append(part.function_call)
        except (IndexError, AttributeError):
            pass
        return calls

    @staticmethod
    def _extract_text(response):
        """Extract text from a GenerationResponse's parts to avoid multiple-parts exception."""
        text = ""
        try:
            for part in response.candidates[0].content.parts:
                try:
                    if hasattr(part, 'function_call') and part.function_call.name:
                        continue
                    if hasattr(part, 'text') and part.text:
                        text += part.text + "\n"
                except AttributeError:
                    pass
        except IndexError:
            pass
        return text.strip()

    def _send_message_to_agent(self, agent_name: str, message: str, chat_history: list = None) -> dict:
        """
        Generic internal handler for any Agent.
        Returns the tool call requests to the client, and expects the client to call this method
        again via query() with the tool execution results.
        """
        self._ensure_initialized()
        
        if agent_name not in self.configs:
            return {"type": "text", "text": f"Error: Agent '{agent_name}' not found.", "raw_assistant_message": {"role": "model", "parts": [{"text": "Error"}]}}
            
        config = self.configs[agent_name]
        
        # Pass tools to ALL agents, assuming they all might need file ops
        # In a more advanced setup, you'd filter forge_tools by config["tools"]
        model = GenerativeModel(
            config["model"],
            system_instruction=config["instructions"],
            tools=[forge_tools]
        )
        
        # 1. Reconstruct chat session state
        history_parts = []
        if chat_history:
            for msg in chat_history:
                role = msg.get("role")
                
                # We have to parse the stringified parts back into objects for Vertex AI
                # This depends on how the VS Code extension serializes history.
                # For simplicity in this architecture, we will rely on Vertex AI's
                # ability to accept a list of 'Content' objects or raw dictionaries.
                # However, an easier approach is to have the VS Code extension manage
                # the *entire* message array and just use generate_content instead of start_chat.
        
        # Actually, since Vertex AI Reasoning Engines are stateless between API calls,
        # start_chat() with history is complex to serialize back and forth between TS and Python.
        # The standard approach for stateful Agent APIs is to use generate_content with
        # the full conversation history. Let's implement that.
        
        contents = []
        if chat_history:
            for msg in chat_history:
                role = msg["role"]
                # Convert the raw dictionaries from VS Code into Vertex AI Part objects
                parts = []
                for p in msg["parts"]:
                    if "text" in p:
                        parts.append(Part.from_text(p["text"]))
                    elif "functionCall" in p:
                        parts.append(Part.from_dict({"function_call": p["functionCall"]}))
                    elif "functionResponse" in p:
                        parts.append(Part.from_function_response(
                            name=p["functionResponse"]["name"],
                            response=p["functionResponse"]["response"]
                        ))
                
                import vertexai.generative_models as gm
                contents.append(gm.Content(role=role, parts=parts))
        
        # Create the new user message part
        # The VS Code extension will send either a text prompt or a list of functionResponse dicts
        try:
            # Check if message is a JSON representation of function responses
            parsed_msg = json.loads(message)
            if isinstance(parsed_msg, list) and len(parsed_msg) > 0 and "functionResponse" in parsed_msg[0]:
                new_parts = []
                for p in parsed_msg:
                     new_parts.append(Part.from_function_response(
                            name=p["functionResponse"]["name"],
                            response=p["functionResponse"]["response"]
                        ))
                import vertexai.generative_models as gm
                contents.append(gm.Content(role="user", parts=new_parts))
            else:
                import vertexai.generative_models as gm
                contents.append(gm.Content(role="user", parts=[Part.from_text(message)]))
        except json.JSONDecodeError:
            # It's a standard text prompt
            import vertexai.generative_models as gm
            contents.append(gm.Content(role="user", parts=[Part.from_text(message)]))

        # Generate the next response in the chain
        response = model.generate_content(contents)
        
        # Check if the model wants to call functions
        fn_calls = self._extract_function_calls(response)
        if fn_calls:
            # Return the function calls to VS Code to execute
            serialized_calls = []
            for call in fn_calls:
                serialized_calls.append({
                    "name": call.name,
                    "args": {k: v for k, v in call.args.items()}
                })
            
            return {
                "type": "function_calls",
                "calls": serialized_calls,
                "text": self._extract_text(response),
                # Return the model's message exactly as generated so VS Code can append it to history
                "raw_assistant_message": {
                    "role": "model",
                    "parts": [{"text": self._extract_text(response)}] + [{"functionCall": {"name": c.name, "args": {k: v for k, v in c.args.items()}}} for c in fn_calls]
                }
            }
        else:
            # The model is done and returning text
            text_response = self._extract_text(response)
            return {
                "type": "text",
                "text": text_response,
                "raw_assistant_message": {
                    "role": "model",
                    "parts": [{"text": text_response}]
                }
            }

# For Vertex Agent Engine
app = ForgeEngine()
