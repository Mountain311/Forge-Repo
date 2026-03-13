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
    extra_packages=["agent_configs", "tools.py", "forge_engine.py"], 
    display_name="Forge-Milestone-1"
)

print(f"\nForge Endpoint ID: {remote_agent.resource_name}")

with open("endpoint_id.txt", "w") as f:
    f.write(remote_agent.resource_name)
print("Endpoint ID saved to endpoint_id.txt")
