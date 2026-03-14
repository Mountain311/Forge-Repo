import vertexai
from vertexai.preview import reasoning_engines
import json

vertexai.init(project="nastwest-u26wck-607", location="us-central1")

# The exact ID from your last successful deployment
ENDPOINT_ID = "projects/718442730167/locations/us-central1/reasoningEngines/1338254085073141760"

print(f"Connecting to Cloud Endpoint: {ENDPOINT_ID}\n")
engine = reasoning_engines.ReasoningEngine(ENDPOINT_ID)

# The full roster of your 11 agents
agents = [
    "orchestrator",
    "pm_agent",
    "tdd_coder",
    "workspace_analyzer",
    "architecture",
    "security",
    "dependencies",
    "data_leakage",
    "ethics",
    "review",
    "recovery_agent"
]

print(f"Initiating ping sequence for {len(agents)} agents...")

for agent_name in agents:
    print("\n" + "="*60)
    print(f"📡 Pinging {agent_name}...")
    try:
        # Send the query to the cloud
        response = engine.query(
            agent_name=agent_name, 
            prompt=f"Reply with exactly these words: '{agent_name} is alive in the cloud.'"
        )
        
        # 🔥 PRINT THE EXACT RAW RESPONSE
        print("\n--- EXACT RAW RESPONSE ---")
        # Attempt to pretty-print if it's a dict, otherwise cast to string
        if isinstance(response, dict):
            print(json.dumps(response, indent=2, default=str))
        else:
            print(response)
        print("--------------------------\n")
        
        # Parse for the summary line
        if isinstance(response, dict) and "text" in response:
            reply = response["text"]
        else:
            reply = str(response)
            
        print(f"✅ PARSED TEXT: {reply}")
        
    except Exception as e:
        print(f"❌ ERROR: {e}")

print("\n" + "="*60)
print("🏁 Ping sequence complete.")