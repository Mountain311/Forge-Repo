from dotenv import load_dotenv
load_dotenv()

import yaml
import json
import os
import logging
import time
from pathlib import Path
import vertexai
from vertexai.generative_models import GenerativeModel, Tool, Part, FunctionDeclaration
from tools import tool_map

# ---------------------------------------------------------------------------
# Logging Setup — writes structured JSON directly to Google Cloud Logging
# so you can query it in the Cloud Console Logs Explorer.
#
# Filter in Logs Explorer:
#   logName="projects/nastwest-u26wck-607/logs/forge_engine"
#
# To see only request/response payloads:
#   logName="projects/nastwest-u26wck-607/logs/forge_engine"
#   jsonPayload.event=~"REQUEST|RESPONSE"
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
    print(f"[forge_engine] WARNING: google-cloud-logging unavailable ({_e}), falling back to stderr")

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
logger = logging.getLogger("forge_engine")
logger.setLevel(logging.DEBUG)

if _use_cloud_logging:
    logger.addHandler(_cloud_handler)

# Structured log helper — writes a JSON payload so fields are queryable
# in Logs Explorer (e.g. jsonPayload.agent, jsonPayload.event)
_gcloud_logger = _gcloud_client.logger("forge_engine") if _use_cloud_logging else None

def clog(event: str, severity: str = "DEBUG", **fields):
    """Write a structured log entry visible in Cloud Logging Logs Explorer."""
    payload = {"event": event, **fields}
    if _gcloud_logger:
        _gcloud_logger.log_struct(payload, severity=severity)
    # Always also print to stderr as a fallback
    print(f"[{severity}] {json.dumps(payload, default=str)}", flush=True)

clog("ENGINE_INIT", severity="INFO", message="Forge Engine logging initialised")


def _truncate(value: any, max_chars: int = 400) -> str:
    """Return a safely truncated string representation of any value."""
    s = value if isinstance(value, str) else json.dumps(value, default=str)
    return s[:max_chars] + ("…" if len(s) > max_chars else "")


def _serialise_contents(contents: list) -> list:
    """Convert Vertex AI Content objects into plain dicts for structured logging."""
    result = []
    for c in contents:
        parts = []
        for p in c.parts:
            try:
                if hasattr(p, 'function_call') and p.function_call.name:
                    parts.append({
                        "type": "function_call",
                        "name": p.function_call.name,
                        "args": {k: v for k, v in p.function_call.args.items()}
                    })
                elif hasattr(p, 'text') and p.text:
                    parts.append({"type": "text", "text": p.text})
                else:
                    parts.append({"type": "unknown"})
            except Exception:
                parts.append({"type": "unreadable"})
        result.append({"role": c.role, "parts": parts})
    return result


# ---------------------------------------------------------------------------
# Function Declaration Schemas
# ---------------------------------------------------------------------------

read_file_func = FunctionDeclaration(
    name="read_file",
    description="Reads the content of a file from the sandbox.",
    parameters={
        "type": "object",
        "properties": {"filepath": {"type": "string", "description": "The exact path to the file."}},
        "required": ["filepath"]
    }
)

create_artifact_func = FunctionDeclaration(
    name="create_artifact",
    description="Creates or updates a planning artifact (e.g., .md files in the .forge/ directory).",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string", "description": "The exact path to the file."},
            "content": {"type": "string", "description": "The full markdown content to write."}
        },
        "required": ["filepath", "content"]
    }
)

write_code_func = FunctionDeclaration(
    name="write_code",
    description="Writes application code to a file in the workspace.",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string", "description": "The exact path to the source code file."},
            "content": {"type": "string", "description": "The full code snippet to write."}
        },
        "required": ["filepath", "content"]
    }
)

execute_command_func = FunctionDeclaration(
    name="execute_command",
    description="Executes a bash command and returns the output.",
    parameters={
        "type": "object",
        "properties": {"command": {"type": "string", "description": "The terminal command to run."}},
        "required": ["command"]
    }
)

update_task_status_func = FunctionDeclaration(
    name="update_task_status",
    description="Updates the checkbox status of a specific task in a markdown task list.",
    parameters={
        "type": "object",
        "properties": {
            "filepath": {"type": "string"},
            "task_string": {"type": "string"},
            "new_status": {"type": "string"}
        },
        "required": ["filepath", "task_string", "new_status"]
    }
)

