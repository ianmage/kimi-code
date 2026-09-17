import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const CAP_ROUTE_SECTION = 'capRoute';

export const CapRouteConfigSchema = z.object({
  imageRoute: z.string().min(1).optional(),
});

export type CapRouteConfig = z.infer<typeof CapRouteConfigSchema>;

registerConfigSection(CAP_ROUTE_SECTION, CapRouteConfigSchema, {
  defaultValue: {},
});
