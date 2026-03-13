import os
import json
from dotenv import load_dotenv
load_dotenv()

import vertexai
from vertexai.preview import reasoning_engines
from forge_engine import app

vertexai.init(
    project="nastwest-u26wck-607",
    location="us-central1",
    staging_bucket="gs://forge-staging-nastwest-u26wck-607"
)

print("Forging the Backend Endpoint on Vertex AI...")

remote_agent = reasoning_engines.ReasoningEngine.create(
    reasoning_engine=app,
    requirements=["pyyaml", "google-cloud-aiplatform", "python-dotenv"],
    extra_packages=["agent_configs", "forge_engine.py"], 
    display_name="Forge-Milestone-1"
)

endpoint_id = remote_agent.resource_name
print(f"\nForge Endpoint ID: {endpoint_id}")

# --- Path Resolution based on your folder structure ---
# Gets the absolute path of the folder deploy.py is inside (forge-backend)
backend_dir = os.path.dirname(os.path.abspath(__file__))
# Jumps up one level to the parent folder
parent_dir = os.path.dirname(backend_dir)
# Jumps down into the VS Code extension folder
extension_dir = os.path.join(parent_dir, "forge-vscode")

# 1. Save to text file (local to backend folder)
endpoint_txt_path = os.path.join(backend_dir, "endpoint_id.txt")
with open(endpoint_txt_path, "w") as f:
    f.write(endpoint_id)
print(f"✅ Endpoint ID saved to {endpoint_txt_path}")

# 2. Automagically update the default value in package.json
package_json_path = os.path.join(extension_dir, "package.json")
if os.path.exists(package_json_path):
    with open(package_json_path, "r") as f:
        package_data = json.load(f)
    
    try:
        package_data["contributes"]["configuration"]["properties"]["forge.endpointId"]["default"] = endpoint_id
        with open(package_json_path, "w") as f:
            json.dump(package_data, f, indent=2)
        print(f"✅ Updated default forge.endpointId in {package_json_path}")
    except KeyError as e:
        print(f"⚠️ Could not find the configuration path in package.json: {e}")
else:
    print(f"⚠️ package.json not found at {package_json_path}. Check your folder structure.")

# 3. Automagically force the workspace settings to use the new ID immediately
vscode_settings_dir = os.path.join(extension_dir, ".vscode")
settings_path = os.path.join(vscode_settings_dir, "settings.json")

# Only try to update settings if the extension directory actually exists
if os.path.exists(extension_dir):
    os.makedirs(vscode_settings_dir, exist_ok=True)
    
    settings_data = {}
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            try:
                settings_data = json.load(f)
            except json.JSONDecodeError:
                pass  # File is empty or malformed

    # Inject the new endpoint
    settings_data["forge.endpointId"] = endpoint_id

    with open(settings_path, "w") as f:
        json.dump(settings_data, f, indent=2)
    print(f"✅ Workspace settings overridden in {settings_path} (Hot-reload active!)")
else:
    print(f"⚠️ Could not find extension directory at {extension_dir} to update settings.json")