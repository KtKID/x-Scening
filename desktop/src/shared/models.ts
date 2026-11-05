import { z } from 'zod';

export const CatalogModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  image: z.boolean(),
  efforts: z.array(z.string()),
});
export const CatalogProviderSchema = z.object({
  id: z.string().min(1),
  env: z.array(z.string()),
  baseURL: z.string(),
  models: z.array(CatalogModelSchema),
});
export const ModelSelectionSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().optional(),
});
export const ProviderIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const SaveProviderSchema = z.strictObject({
  provider: ProviderIdSchema,
  kind: z.enum(['catalog', 'custom']),
  apiKey: z
    .string()
    .refine((value) => !/[\r\n\0]/.test(value), '密钥应为单行文字。'),
  baseURL: z.union([z.literal(''), z.url()]),
  api: z.string(),
  model: z.string().trim().min(1),
  reasoningEffort: z.string(),
});
export const SavedProviderSchema = z.object({
  provider: ProviderIdSchema,
  kind: z.enum(['catalog', 'custom']),
  credential: z.enum(['saved', 'environment', 'missing']),
  baseURL: z.string(),
  api: z.string(),
  models: z.array(CatalogModelSchema),
});
export const ModelSettingsSchema = z.strictObject({
  catalog: z.array(CatalogProviderSchema),
  protocols: z.array(z.string()),
  saved: z.array(SavedProviderSchema),
  selected: ModelSelectionSchema.nullable(),
});
export const ModelCatalogSchema = ModelSettingsSchema.pick({
  catalog: true,
  protocols: true,
}).extend({
  defaultSelection: ModelSelectionSchema,
  defaultProviders: z.record(z.string(), z.record(z.string(), z.unknown())),
  source: z.string(),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type SaveProvider = z.infer<typeof SaveProviderSchema>;
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