list_directory_func = FunctionDeclaration(
    name="list_directory",
    description="Returns the contents of a specified directory.",
    parameters={
        "type": "object",
        "properties": {"path": {"type": "string", "description": "The directory path to list."}},
        "required": ["path"]
    }
)

search_code_func = FunctionDeclaration(
    name="search_code",
    description="Searches for a string across source files in the workspace.",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "directory": {"type": "string"}
        },
        "required": ["query", "directory"]
    }
)

forge_tools = Tool(function_declarations=[
    read_file_func,
    create_artifact_func,
    write_code_func,
    execute_command_func,
    update_task_status_func,
    list_directory_func,
    search_code_func,
])


# ---------------------------------------------------------------------------
# ForgeEngine
# ---------------------------------------------------------------------------
class ForgeEngine:

    def __init__(self):
        self.configs = {}
        self._initialized = False

    def _ensure_initialized(self):
        if self._initialized:
            return
        logger.info("Initialising Forge Engine…")
        project = os.environ.get("GOOGLE_CLOUD_PROJECT", "nastwest-u26wck-607")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
        logger.info(f"Vertex AI project={project} location={location}")
        vertexai.init(project=project, location=location)

        config_dir = Path(__file__).parent / "agent_configs"
        logger.info(f"Loading agent configs from: {config_dir}")
        for config_file in config_dir.glob("*.yaml"):
            with open(config_file, "r") as f:
                config = yaml.safe_load(f)
            agent_name = config_file.stem
            self.configs[agent_name] = config
            logger.info(f"  Loaded config: {agent_name} (model={config.get('model', '?')})")

        self._initialized = True
        logger.info("Forge Engine initialised successfully.")

    # ------------------------------------------------------------------
    def query(
        self,
        agent_name: str,
        prompt: str = None,
        context: str = None,
        message: str = None,
        chat_history: list = None,
    ) -> dict:
        """Public entrypoint. Multiplexes all agent tasks."""
        # Log the full incoming request so it appears in Cloud Logging
        clog("INCOMING_REQUEST", severity="INFO",
             agent=agent_name,
             prompt=prompt,
             context=context,
             message=message,
             history_len=len(chat_history) if chat_history else 0,
             chat_history=chat_history)

        self._ensure_initialized()

        if message is not None:
            return self._send_message_to_agent(agent_name, message, chat_history)

        if agent_name == "orchestrator":
            initial_prompt = (
                f"User Request: {prompt}\n"
                f"Code Context:\n{context}\n\n"
                f"Please determine the next routing step. Use tools to read files if necessary."
            )
        else:
            initial_prompt = prompt

        logger.info(f"Fresh start for agent '{agent_name}'")
        return self._send_message_to_agent(agent_name, initial_prompt, [])

    # ------------------------------------------------------------------
    @staticmethod
    def _extract_function_calls(response):
        calls = []
        try:
            for part in response.candidates[0].content.parts:
                if hasattr(part, 'function_call') and part.function_call.name:
                    calls.append(part.function_call)
        except (IndexError, AttributeError) as e:
            logger.warning(f"_extract_function_calls: {e}")
        return calls

    @staticmethod
    def _extract_text(response):
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
        except IndexError as e:
            logger.warning(f"_extract_text: {e}")
        return text.strip()

    # ------------------------------------------------------------------
    def _send_message_to_agent(
        self,
        agent_name: str,
        message: str,
        chat_history: list = None,
    ) -> dict:
        self._ensure_initialized()

        if agent_name not in self.configs:
            err = f"Error: Agent '{agent_name}' not found."
            logger.error(err)
            return {"type": "text", "text": err, "raw_assistant_message": {"role": "model", "parts": [{"text": err}]}}

        config = self.configs[agent_name]
        model_name = config["model"]
        logger.info(f"_send_message_to_agent — agent={agent_name} model={model_name}")

        model = GenerativeModel(
            model_name,
            system_instruction=config["instructions"],
            tools=[forge_tools]
        )

        # ── Reconstruct history ──────────────────────────────────────────
        import vertexai.generative_models as gm
        contents = []

        if chat_history:
            logger.debug(f"Reconstructing chat history ({len(chat_history)} messages)")
            for idx, msg in enumerate(chat_history):
                role = msg["role"]
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
                contents.append(gm.Content(role=role, parts=parts))
                logger.debug(f"  History[{idx}] role={role} parts={len(parts)}")

        # ── Append new user message ──────────────────────────────────────
        try:
            parsed_msg = json.loads(message)
        except json.JSONDecodeError:
            parsed_msg = None

        if isinstance(parsed_msg, list) and parsed_msg and "functionResponse" in parsed_msg[0]:
            logger.debug(f"Appending {len(parsed_msg)} functionResponse part(s)")
            new_parts = []
            for p in parsed_msg:
                fr = p["functionResponse"]
                logger.debug(f"  functionResponse: {fr['name']} → {_truncate(fr['response'])}")
                new_parts.append(Part.from_function_response(
                    name=fr["name"],
                    response=fr["response"]
                ))
            contents.append(gm.Content(role="user", parts=new_parts))
        else:
            logger.debug(f"Appending text user message: {_truncate(message)}")
            contents.append(gm.Content(role="user", parts=[Part.from_text(message)]))

        # ── Call the model ───────────────────────────────────────────────
        logger.info(
            f"Calling generate_content — agent={agent_name} "
            f"total_turns={len(contents)} model={model_name}"
        )
        logger.debug(f"Full contents array ({len(contents)} items):")
        for i, c in enumerate(contents):
            part_summaries = []
            for p in c.parts:
                try:
                    if hasattr(p, 'function_call') and p.function_call.name:
                        part_summaries.append(f"functionCall:{p.function_call.name}")
                    elif hasattr(p, 'text') and p.text:
                        part_summaries.append(f"text:{_truncate(p.text, 120)}")
                    else:
                        part_summaries.append("(unknown part)")
                except Exception:
                    part_summaries.append("(unreadable part)")
            logger.debug(f"  contents[{i}] role={c.role} parts=[{', '.join(part_summaries)}]")

        # Log EXACTLY what is being sent to the model
        clog("GENERATE_CONTENT_REQUEST", severity="INFO",
             agent=agent_name,
             model=model_name,
             num_turns=len(contents),
             contents=_serialise_contents(contents))

        t_start = time.time()
        try:
            response = model.generate_content(contents)
        except Exception as exc:
            clog("GENERATE_CONTENT_ERROR", severity="ERROR",
                 agent=agent_name, error=str(exc))
            raise

        duration_ms = int((time.time() - t_start) * 1000)

        fn_calls = self._extract_function_calls(response)
        response_text = self._extract_text(response)

        try:
            finish_reason = str(response.candidates[0].finish_reason)
        except Exception:
            finish_reason = "unknown"

        # Log EXACTLY what came back from the model
        clog("GENERATE_CONTENT_RESPONSE", severity="INFO",
             agent=agent_name,
             model=model_name,
             duration_ms=duration_ms,
             finish_reason=finish_reason,
             response_text=response_text,
             function_calls=[
                 {"name": c.name, "args": {k: v for k, v in c.args.items()}}
                 for c in fn_calls
             ])

        # ── Build and return result ──────────────────────────────────────
        if fn_calls:
            serialized_calls = [
                {"name": c.name, "args": {k: v for k, v in c.args.items()}}
                for c in fn_calls
            ]
            result = {
                "type": "function_calls",
                "calls": serialized_calls,
                "text": response_text,
                "raw_assistant_message": {
                    "role": "model",
                    "parts": [{"text": response_text}] + [
                        {"functionCall": {"name": c.name, "args": {k: v for k, v in c.args.items()}}}
                        for c in fn_calls
                    ]
                }
            }
        else:
            result = {
                "type": "text",
                "text": response_text,
                "raw_assistant_message": {
                    "role": "model",
                    "parts": [{"text": response_text}]
                }
            }

        # Log the full response being returned to the VS Code extension
        clog("OUTGOING_RESPONSE", severity="INFO",
             agent=agent_name,
             result_type=result["type"],
             response_text=response_text,
             function_calls=result.get("calls", []))

        return result


# For Vertex Agent Engine
app = ForgeEngine()