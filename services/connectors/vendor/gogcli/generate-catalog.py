#!/usr/bin/env python3
"""Generate the reviewed connector API catalog from `gog schema --json`.

Usage: python3 generate-catalog.py schema.json [destination.json]
The upstream revision is recorded in the native port README and vendor manifest.
Local runtime controls are deliberately outside this provider API interface.
"""
import json
from pathlib import Path
import sys

SERVICES = set("admin groups drive docs slides calendar maps classroom gmail chat contacts tasks people keep sheets forms sites meet appscript analytics searchconsole adsense youtube photos api".split())
BLOCKED_FLAGS = set("on-new on-change mmdc service-account hook-url hook-token save-hook show-secrets open batch track track-split impersonate".split())
INPUT_FLAGS = set("attach body-file body-html-file note-file signature-file raw-file content-file from-file notes-file image replacements".split())
JSON_FLAGS = set("data-json spec-json format-json gradient-rule-json cells-json columns-json values-json".split())
OUTPUT_FLAGS = set("out out-dir dir".split())


def field_mode(command, field):
    name = field["name"]
    if name in INPUT_FLAGS or (name == "file" and command.startswith("docs.")) or (name == "file" and command == "gmail.import") or name in ("localPath", "localDirectory"):
        return "input_dir" if name == "localDirectory" else "input"
    if name in OUTPUT_FLAGS:
        return "output_dir" if name in ("out-dir", "dir") else "output"
    if name == "state-file":
        return "state"
    if name in JSON_FLAGS or name.endswith("-json") or (name == "body" and command == "api.call") or (name == "request" and command in ("searchconsole.query", "searchconsole.searchanalytics.query")):
        return "json_file"
    return None


def main():
    document = json.loads(Path(sys.argv[1]).read_text())
    root = document["command"]
    root_flags = {x["name"] for x in root["flags"]}
    commands, excluded = [], []

    def walk(node, path):
        path = path + [node["name"]]
        if len(path) > 1 and path[1] not in SERVICES:
            return
        for child in node.get("subcommands", []):
            walk(child, path)
        if node.get("subcommands") or len(path) < 3:
            return
        command = ".".join(path[1:])
        if command.endswith(".serve") or command.startswith(("gmail.track.", "gmail.settings.watch.", "calendar.alias.")) or node.get("passthrough"):
            excluded.append({"command": command, "reason": "local runtime or persistent service command"})
            return
        service = path[1]
        if command.startswith("drive.activity."):
            service = "driveactivity"
        elif command in ("drive.labels.get", "drive.labels.list"):
            service = "drivelabels"
        elif command.startswith("photos.picker."):
            service = "photospicker"
        result = {"command": command, "service": service, "help": node.get("help", ""), "requires_confirmation": True}
        for kind in ("flags", "positionals"):
            fields = []
            for source in node.get(kind, []):
                if kind == "flags" and (source["name"] in root_flags or (source["name"] in BLOCKED_FLAGS or "zoom" in source["name"])):
                    continue
                field = {k: source[k] for k in ("name", "help", "type", "required", "enum", "cumulative") if k in source}
                mode = field_mode(command, field)
                if mode:
                    field["file_mode"] = mode
                if "default" in source:
                    field["default"] = source["default"]
                fields.append(field)
            result[kind] = fields
        blocked = [f["name"] for f in node.get("flags", []) if f["name"] in BLOCKED_FLAGS or "zoom" in f["name"]]
        if blocked:
            result["unavailable_flags"] = sorted(blocked)
        commands.append(result)

    walk(root, [])
    destination = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parent / "catalog.json"
    destination.write_text(json.dumps({"schema_version": 1, "commands": sorted(commands, key=lambda c: c["command"]), "excluded": excluded}, indent=2) + "\n")
    print(f"Generated {len(commands)} API commands; excluded {len(excluded)} local runtime commands")


if __name__ == "__main__":
    main()
