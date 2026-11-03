import { z } from 'astro/zod';
export const pilotMetadata=z.object({
 schema:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
 kind:z.enum(['tutorial','how-to','reference','explanation','vision','specification','design']),
 doc_status:z.enum(['draft','review','accepted','deprecated']),
 feature_status:z.enum(['planned','partial','implemented','available','deprecated']),
 verified_release:z.string().min(6).max(128).nullable(),
}).strict().refine(p=>p.feature_status!=='available'||p.verified_release!==null,{message:'Available features need verified_release evidence'});
export const pilotSchema=z.object({pilot:pilotMetadata});
export const frontmatterSchema=z.object({title:z.string().min(1),description:z.string().min(1),pilot:pilotMetadata}).strict();
