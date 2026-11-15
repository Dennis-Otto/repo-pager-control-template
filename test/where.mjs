// Where the tests run: in the template, or in a control repository made from it. A
// control repository takes every file of the template but those of `own` of
// .github/template.json through its workflow Template, these tests too, so a test of a
// file that the template alone has, or of the template's own policy, asks first.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The root of this repository. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether this repository is the template: its `.github/template.json` names no commit
 * taken yet, and it has the `.github/dependabot.yml` that a control repository
 * deletes as the README says.
 */
export const IN_TEMPLATE =
  JSON.parse(readFileSync(join(ROOT, ".github/template.json"), "utf8"))
    .commit === "" && existsSync(join(ROOT, ".github/dependabot.yml"));
