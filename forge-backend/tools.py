import subprocess
import os

def read_file(filepath: str) -> str:
    if not os.path.exists(filepath): return "File not found."
    with open(filepath, 'r') as f: return f.read()

def create_artifact(filepath: str, content: str) -> str:
    with open(filepath, 'w') as f: f.write(content)
    return f"Created artifact at {filepath}"

def write_code(filepath: str, content: str) -> str:
    with open(filepath, 'w') as f: f.write(content)
    return f"Wrote code to {filepath}"

def execute_command(command: str) -> str:
    """Executes a terminal command (e.g., pytest, npm test)."""
    try:
        result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
        output = result.stdout if result.returncode == 0 else result.stderr
        return f"Exit Code: {result.returncode}\nOutput:\n{output}"
    except Exception as e:
        return f"Execution error: {str(e)}"

def update_task_status(filepath: str, task_string: str, new_status: str) -> str:
    if not os.path.exists(filepath):
        return "File not found."
    with open(filepath, 'r') as f:
        lines = f.readlines()
    
    updated = False
    for i, line in enumerate(lines):
        if task_string in line:
            import re
            lines[i] = re.sub(r'\[[ x\/ ]\]', f'[{new_status}]', line)
            updated = True
            break
            
    if updated:
        with open(filepath, 'w') as f:
            f.writelines(lines)
        return f"Updated task status in {filepath}"
    
    return "Task string not found in file."

def list_directory(path: str) -> str:
    return "Not implemented in sandbox. Run locally in VS Code."

def search_code(query: str, directory: str) -> str:
    return "Not implemented in sandbox. Run locally in VS Code."

tool_map = {
    "read_file": read_file, 
    "create_artifact": create_artifact, 
    "write_code": write_code,
    "execute_command": execute_command,
    "update_task_status": update_task_status,
    "list_directory": list_directory,
    "search_code": search_code
}
