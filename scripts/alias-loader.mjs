import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const root = resolvePath(import.meta.dirname, "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("~/")) {
    return nextResolve(pathToFileURL(resolvePath(root, specifier.slice(2))).href, context);
  }
  return nextResolve(specifier, context);
}
