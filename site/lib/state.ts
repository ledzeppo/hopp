import { getJson, putJson } from "./store";
import { ApiError } from "./auth";

export type Item = {
  id: string; title: string; published: boolean;
  meta_title?: string; meta_description?: string; image_alt?: string;
};
export type State = { uploads: Record<string, { id: string }>; products: Record<string, Item> };

export const loadState = () => getJson<State>("state", { uploads: {}, products: {} });
export const saveState = (s: State) => putJson("state", s);

export function safeDesign(name: unknown): string {
  const n = String(name ?? "");
  if (!/^[A-Za-z0-9._ -]{1,120}\.png$/i.test(n) || n.includes("..")) throw new ApiError("Bad design name");
  return n;
}
