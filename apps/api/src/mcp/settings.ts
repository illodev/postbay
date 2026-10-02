import { z } from 'zod';

/**
 * A brand's settings for AI assistants connected over MCP. `allow_approval`: whether an assistant may approve a version or request
 * changes, for the people whose role already can (off by default; an admin turns it on in Settings → Assistants). Everything else an
 * assistant does follows the person's role, as in the web.
 */
export const mcpSettings = z.object({
  allow_approval: z.boolean(),
});
export type McpSettings = z.infer<typeof mcpSettings>;

export const DEFAULT_MCP: McpSettings = { allow_approval: false };

export const mcpOf = (brand: { mcp?: unknown }): McpSettings => ({ ...DEFAULT_MCP, ...((brand.mcp as Partial<McpSettings> | null) ?? {}) });
