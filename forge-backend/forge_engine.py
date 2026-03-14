import json
import os
import logging
import time

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import vertexai
from vertexai.generative_models import GenerativeModel, Tool, Part, FunctionDeclaration

# 🔥 NEW: Import the baked Python dictionary directly!
try:
    from agent_registry import AGENT_CONFIGS
except ImportError:
    AGENT_CONFIGS = {}

# ---------------------------------------------------------------------------
# Logging Setup
# ---------------------------------------------------------------------------
try:
    import google.cloud.logging as gcloud_logging
    from google.cloud.logging.handlers import CloudLoggingHandler

    _gcloud_client = gcloud_logging.Client(project="nastwest-u26wck-607")
    _cloud_handler = CloudLoggingHandler(_gcloud_client, name="forge_engine")
    _cloud_handler.setLevel(logging.DEBUG)
    _use_cloud_logging = True
except Exception as _e:
    _use_cloud_logging = False

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("forge_engine")
if _use_cloud_logging:
    logger.addHandler(_cloud_handler)

def clog(event: str, severity: str = "DEBUG", **fields):
    payload = {"event": event, **fields}
    print(f"[{severity}] {json.dumps(payload, default=str)}", flush=True)

# ---------------------------------------------------------------------------
# Function Declaration Schemas
# ---------------------------------------------------------------------------
FUNCTION_MAP = {
    "read_file": FunctionDeclaration(name="read_file", description="Reads a file.", parameters={"type": "object", "properties": {"filepath": {"type": "string"}}, "required": ["filepath"]}),
    # 🔥 NEW TOOL SCHEMA ADDED HERE:
    "tail_log": FunctionDeclaration(
        name="tail_log", 
        description="Reads the last N lines of a log file. Use this specifically for trace logs to avoid overloading context.", 
        parameters={
            "type": "object", 
            "properties": {
                "filepath": {"type": "string"},
                "lines": {"type": "integer", "description": "Number of lines to read from the bottom (default 100)"}
            }, 
            "required": ["filepath"]
        }
    ),
    "create_artifact": FunctionDeclaration(name="create_artifact", description="Creates a file.", parameters={"type": "object", "properties": {"filepath": {"type": "string"}, "content": {"type": "string"}}, "required": ["filepath", "content"]}),
    "write_code": FunctionDeclaration(name="write_code", description="Writes code.", parameters={"type": "object", "properties": {"filepath": {"type": "string"}, "content": {"type": "string"}}, "required": ["filepath", "content"]}),
    "execute_command": FunctionDeclaration(name="execute_command", description="Runs a terminal command.", parameters={"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}),
    "update_task_status": FunctionDeclaration(name="update_task_status", description="Updates task.", parameters={"type": "object", "properties": {"filepath": {"type": "string"}, "task_string": {"type": "string"}, "new_status": {"type": "string"}}, "required": ["filepath", "task_string", "new_status"]}),
    "list_directory": FunctionDeclaration(name="list_directory", description="Lists a dir.", parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
    "search_code": FunctionDeclaration(name="search_code", description="Searches code.", parameters={"type": "object", "properties": {"query": {"type": "string"}, "directory": {"type": "string"}}, "required": ["query", "directory"]}),
    "read_context": FunctionDeclaration(name="read_context", description="Reads context.", parameters={"type": "object", "properties": {}}),
    "update_context": FunctionDeclaration(name="update_context", description="Updates context.", parameters={"type": "object", "properties": {"updates": {"type": "object"}}, "required": ["updates"]}),
}

def _get_tools_for_agent(agent_config: dict) -> list:
    tool_names = agent_config.get("tools", [])
    if not tool_names: return None
    declarations = [FUNCTION_MAP[n] for n in tool_names if n in FUNCTION_MAP]
    return [Tool(function_declarations=declarations)] if declarations else None

# ---------------------------------------------------------------------------
# ForgeEngine
# ---------------------------------------------------------------------------
class ForgeEngine:
    def __init__(self):
        # Assign the baked dict directly. No file reading needed!
        self.configs = AGENT_CONFIGS
        self._initialized = False

    def _ensure_initialized(self):
        if self._initialized: return
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "nastwest-u26wck-607")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        vertexai.init(project=project, location=location)
        self._initialized = True

    def query(self, agent_name: str, prompt: str = None, context: str = None, message: str = None, chat_history: list = None) -> dict:
        self._ensure_initialized()
        if message is not None:
            return self._send_message_to_agent(agent_name, message, chat_history)
        return self._send_message_to_agent(agent_name, prompt, [])

    def _send_message_to_agent(self, agent_name: str, message: str, chat_history: list = None) -> dict:
        if agent_name not in self.configs:
            err = f"Error: Agent '{agent_name}' not found."
            return {"type": "text", "text": err, "raw_assistant_message": {"role": "model", "parts": [{"text": err}]}}

        config = self.configs[agent_name]
        model = GenerativeModel(config["model"], system_instruction=config["instructions"], tools=_get_tools_for_agent(config))

        import vertexai.generative_models as gm
        contents = []
        if chat_history:
            for msg in chat_history:
                parts = []
                for p in msg["parts"]:
                    if "text" in p: parts.append(Part.from_text(p["text"]))
                    elif "functionCall" in p: parts.append(Part.from_dict({"function_call": p["functionCall"]}))
                    elif "functionResponse" in p: parts.append(Part.from_function_response(name=p["functionResponse"]["name"], response=p["functionResponse"]["response"]))
                contents.append(gm.Content(role=msg["role"], parts=parts))

        try: parsed_msg = json.loads(message)
        except: parsed_msg = None

        if isinstance(parsed_msg, list) and parsed_msg and "functionResponse" in parsed_msg[0]:
            new_parts = [Part.from_function_response(name=p["functionResponse"]["name"], response=p["functionResponse"]["response"]) for p in parsed_msg]
            contents.append(gm.Content(role="user", parts=new_parts))
        else:
            contents.append(gm.Content(role="user", parts=[Part.from_text(message)]))

        response = model.generate_content(contents)
        
        fn_calls = []
        text = ""
        try:
            for p in response.candidates[0].content.parts:
                try: 
                    if p.function_call: fn_calls.append(p.function_call)
                except: 
                    try: text += p.text + "\n"
                    except: pass
        except: pass

        if fn_calls:
            calls = [{"name": c.name, "args": {k: v for k, v in c.args.items()}} for c in fn_calls]
            parts = [{"text": text.strip()}] if text.strip() else []
            for c in calls: parts.append({"functionCall": c})
            return {"type": "function_calls", "calls": calls, "text": text.strip(), "raw_assistant_message": {"role": "model", "parts": parts}}
        else:
            return {"type": "text", "text": text.strip(), "raw_assistant_message": {"role": "model", "parts": [{"text": text.strip()}]}}

# For Vertex Agent Engine
app = ForgeEngine()