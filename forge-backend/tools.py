import subprocess
import os
import re

def read_file(filepath: str) -> str:
    if not os.path.exists(filepath):
        return "File not found."
    with open(filepath, 'r') as f:
        return f.read()

def create_artifact(filepath: str, content: str) -> str:
    os.makedirs(os.path.dirname(filepath) or '.', exist_ok=True)
    with open(filepath, 'w') as f:
        f.write(content)
    return f"Created artifact at {filepath}"

def write_code(filepath: str, content: str) -> str:
    os.makedirs(os.path.dirname(filepath) or '.', exist_ok=True)
    with open(filepath, 'w') as f:
        f.write(content)
    return f"Wrote code to {filepath}"

def execute_command(command: str) -> str:
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
            lines[i] = re.sub(r'\[[ x\/]\]', f'[{new_status}]', line)
            updated = True
            break
    if updated:
        with open(filepath, 'w') as f:
            f.writelines(lines)
        return f"Updated task status in {filepath}"
    return "Task string not found in file."

def list_directory(path: str) -> str:
    if not os.path.exists(path):
        return f"Directory not found: {path}"
    if not os.path.isdir(path):
        return f"Path is not a directory: {path}"
    try:
        entries = os.listdir(path)
        if not entries:
            return "Directory is empty."
        lines = []
        for name in sorted(entries):
            full = os.path.join(path, name)
            prefix = "[DIR] " if os.path.isdir(full) else "[FILE]"
            lines.append(f"{prefix} {name}")
        return "\n".join(lines)
    except Exception as e:
        return f"Error listing directory: {str(e)}"

def search_code(query: str, directory: str) -> str:
    if not os.path.exists(directory):
        return f"Directory not found: {directory}"
    results = []
    text_extensions = {'.ts', '.js', '.py', '.md', '.json', '.yaml', '.yml', '.txt', '.html', '.css'}
    skip_dirs = {'node_modules', '.git', '.venv', '__pycache__', 'dist', 'out'}
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        for filename in files:
            if os.path.splitext(filename)[1] not in text_extensions:
                continue
            filepath = os.path.join(root, filename)
            try:
                with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                    for i, line in enumerate(f, 1):
                        if query in line:
                            rel = os.path.relpath(filepath, directory)
                            results.append(f"{rel}:{i}: {line.rstrip()}")
                            if len(results) >= 100:
                                break
            except Exception:
                continue
            if len(results) >= 100:
                break
    return "\n".join(results) if results else "No matches found."

tool_map = {
    "read_file": read_file,
    "create_artifact": create_artifact,
    "write_code": write_code,
    "execute_command": execute_command,
    "update_task_status": update_task_status,
    "list_directory": list_directory,
    "search_code": search_code,
}