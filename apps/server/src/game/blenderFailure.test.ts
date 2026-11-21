import { describe, expect, it } from "@effect/vitest";

import { pythonFailure } from "./blenderFailure.ts";

// Shortened from real bench runs: the cause sits at the end, behind a traceback.
const KIT_KEY_ERROR = `Error executing code: Communication error with Blender: ${JSON.stringify({
  exception_type: "RuntimeError",
  message:
    "Error: Python: Traceback (most recent call last):\n  File \"/b/io_scene_gltf2/blender/imp/pbrMetallicRoughness.py\", line 164, in pbr_metallic_roughness\n    iridescence_factor_socket=mh.settings_node.inputs['Iridescence Factor']\nKeyError: 'bpy_prop_collection[key]: key \"Iridescence Factor\" not found'\nLocation: /k/kurambit/skeleton.py:135\n",
  traceback:
    'Traceback (most recent call last):\n  File "/h/blender_mcp.py", line 2333, in execute_code\n    exec(code, namespace)\n  File "<string>", line 5, in <module>\n  File "/k/kurambit/review.py", line 385, in review\n  File "/k/kurambit/skeleton.py", line 135, in import_gltf\nRuntimeError: Error: Python: Traceback (most recent call last):\n',
})}`;
const OWN_NAME_ERROR = `Error executing code: Communication error with Blender: ${JSON.stringify({
  exception_type: "NameError",
  message: "name 'kurambit' is not defined",
  traceback:
    'Traceback (most recent call last):\n  File "/h/blender_mcp.py", line 2333, in execute_code\n    exec(code, namespace)\n  File "<string>", line 3, in <module>\nNameError: name \'kurambit\' is not defined\n',
})}`;

describe("pythonFailure", () => {
  it("puts the exception that ended the traceback first, with the kit's file and line", () => {
    expect(pythonFailure(KIT_KEY_ERROR)).toBe(
      `KeyError: 'bpy_prop_collection[key]: key "Iridescence Factor" not found' (at line 5 of the code, in kurambit/skeleton.py line 135).\n`,
    );
  });

  it("names the line of the agent's own code", () => {
    expect(pythonFailure(OWN_NAME_ERROR)).toBe(
      "NameError: name 'kurambit' is not defined (at line 3 of the code).\n",
    );
  });

  it("says nothing it cannot read", () => {
    expect(pythonFailure("Error: Blender is busy")).toBeNull();
  });
});
