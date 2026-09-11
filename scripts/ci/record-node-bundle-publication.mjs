import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const required = [
  "MANIFEST_FILE",
  "BUNDLE_REPOSITORY",
  "BUNDLE_TAG_REF",
  "BUNDLE_DIGEST",
  "ARTIFACT_TYPE",
  "PAYLOAD_MEDIA_TYPE",
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}

const digest = process.env.BUNDLE_DIGEST;
if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
  throw new Error("BUNDLE_DIGEST must be an immutable sha256 digest");
}
const expectedTagPrefix = `${process.env.BUNDLE_REPOSITORY}:bundle-sha-`;
if (!process.env.BUNDLE_TAG_REF.startsWith(expectedTagPrefix)) {
  throw new Error(
    `BUNDLE_TAG_REF must use the deterministic ${expectedTagPrefix}<source-sha> contract`
  );
}

const manifest = JSON.parse(
  readFileSync(process.env.MANIFEST_FILE, "utf8")
);
const expectedTag = `${expectedTagPrefix}${manifest.head_sha}`;
if (process.env.BUNDLE_TAG_REF !== expectedTag) {
  throw new Error(
    `Bundle tag/source mismatch: expected ${expectedTag}, received ${process.env.BUNDLE_TAG_REF}`
  );
}

writeJsonAtomically(process.env.MANIFEST_FILE, {
  ...manifest,
  artifact_bundle: {
    tag_ref: process.env.BUNDLE_TAG_REF,
    digest_ref: `${process.env.BUNDLE_REPOSITORY}@${digest}`,
    artifact_type: process.env.ARTIFACT_TYPE,
    payload_media_type: process.env.PAYLOAD_MEDIA_TYPE,
  },
});

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
