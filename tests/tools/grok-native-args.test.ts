import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  grepArgsForLocalSearch,
  listDirArgsForPi,
  objectFromGrokToolArgs,
  prepareGrepArgs,
  prepareListDirArgs,
  prepareReadFileArgs,
  prepareSearchReplaceArgs,
  prepareTerminalCommandArgs,
  prepareWebSearchArgs,
  readFileArgsForPi,
  safeWorkspacePath,
  searchReplaceArgsForPi,
  terminalCommandArgsForPi,
} from "../../extensions/xai/tools/grok-native-args";

describe("Grok-native argument normalization", () => {
  it("coerces object, JSON, and plain-string calls", () => {
    expect(objectFromGrokToolArgs({ target_file: "a" })).toEqual({ target_file: "a" });
    expect(objectFromGrokToolArgs('{"target_file":"a"}')).toEqual({ target_file: "a" });
    expect(objectFromGrokToolArgs("a")).toEqual({ value: "a" });
  });

  it("maps read_file and list_dir aliases to native and pi contracts", () => {
    expect(
      prepareReadFileArgs({
        file_path: "a",
        start_line: "2",
        max_lines: 3,
        pages: "1-5",
        format: "text",
      }),
    ).toEqual({ target_file: "a", offset: 2, limit: 3, pages: "1-5", format: "text" });
    expect(readFileArgsForPi({ target_file: "a", offset: 2, limit: 3 })).toEqual({
      path: "a",
      offset: 2,
      limit: 3,
    });
    expect(prepareListDirArgs({ path: "src" })).toEqual({ target_directory: "src" });
    expect(listDirArgsForPi({ target_directory: "src" })).toEqual({ path: "src" });
    expect(() => prepareReadFileArgs({ target_file: "a", offset: 1.5 })).toThrow(/integer/);
  });

  it("preserves empty search_replace strings and maps replace_all", () => {
    expect(
      prepareSearchReplaceArgs({
        path: "a",
        old_string: "",
        new_string: "contents",
        replace_all: "yes",
      }),
    ).toEqual({
      file_path: "a",
      old_string: "",
      new_string: "contents",
      replace_all: true,
    });
    expect(
      searchReplaceArgsForPi({
        file_path: "a",
        old_string: "before",
        new_string: "",
      }),
    ).toEqual({
      path: "a",
      oldText: "before",
      newText: "",
      replaceAll: false,
    });
  });

  it("normalizes Grok grep flags and legacy aliases", () => {
    const prepared = prepareGrepArgs({
      query: "needle",
      include: "*.ts",
      context_lines: "2",
      case_insensitive: "yes",
      head_limit: "3",
    });
    expect(prepared).toEqual({
      pattern: "needle",
      glob: "*.ts",
      "-C": 2,
      "-i": true,
      head_limit: 3,
    });
    expect(grepArgsForLocalSearch(prepared)).toMatchObject({
      pattern: "needle",
      glob: "*.ts",
      context: 2,
      ignoreCase: true,
      limit: 3,
    });
    expect(() => prepareGrepArgs({ glob: "*.ts" })).toThrow(/requires a non-empty pattern/);
  });

  it("converts terminal milliseconds to pi seconds without hiding background intent", () => {
    expect(
      prepareTerminalCommandArgs({
        cmd: "echo ok",
        timeout_ms: "10000",
        description: "verify output",
        is_background: "true",
      }),
    ).toEqual({
      command: "echo ok",
      description: "verify output",
      background: true,
      timeout: 10_000,
    });
    expect(
      terminalCommandArgsForPi({ command: "echo ok", timeout: 10_000, background: false }),
    ).toEqual({ command: "echo ok", timeout: 10, background: false });
    expect(terminalCommandArgsForPi({ command: "echo default" })).toEqual({
      command: "echo default",
      timeout: 120,
      background: false,
    });
    expect(terminalCommandArgsForPi({ command: "echo zero", timeout: 0 })).toEqual({
      command: "echo zero",
      timeout: 120,
      background: false,
    });
    expect(terminalCommandArgsForPi({ command: "echo capped", timeout: 999_999 })).toEqual({
      command: "echo capped",
      timeout: 300,
      background: false,
    });
    expect(() => terminalCommandArgsForPi({ command: "echo bad", timeout: -1 })).toThrow(
      /zero or a positive number/,
    );
  });

  it("preserves the official web-search domain filter list exactly", () => {
    const domains = Array.from({ length: 12 }, (_, index) => ` site-${index}.example `);
    expect(prepareWebSearchArgs({ query: "xAI", allowed_domains: domains })).toEqual({
      query: "xAI",
      allowed_domains: domains,
    });
    expect(prepareWebSearchArgs({ query: "xAI", allowed_domains: [] })).toEqual({
      query: "xAI",
      allowed_domains: [],
    });
    expect(() => prepareWebSearchArgs({ query: "xAI", allowed_domains: ["x.ai", 1] })).toThrow(
      /array of strings/,
    );
  });

  it("keeps local grep inside the workspace", () => {
    const workspace = resolve("/tmp/work");
    expect(safeWorkspacePath(workspace, "src/a.ts")).toBe(resolve(workspace, "src/a.ts"));
    expect(() => safeWorkspacePath("/tmp/work", "../secret")).toThrow(/outside the workspace/);
  });
});
