import type { System } from "../lib/plugos/system.ts";
import type { ScriptObject } from "../plugs/index/script.ts";
import {
  LuaEnv,
  LuaFunction,
  LuaNativeJSFunction,
} from "$common/space_lua/runtime.ts";
import { luaBuildStandardEnv } from "$common/space_lua/stdlib.ts";
import { parse as parseLua } from "$common/space_lua/parse.ts";
import { evalStatement } from "$common/space_lua/eval.ts";
import { jsToLuaValue } from "$common/space_lua/runtime.ts";
import { LuaBuiltinFunction } from "$common/space_lua/runtime.ts";
import { LuaTable } from "$common/space_lua/runtime.ts";
import { parsePageRef } from "@silverbulletmd/silverbullet/lib/page_ref";
import type { ScriptEnvironment } from "$common/space_script.ts";
import { luaValueToJS } from "$common/space_lua/runtime.ts";

export class SpaceLuaEnvironment {
  env: LuaEnv = new LuaEnv();

  /**
   * Loads all Lua scripts from the database and evaluates them in a new environment
   * @param system
   */
  async reload(system: System<any>, scriptEnv: ScriptEnvironment) {
    const allScripts: ScriptObject[] = await system.invokeFunction(
      "index.queryObjects",
      ["space-lua", {}],
    );
    // We start from scratch
    this.env = new LuaEnv(luaBuildStandardEnv());
    const env = this.env;

    // Expose all syscalls to Lua
    for (const syscallName of system.registeredSyscalls.keys()) {
      const [ns, fn] = syscallName.split(".");
      if (!env.get(ns)) {
        env.set(ns, new LuaTable());
      }
      env.get(ns).set(
        fn,
        new LuaNativeJSFunction((...args) => {
          return system.localSyscall(syscallName, args);
        }),
      );
    }
    const sbApi = new LuaTable();
    sbApi.set(
      "register_command",
      new LuaBuiltinFunction(
        (def: LuaTable) => {
          if (def.get(1) === undefined) {
            throw new Error("Callback is required");
          }
          scriptEnv.registerCommand(
            def.toJSObject() as any,
            async (...args: any[]) => {
              try {
                return await def.get(1).call(...args.map(jsToLuaValue));
              } catch (e: any) {
                console.error("Lua eval exception", e.message, e.context);
                if (e.context && e.context.ref) {
                  // We got an error and actually know where it came from, let's navigate there to help debugging
                  const pageRef = parsePageRef(e.context.ref);
                  await system.localSyscall("editor.flashNotification", [
                    `Lua error: ${e.message}`,
                    "error",
                  ]);
                  await system.localSyscall("editor.flashNotification", [
                    `Navigating to the place in the code where this error occurred in ${pageRef.page}`,
                    "info",
                  ]);
                  await system.localSyscall("editor.navigate", [
                    {
                      page: pageRef.page,
                      pos: pageRef.pos + e.context.from +
                        "```space-lua\n".length,
                    },
                  ]);
                }
              }
            },
          );
        },
      ),
    );

    env.set("silverbullet", sbApi);
    for (const script of allScripts) {
      try {
        const ast = parseLua(script.script, { ref: script.ref });
        // We create a local scope for each script
        const scriptEnv = new LuaEnv(env);
        await evalStatement(ast, scriptEnv);
      } catch (e: any) {
        console.error(
          `Error evaluating script: ${e.message} for script: ${script.script}`,
        );
      }
    }
    // Find all functions and register them
    for (const globalName of env.keys()) {
      const value = env.get(globalName);
      if (value instanceof LuaFunction) {
        console.log("Now registering Lua function", globalName);
        scriptEnv.registerFunction({ name: globalName }, (...args: any[]) => {
          return luaValueToJS(value.call(...args.map(jsToLuaValue)));
        });
      }
    }
    console.log("Loaded", allScripts.length, "Lua scripts");
  }
}
