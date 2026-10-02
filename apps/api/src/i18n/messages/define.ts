/** A message is a text with `{placeholders}`, or plural forms chosen by `count`. */
export type Message = string | { zero?: string; one: string; other: string };

/** One area's messages: the Spanish side defines the keys, and the English side must have exactly the same ones. */
export function define<T extends Record<string, Message>>(m: { es: T; en: { [K in keyof T]: Message } }) {
  return m;
}
