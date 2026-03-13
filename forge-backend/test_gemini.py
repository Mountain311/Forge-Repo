import vertexai
from vertexai.generative_models import GenerativeModel, Tool, FunctionDeclaration, Part
import vertexai.generative_models as gm
import yaml
import json

vertexai.init(project="nastwest-u26wck-607", location="us-central1")

read_file_func = FunctionDeclaration(name="read_file", description="Reads a file.", parameters={"type": "object", "properties": {"filepath": {"type": "string"}}, "required": ["filepath"]})
list_dir_func = FunctionDeclaration(name="list_directory", description="Lists files.", parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]})

forge_tools = Tool(function_declarations=[read_file_func, list_dir_func])

with open("agent_configs/orchestrator.yaml", "r") as f:
    config = yaml.safe_load(f)

model = GenerativeModel("gemini-2.5-pro", system_instruction=config["instructions"], tools=[forge_tools])

def _extract_text(response):
    text = ""
    try:
        for part in response.candidates[0].content.parts:
            try:
                if hasattr(part, 'function_call') and part.function_call.name:
                    continue
                if hasattr(part, 'text') and part.text:
                    text += part.text + "\n"
            except AttributeError: ...
    except IndexError: ...
    return text.strip()

print("Initial user message")
contents = [gm.Content(role="user", parts=[Part.from_text("User Request: @forge create a simple python calculator app\nCode Context:\n\n\nPlease determine the next routing step. Use tools to read files if necessary.")])]

for step in range(5):
    print(f"\n--- Turn {step+1} ---")
    resp = model.generate_content(contents)
    text = _extract_text(resp)
    print("Agent Text:", text)
    
    calls = []
    if resp.candidates and resp.candidates[0].content.parts:
        for p in resp.candidates[0].content.parts:
            if hasattr(p, 'function_call') and p.function_call.name:
                calls.append(p.function_call)
    
    if calls:
        print("Agent calls tools:", [c.name for c in calls])
        # Build raw assistant message
        model_parts = []
        if text: model_parts.append(Part.from_text(text))
        for c in calls: model_parts.append(Part.from_function_call(c.name, {k: v for k, v in c.args.items()}))
        contents.append(gm.Content(role="model", parts=model_parts))
        
        # Mock responses
        resps = []
        for c in calls:
            mock_res = "Directory is empty." if c.name == "list_directory" else "File not found."
            resps.append(Part.from_function_response(c.name, {"content": mock_res}))
        print("Sending backend response...")
        contents.append(gm.Content(role="user", parts=resps))
    else:
        print("Agent done.")
        break
