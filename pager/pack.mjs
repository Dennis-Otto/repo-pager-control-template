// The data of a job and the change of a fix, handed from one job to the next as
// outputs of a step, never through the storage of the artifacts: the job of Claude
// runs on the egress-firewall runner, which now and then doesn't reach the storage
// account of its run for minutes, while the inputs and the outputs of a job travel
// with the job itself. The job prepare packs the folder of the data, a tar in gzip
// in base64, and hands it on in PACK.data outputs; ask.yml unpacks it into data/
// with tar before Claude runs, and hands the change of a fix back the same way, a
// patch in gzip in base64, which the job pull-request unpacks here.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The limits of a pack. Each output is one variable of the environment of the step
 * that reads it, and Linux takes at most 131,072 bytes for one, its name included:
 * so a chunk holds 100,000 characters of base64. GitHub takes at most 1 MB of the
 * outputs of a job, the size approximated in UTF-16, two bytes for each character
 * of base64, and fails the job beyond it with "Job outputs exceed 1,048,576 bytes":
 * the job prepare keeps all of its outputs within `outputs` bytes, and the change of
 * a fix gets `patch` chunks, 600,000 bytes, beside Claude's answer. ask.yml holds the
 * same numbers, which test/workflows.test.mjs compares.
 */
export const PACK = {
  chunk: 100_000,
  data: 4,
  patch: 3,
  outputs: 768 * 1024,
};

/** The size of outputs as GitHub approximates it, in UTF-16: two bytes a unit. */
export function sizeOf(outputs) {
  return Object.entries(outputs).reduce(
    (sum, [name, value]) => sum + 2 * (name.length + String(value).length),
    0,
  );
}

/** A field of a header of a tar, in octal, as wide as the field less its NUL. */
function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

/** The header of one entry of a tar in the format ustar, which GNU tar reads. */
function header(name, size, type) {
  const block = Buffer.alloc(512);
  const field = (text, at) => block.write(text, at, "utf8");
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`the name ${name} is too long for the pack`);
  }
  field(name, 0);
  field(octal(type === "5" ? 0o755 : 0o644, 8), 100);
  field(octal(0, 8), 108);
  field(octal(0, 8), 116);
  field(octal(size, 12), 124);
  field(octal(0, 12), 136);
  field(" ".repeat(8), 148);
  field(type, 156);
  field("ustar\0", 257);
  field("00", 263);
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** A tar of the files, by their paths, and of the folders, such as logs. */
export function tarOf(files, folders = []) {
  const parts = folders.map((name) => header(`${name}/`, 0, "5"));
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content, "utf8");
    parts.push(header(name, bytes.length, "0"), bytes);
    parts.push(Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The sha256 of bytes, in hex, as sha256sum writes it. */
export function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The pack of the data of a job: the files in a tar, in gzip, in base64, and the
 * sha256 of the gzip, which ask.yml checks before it unpacks.
 */
export function packOf(files, folders = []) {
  const gzip = gzipSync(tarOf(files, folders), { level: 9 });
  return { text: gzip.toString("base64"), sha256: sha256Of(gzip) };
}

/** The outputs of a pack, name1 to nameN, each one chunk, or empty past its end. */
export function chunksOf(name, text, count) {
  const outputs = {};
  for (let index = 0; index < count; index += 1) {
    outputs[`${name}${index + 1}`] = text.slice(
      index * PACK.chunk,
      (index + 1) * PACK.chunk,
    );
  }
  return outputs;
}

/** The outputs of the data of a job, for the job prepare and its smoke tests. */
export function dataOutputs({ text, sha256 }) {
  if (text.length > PACK.data * PACK.chunk) {
    throw new Error(
      `the pack of ${text.length} characters is larger than ${PACK.data} outputs`,
    );
  }
  return { ...chunksOf("pack", text, PACK.data), pack_sha256: sha256 };
}

/**
 * The change of a fix from the outputs of the job of Claude, as ask.yml packs it:
 * its chunks in PATCH1 to PATCH3, the sha256 of the gzip in PATCH_SHA256, and in
 * PATCH_SIZE the characters of the pack, without a sha256 when it was too large to
 * hand over. Returns the patch, or the reason why there is none.
 */
export function patchOf(env) {
  const size = env.PATCH_SIZE ?? "";
  const sha256 = env.PATCH_SHA256 ?? "";
  if (sha256 === "") {
    return {
      error:
        size === ""
          ? "the change didn't come from the job of Claude"
          : `the change is too large to hand over: ${size} characters packed, more than the ${PACK.patch * PACK.chunk} that the outputs of the job of Claude hold`,
    };
  }
  let text = "";
  for (let index = 1; index <= PACK.patch; index += 1) {
    text += env[`PATCH${index}`] ?? "";
  }
  const gzip = Buffer.from(text, "base64");
  if (sha256Of(gzip) !== sha256) {
    return {
      error: `the change didn't arrive whole: ${text.length} of ${size} characters, and its sha256 differs`,
    };
  }
  try {
    return { patch: gunzipSync(gzip) };
  } catch (error) {
    return { error: `the change doesn't unpack: ${error.message}` };
  }
}
