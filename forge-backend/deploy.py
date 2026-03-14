import os
import json
import time
import yaml
from dotenv import load_dotenv
load_dotenv()

import vertexai
from vertexai.preview import reasoning_engines

# --- Path Resolution based on your folder structure ---
backend_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(backend_dir)
extension_dir = os.path.join(parent_dir, "forge-vscode")

# --- 1. COMPILE YAML INTO PURE PYTHON (THE ULTIMATE CACHE BYPASS) ---
configs_dir = os.path.join(backend_dir, "agent_configs")
agent_registry = {}

if os.path.exists(configs_dir):
    for file in os.listdir(configs_dir):
        if file.endswith('.yaml'):
            agent_name = file.replace('.yaml', '')
            with open(os.path.join(configs_dir, file), 'r', encoding='utf-8') as f:
                agent_registry[agent_name] = yaml.safe_load(f)

registry_path = os.path.join(backend_dir, "agent_registry.py")
with open(registry_path, "w", encoding='utf-8') as f:
    f.write("# AUTO-GENERATED AT DEPLOYMENT. DO NOT EDIT.\n")
    f.write("AGENT_CONFIGS = " + json.dumps(agent_registry, indent=4))

print(f"\n✅ Compiled {len(agent_registry)} agents directly into agent_registry.py")
if "recovery_agent" not in agent_registry:
    print("❌ CRITICAL: recovery_agent was not found in the YAML files. Aborting.")
    exit(1)

# 🔥 Import the app AFTER compiling the registry so it loads the fresh data
from forge_engine import app

vertexai.init(
    project="nastwest-u26wck-607",
    location="us-central1",
    staging_bucket="gs://forge-staging-nastwest-u26wck-607"
)

print("\n🚀 Forging the Backend Endpoint on Vertex AI...")
deploy_name = f"Forge-Deploy-{int(time.time())}"

remote_agent = reasoning_engines.ReasoningEngine.create(
    reasoning_engine=app,
    requirements=["pyyaml", "google-cloud-aiplatform", "python-dotenv"],
    # Notice we upload the generated python file instead of the yaml folder
    extra_packages=["agent_registry.py", "forge_engine.py"], 
    display_name=deploy_name
)

endpoint_id = remote_agent.resource_name
print(f"\n✅ Forge Endpoint ID: {endpoint_id}")

# --- 2. UPDATE PACKAGE.JSON DEFAULTS ---
# This ensures the "default" value in the extension matches the new deployment.
package_json_path = os.path.join(extension_dir, "package.json")
if os.path.exists(package_json_path):
    with open(package_json_path, "r", encoding='utf-8') as f:
        package_data = json.load(f)
    try:
        package_data["contributes"]["configuration"]["properties"]["forge.endpointId"]["default"] = endpoint_id
        with open(package_json_path, "w", encoding='utf-8') as f:
            json.dump(package_data, f, indent=2)
        print(f"✅ Updated package.json default to: {endpoint_id}")
    except KeyError:
        print("⚠️ Warning: Could not find forge.endpointId default property in package.json")

# --- 3. CLEAR WORKSPACE OVERRIDES ---
# Deleting the key from settings.json forces VS Code to fallback to the package.json default,
# ensuring the GUI is not "stuck" on a bolded, outdated manual override.
vscode_settings_dir = os.path.join(extension_dir, ".vscode")
settings_path = os.path.join(vscode_settings_dir, "settings.json")

if os.path.exists(vscode_settings_dir):
    settings_data = {}
    if os.path.exists(settings_path):
        with open(settings_path, "r", encoding='utf-8') as f:
            try:
                settings_data = json.load(f)
            except json.JSONDecodeError:
                pass 
    
    # Force removal of existing override to refresh the Settings GUI.
    if "forge.endpointId" in settings_data:
        del settings_data["forge.endpointId"]
        with open(settings_path, "w", encoding='utf-8') as f:
            json.dump(settings_data, f, indent=2)
        print(f"✅ Cleared workspace override in {settings_path} to force-refresh GUI.")
    else:
        print(f"ℹ️ No workspace override found in {settings_path}; already using defaults.")