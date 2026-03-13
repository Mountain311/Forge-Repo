import os
import json
import time
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

# --- Path Resolution based on your folder structure ---
backend_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(backend_dir)
extension_dir = os.path.join(parent_dir, "forge-vscode")

# --- NEW: VERIFICATION & CACHE BUSTING ---
configs_dir = os.path.join(backend_dir, "agent_configs")
yaml_files = []
if os.path.exists(configs_dir):
    yaml_files = [f for f in os.listdir(configs_dir) if f.endswith('.yaml')]

print(f"\n🔍 Pre-deployment check. Found {len(yaml_files)} YAML files in {configs_dir}:")
for f in yaml_files:
    print(f"  - {f}")

if "recovery_agent.yaml" not in yaml_files:
    print("\n❌ CRITICAL ERROR: recovery_agent.yaml is physically missing from the agent_configs folder,")
    print("   OR your operating system hid the extension (e.g., it is actually named recovery_agent.yaml.txt).")
    print("   Deployment aborted.")
    exit(1)

print("\n🚀 Forging the Backend Endpoint on Vertex AI...")

# Adding a timestamp ensures Vertex AI does NOT use cached staging files
deploy_name = f"Forge-Deploy-{int(time.time())}"

remote_agent = reasoning_engines.ReasoningEngine.create(
    reasoning_engine=app,
    requirements=["pyyaml", "google-cloud-aiplatform", "python-dotenv"],
    extra_packages=["agent_configs", "forge_engine.py"], 
    display_name=deploy_name
)

endpoint_id = remote_agent.resource_name
print(f"\n✅ Forge Endpoint ID: {endpoint_id}")

# 1. Save to text file
endpoint_txt_path = os.path.join(backend_dir, "endpoint_id.txt")
with open(endpoint_txt_path, "w") as f:
    f.write(endpoint_id)

# 2. Automagically update the default value in package.json
package_json_path = os.path.join(extension_dir, "package.json")
if os.path.exists(package_json_path):
    with open(package_json_path, "r") as f:
        package_data = json.load(f)
    try:
        package_data["contributes"]["configuration"]["properties"]["forge.endpointId"]["default"] = endpoint_id
        with open(package_json_path, "w") as f:
            json.dump(package_data, f, indent=2)
    except KeyError:
        pass

# 3. Automagically force the workspace settings to use the new ID immediately
vscode_settings_dir = os.path.join(extension_dir, ".vscode")
settings_path = os.path.join(vscode_settings_dir, "settings.json")

if os.path.exists(extension_dir):
    os.makedirs(vscode_settings_dir, exist_ok=True)
    settings_data = {}
    if os.path.exists(settings_path):
        with open(settings_path, "r") as f:
            try:
                settings_data = json.load(f)
            except json.JSONDecodeError:
                pass 
    
    settings_data["forge.endpointId"] = endpoint_id

    with open(settings_path, "w") as f:
        json.dump(settings_data, f, indent=2)
    print(f"✅ Workspace settings overridden in {settings_path} (Hot-reload active!)")