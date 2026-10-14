import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new McpServer({ name: 'roots-stdio', version: '0.0.1' });

let listChangedCount = 0;
server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
  listChangedCount += 1;
});

server.registerTool(
  'get_roots',
  {
    description: 'Returns client roots capability, roots/list result, and listChanged count',
    inputSchema: {},
  },
  async () => {
    const capabilities = server.server.getClientCapabilities();
    const roots = capabilities?.roots ? (await server.server.listRoots()).roots : [];
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ capabilities, roots, listChangedCount }),
        },
      ],
    };
  },
);

await server.connect(new StdioServerTransport());