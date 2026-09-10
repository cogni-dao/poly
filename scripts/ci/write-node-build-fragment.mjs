import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const required = [
  "OUTPUT_FILE",
  "TARGET",
  "ARTIFACT_NAME",
  "IMAGE_NAME",
  "IMAGE_TAG",
  "SOURCE_SHA",
];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`${key} is required`);
  }
}

const imageName = process.env.IMAGE_NAME.toLowerCase();
const imageTag = process.env.IMAGE_TAG;
const sourceSha = process.env.SOURCE_SHA;
const tag = `${imageName}:${imageTag}`;
const digestRef = process.env.DIGEST ? `${imageName}@${process.env.DIGEST}` : "";
if (digestRef && !/^.+@sha256:[0-9a-f]{64}$/.test(digestRef)) {
  throw new Error("DIGEST must be an immutable sha256 digest");
}

const payload = {
  image_name: imageName,
  image_tag: imageTag,
  platform: "linux/amd64",
  ...(digestRef
    ? {
        built_artifact: {
          artifact: process.env.ARTIFACT_NAME,
          sourceSha,
          image: digestRef,
        },
      }
    : {}),
  targets: [
    {
      target: process.env.TARGET,
      source_repo: `https://github.com/${process.env.REPOSITORY ?? ""}`,
      sourceSha,
      image_repository: imageName,
      tag,
      digest: digestRef,
      source_sha: sourceSha,
    },
  ],
};

mkdirSync(dirname(process.env.OUTPUT_FILE), { recursive: true });
writeFileSync(process.env.OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
