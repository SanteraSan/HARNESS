/* Временные каталоги и ссылка на корень: литерального пути нет. */
/* eslint-disable security/detect-non-literal-fs-filename -- проверка клетки FILE_ROOT */
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileRootError, assertFileRoot, repositoryRoot } from "../../src/tools/file-root.js";

describe("assertFileRoot", () => {
  it("должен принять временный каталог и отказать корню репозитория, дому и .env", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "harness-file-root-"));
    await expect(assertFileRoot(workspace)).resolves.toBeUndefined();

    await expect(assertFileRoot(repositoryRoot())).rejects.toBeInstanceOf(FileRootError);
    await expect(assertFileRoot(homedir())).rejects.toBeInstanceOf(FileRootError);

    const parent = path.dirname(repositoryRoot());
    await expect(assertFileRoot(parent)).rejects.toBeInstanceOf(FileRootError);

    const withEnv = await mkdtemp(path.join(tmpdir(), "harness-file-root-env-"));
    await writeFile(path.join(withEnv, ".env"), "TOKEN=test-secret-value\n", "utf8");
    await expect(assertFileRoot(withEnv)).rejects.toMatchObject({ code: "invalid_file_root" });

    const linked = path.join(workspace, "link-to-repo");
    await symlink(repositoryRoot(), linked);
    await expect(assertFileRoot(linked)).rejects.toBeInstanceOf(FileRootError);

    const sibling = await mkdtemp(path.join(tmpdir(), "harness-file-root-evil-"));
    await expect(assertFileRoot(sibling)).resolves.toBeUndefined();
  });
});
